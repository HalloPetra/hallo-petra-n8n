import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { petraApiRequest } from '../shared/GenericFunctions';

// Backoff factor for the wait before the next delivery attempt: 1, 2, 3, 5, 8, ...
function fibonacciBackoff(attempt: number): number {
	let current = 1;
	let next = 2;
	for (let i = 1; i < attempt; i++) {
		[current, next] = [next, current + next];
	}
	return current;
}

export class PetraEventRetry implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Retry on Next Poll',
		name: 'petraEventRetry',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '=max. {{$parameter["maxAttempts"]}} attempts',
		description:
			'Marks a HalloPetra event for redelivery, so the Petra Events trigger picks it up again on the next poll. Connect this node to the error path of your workflow; its outputs are optional and only needed for custom dead-letter handling.',
		defaults: {
			name: 'Petra Retry on Next Poll',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],
		outputNames: ['Retry Scheduled', 'Given Up'],
		credentials: [
			{
				name: 'petraApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event ID',
				name: 'eventId',
				type: 'string',
				default: '={{ $json._petra.eventId }}',
				required: true,
				description:
					'ID of the HalloPetra event to retry. Defaults to the metadata the Petra Events trigger attaches to every item.',
			},
			{
				displayName: 'Max Attempts',
				name: 'maxAttempts',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 5,
				description:
					'Maximum number of delivery attempts per event, including the first one. Events whose failed attempt already reached this number go to the "Given Up" output instead of being redelivered.',
			},
			{
				displayName: 'Backoff Base (Seconds)',
				name: 'backoffSeconds',
				type: 'number',
				typeOptions: {
					minValue: 0,
				},
				default: 60,
				description:
					'Base wait before an event is redelivered. The actual wait grows with each failed attempt following the Fibonacci sequence: base × 1, 2, 3, 5, 8, … Set to 0 to redeliver on the next poll every time.',
			},
			{
				displayName: 'Report Failure to HalloPetra',
				name: 'reportFailure',
				type: 'boolean',
				default: true,
				description:
					'Whether to report an event to HalloPetra when it is given up (Max Attempts reached), so the failure can be shown to the user in the HalloPetra app',
			},
			{
				displayName: 'Failure Reason',
				name: 'failureReason',
				type: 'string',
				displayOptions: {
					show: {
						reportFailure: [true],
					},
				},
				default: '={{ $json.error ? ($json.error.message || $json.error) : "" }}',
				description:
					'Reason sent along with the failure report. Defaults to the error message n8n attaches to items on the error path.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		const retryScheduled: INodeExecutionData[] = [];
		const givenUp: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item = items[itemIndex];
			const eventId = this.getNodeParameter('eventId', itemIndex) as string;
			const maxAttempts = this.getNodeParameter('maxAttempts', itemIndex) as number;
			// Attempt number of the delivery that just failed, attached by the Petra Events trigger
			const metadata = item.json._petra as { attempt?: number } | undefined;
			const attempt = metadata?.attempt ?? 1;

			if (!eventId) {
				const error = new NodeOperationError(this.getNode(), 'Item has no Petra event ID', {
					itemIndex,
					description:
						'Expected the event ID in "_petra.eventId" (attached by the Petra Events trigger) or via the "Event ID" parameter',
				});
				if (this.continueOnFail()) {
					givenUp.push({ json: item.json, error, pairedItem: itemIndex });
					continue;
				}
				throw error;
			}

			if (attempt >= maxAttempts) {
				const reportFailure = this.getNodeParameter('reportFailure', itemIndex) as boolean;
				if (reportFailure) {
					const failureReason = this.getNodeParameter('failureReason', itemIndex, '') as string;
					await petraApiRequest.call(this, 'POST', `/events/${eventId}/failed`, {
						attempts: attempt,
						...(failureReason ? { reason: failureReason } : {}),
					});
				}
				givenUp.push({ json: item.json, pairedItem: itemIndex });
				continue;
			}

			const backoffSeconds = this.getNodeParameter('backoffSeconds', itemIndex) as number;
			await petraApiRequest.call(this, 'POST', `/events/${eventId}/redeliver`, {
				attempt: attempt + 1,
				delaySeconds: backoffSeconds * fibonacciBackoff(attempt),
			});
			retryScheduled.push({ json: item.json, pairedItem: itemIndex });
		}

		return [retryScheduled, givenUp];
	}
}
