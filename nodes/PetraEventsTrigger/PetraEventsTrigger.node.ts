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

import {
	chunk,
	getPetraEventsState,
	loadPetraTypes,
	petraApiRequest,
	type PetraEvent,
} from '../shared/GenericFunctions';

const RETRY_FETCH_CHUNK_SIZE = 50;

function toItem(event: PetraEvent, attempt: number): INodeExecutionData {
	return {
		json: {
			...event,
			_petra: {
				eventId: event.id,
				attempt,
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
			'Starts the workflow for new HalloPetra events (e.g. finished calls). Polls the HalloPetra event feed and re-delivers events that a "Petra Event Retry" node marked as failed.',
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
		// the latest events without touching cursor or retry state.
		if (this.getMode() === 'manual') {
			const response = await petraApiRequest.call(this, 'GET', '/events', undefined, {
				...feedQuery,
				limit: Math.min(limit, 10),
			});
			const events = (response.events ?? []) as PetraEvent[];
			if (!events.length) {
				return null;
			}
			return [events.map((event) => toItem(event, 1))];
		}

		const state = getPetraEventsState(this.getWorkflowStaticData('global'));
		const retrySet = state.retry ?? {};
		const retryIds = Object.keys(retrySet);

		// Re-fetch events that a Petra Event Retry node marked as failed
		const retryEvents: PetraEvent[] = [];
		for (const ids of chunk(retryIds, RETRY_FETCH_CHUNK_SIZE)) {
			const response = await petraApiRequest.call(this, 'GET', '/events', undefined, {
				ids: ids.join(','),
			});
			retryEvents.push(...((response.events ?? []) as PetraEvent[]));
		}

		if (state.cursor) {
			feedQuery.after = state.cursor;
		}
		const feedResponse = await petraApiRequest.call(this, 'GET', '/events', undefined, feedQuery);
		const feedEvents = (feedResponse.events ?? []) as PetraEvent[];
		if (feedResponse.nextCursor) {
			state.cursor = feedResponse.nextCursor as string;
		}

		const items: INodeExecutionData[] = [];
		const emittedIds = new Set<string>();
		for (const event of retryEvents) {
			const attempt = (retrySet[event.id]?.attempts ?? 0) + 1;
			items.push(toItem(event, attempt));
			emittedIds.add(event.id);
		}
		for (const event of feedEvents) {
			if (emittedIds.has(event.id)) {
				continue;
			}
			items.push(toItem(event, 1));
			emittedIds.add(event.id);
		}

		// All retry entries were either emitted again or could not be fetched anymore
		// (e.g. past retention) — clear them so the set cannot grow without bounds.
		// The retry node re-adds any event that fails again.
		for (const id of retryIds) {
			if (!emittedIds.has(id)) {
				this.logger.warn(`Petra event ${id} is no longer available in the feed, dropping retry`);
			}
			delete retrySet[id];
		}
		state.retry = retrySet;

		if (!items.length) {
			return null;
		}
		return [items];
	}
}
