import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
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
	| IWebhookFunctions;

export async function petraApiRequest(
	this: PetraApiContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('petraApi');
	// The API version belongs to the contract this package implements, not to
	// the user's configuration — a build speaks v1 or it does not work at all.
	const baseUrl = ((credentials.baseUrl as string) ?? '').replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}/v1${endpoint}`,
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
		const envelope = errorEnvelope(error);
		if (!envelope) {
			throw new NodeApiError(this.getNode(), error as JsonObject);
		}
		// The envelope carries the only thing that identifies this call in
		// HalloPetra's own logs. Losing it turns every server-side fault into
		// guesswork, so it goes into the message the user actually sees.
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: `HalloPetra: ${envelope.message ?? envelope.code ?? 'request failed'}`,
			description: envelope.requestId
				? `${envelope.code ?? 'ERROR'} · request ID ${envelope.requestId} — quote it when asking HalloPetra support to look this up.`
				: (envelope.code as string | undefined),
		});
	}
}

interface PetraErrorEnvelope {
	code?: string;
	message?: string;
	requestId?: string;
}

/**
 * Every HalloPetra error is `{ error: { code, message, requestId } }`. Where n8n
 * parks the parsed body depends on how the request failed, so all the known
 * spots are checked rather than the one that happened to work first.
 */
function errorEnvelope(error: unknown): PetraErrorEnvelope | undefined {
	const candidates = [
		(error as { response?: { body?: unknown } })?.response?.body,
		(error as { cause?: { error?: unknown } })?.cause?.error,
		(error as { cause?: unknown })?.cause,
		(error as { error?: unknown })?.error,
	];
	for (const candidate of candidates) {
		const envelope = (candidate as { error?: PetraErrorEnvelope })?.error;
		if (envelope && (envelope.requestId || envelope.code || envelope.message)) {
			return envelope;
		}
	}
	return undefined;
}

/**
 * The list endpoints page their rows as `{ items, totalCount, nextCursor? }`.
 * A picker has no place for "load more", so all pages are fetched — capped, in
 * case a misbehaving server keeps handing out cursors.
 */
async function loadPagedOptions(
	context: ILoadOptionsFunctions,
	endpoint: string,
	disabledHint: string,
): Promise<INodePropertyOptions[]> {
	const options: INodePropertyOptions[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const response = await petraApiRequest.call(context, 'GET', endpoint, undefined, {
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		const items = Array.isArray(response.items) ? (response.items as IDataObject[]) : [];
		for (const item of items) {
			options.push({
				name: (item.name as string) || (item.id as string),
				value: item.id as string,
				description: item.status === 'disabled' ? disabledHint : undefined,
			});
		}
		cursor = response.nextCursor as string | undefined;
	} while (cursor && ++pages < 50);
	return options;
}

/**
 * The company's call flows — where a `call.tool` attaches itself, and what a
 * `call.finished` webhook can be scoped to. Disabled ones stay listed: the API
 * accepts them, and the webhook starts firing as soon as the operator
 * re-enables the flow.
 */
export async function loadCallFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await loadPagedOptions(
		this,
		'/call-flows',
		'Currently disabled — this webhook starts firing once the call flow is switched back on',
	);
}

/** The company's forms, for scoping a `form.submitted` webhook. */
export async function loadForms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await loadPagedOptions(
		this,
		'/forms',
		'Currently inactive — this webhook starts firing once the form is switched back on',
	);
}
