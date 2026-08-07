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

export const USER_AGENT = `n8n-nodes-hallopetra/${packageVersion}`;

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
	/** Delivery attempt, starts at 1; incremented by the redeliver endpoint */
	attempt?: number;
	payload: IDataObject;
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

// GET /events/types returns one unified list: { types: [{ name, mode: 'sync' | 'async', description? }] }.
// Only the async ones are pickable here — they are what the feed carries. The sync deliveries are
// webhooks, and each has its own trigger node that registers for exactly one integration point.
export async function loadFeedEventTypes(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const response = await petraApiRequest.call(this, 'GET', '/events/types');
	const types = (response.types ?? []) as Array<{
		name: string;
		mode?: string;
		description?: string;
	}>;
	return types
		.filter((type) => type.mode === 'async')
		.map((type) => ({
			name: type.name,
			value: type.name,
			description: type.description,
		}));
}
