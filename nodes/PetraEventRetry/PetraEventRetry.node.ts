import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { getPetraEventsState } from '../shared/GenericFunctions';

export class PetraEventRetry implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Event Retry',
		name: 'petraEventRetry',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '=max. {{$parameter["maxAttempts"]}} attempts',
		description:
			'Marks a HalloPetra event as failed so the Petra Events trigger delivers it again on the next poll. Connect this node to the error path of your workflow. Retries only work in active (production) workflows — the marking must be persisted, so the execution has to finish successfully after this node ran.',
		defaults: {
			name: 'Petra Event Retry',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],
		outputNames: ['Retry Scheduled', 'Given Up'],
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
					'Maximum number of delivery attempts per event, including the first one. Events whose failed attempt already reached this number go to the "Given Up" output instead of being retried.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const state = getPetraEventsState(this.getWorkflowStaticData('global'));
		if (state.retry === undefined) {
			state.retry = {};
		}
		const retrySet = state.retry;

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
				givenUp.push({ json: item.json, pairedItem: itemIndex });
				continue;
			}

			retrySet[eventId] = {
				attempts: attempt,
				firstSeen: retrySet[eventId]?.firstSeen ?? new Date().toISOString(),
			};
			retryScheduled.push({ json: item.json, pairedItem: itemIndex });
		}

		return [retryScheduled, givenUp];
	}
}
