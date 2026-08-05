import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { loadPetraTypes, petraApiRequest, type PetraEvent } from '../shared/GenericFunctions';

function toItem(event: PetraEvent): INodeExecutionData {
	return {
		json: {
			...event,
			_petra: {
				eventId: event.id,
				attempt: event.attempt ?? 1,
			},
		} as unknown as IDataObject,
	};
}

export class PetraEventsTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Events Trigger',
		name: 'petraEventsTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		polling: true,
		usableAsTool: true,
		subtitle: '={{$parameter["eventTypes"].length ? $parameter["eventTypes"].join(", ") : "all events"}}',
		description:
			'Starts the workflow for new HalloPetra events (e.g. finished calls). Polls the HalloPetra event feed; events that a "Petra Event Retry" node marked as failed are redelivered through the feed.',
		defaults: {
			name: 'Petra Events Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'petraApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event Type Names or IDs',
				name: 'eventTypes',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getEventTypes',
				},
				default: [],
				description:
					'Only trigger for these event types. Leave empty for all. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 50,
				description: 'Max number of results to return',
			},
		],
	};

	methods = {
		loadOptions: {
			async getEventTypes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadPetraTypes.call(this, '/event-types');
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const limit = this.getNodeParameter('limit', 50) as number;
		const eventTypes = this.getNodeParameter('eventTypes', []) as string[];

		const feedQuery: IDataObject = { limit };
		if (eventTypes.length) {
			feedQuery.types = eventTypes.join(',');
		}

		// In manual mode ("Fetch Test Event") static data is not persisted, so poll
		// the latest events without touching the cursor.
		if (this.getMode() === 'manual') {
			const response = await petraApiRequest.call(this, 'GET', '/events', undefined, {
				...feedQuery,
				limit: Math.min(limit, 10),
			});
			const events = (response.events ?? []) as PetraEvent[];
			if (!events.length) {
				return null;
			}
			return [events.map(toItem)];
		}

		// The cursor is the only client-side state and is written exclusively by
		// this poll function (single writer). Retries do not touch it: the Petra
		// Event Retry node asks the API to redeliver, so failed events simply
		// reappear in the feed behind the cursor.
		const staticData = this.getWorkflowStaticData('node');
		if (staticData.cursor) {
			feedQuery.after = staticData.cursor;
		}

		const response = await petraApiRequest.call(this, 'GET', '/events', undefined, feedQuery);
		const events = (response.events ?? []) as PetraEvent[];
		if (response.nextCursor) {
			staticData.cursor = response.nextCursor as string;
		}

		if (!events.length) {
			return null;
		}
		return [events.map(toItem)];
	}
}
