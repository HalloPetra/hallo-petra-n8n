import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IPollFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import { version as packageVersion } from '../../package.json';

export const USER_AGENT = `n8n-nodes-petra/${packageVersion}`;

export type PetraApiContext =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IPollFunctions
	| IWebhookFunctions;

export interface PetraEvent {
	id: string;
	type: string;
	occurredAt: string;
	payload: IDataObject;
}

export interface PetraRetryEntry {
	attempts: number;
	firstSeen: string;
}

export interface PetraEventsState {
	cursor?: string;
	retry?: Record<string, PetraRetryEntry>;
}

// Key inside the workflow's global static data. Global scope (not 'node') because
// the events trigger and the retry node must share this state.
const EVENTS_STATE_KEY = 'petraEvents';

export function getPetraEventsState(staticData: IDataObject): PetraEventsState {
	if (typeof staticData[EVENTS_STATE_KEY] !== 'object' || staticData[EVENTS_STATE_KEY] === null) {
		staticData[EVENTS_STATE_KEY] = {};
	}
	return staticData[EVENTS_STATE_KEY] as PetraEventsState;
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

export async function petraApiRequest(
	this: PetraApiContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('petraApi');
	const baseUrl = ((credentials.baseUrl as string) ?? '').replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${endpoint}`,
		headers: {
			'User-Agent': USER_AGENT,
			Accept: 'application/json',
		},
		json: true,
	};
	if (body && Object.keys(body).length) {
		options.body = body;
	}
	if (qs && Object.keys(qs).length) {
		options.qs = qs;
	}

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'petraApi',
			options,
		)) as IDataObject;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

// Both type listing endpoints return { types: [{ slug, label, description? }] }.
export async function loadPetraTypes(
	this: ILoadOptionsFunctions,
	endpoint: '/webhook-types' | '/event-types',
): Promise<INodePropertyOptions[]> {
	const response = await petraApiRequest.call(this, 'GET', endpoint);
	const types = (response.types ?? []) as Array<{
		slug: string;
		label?: string;
		description?: string;
	}>;
	return types.map((type) => ({
		name: type.label ?? type.slug,
		value: type.slug,
		description: type.description,
	}));
}
