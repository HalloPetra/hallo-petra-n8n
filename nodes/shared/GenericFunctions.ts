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
	// A trailing `/v1` is tolerated anyway: earlier versions asked for it, and
	// the resulting `/v1/v1` would be a 404 nobody enjoys tracking down.
	const baseUrl = ((credentials.baseUrl as string) ?? '')
		.replace(/\/+$/, '')
		.replace(/\/v1$/, '');

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
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

/**
 * The list endpoints wrap their rows in a named key (`{ ablaeufe: [...] }`).
 * Tolerating `items` and a bare array as well keeps a picker working if a newer
 * endpoint settles on a different wrapper.
 */
function rows(response: IDataObject, key: string): IDataObject[] {
	if (Array.isArray(response)) return response as IDataObject[];
	const list = response[key] ?? response.items ?? [];
	return Array.isArray(list) ? (list as IDataObject[]) : [];
}

/**
 * The company's Abläufe — where a `call.tool` attaches itself, and what a
 * `call.finished` webhook can be scoped to. Disabled ones stay listed: the API
 * accepts them, and the webhook starts firing as soon as the operator
 * re-enables the Ablauf.
 */
export async function loadAblaeufe(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const response = await petraApiRequest.call(this, 'GET', '/ablaeufe');
	return rows(response, 'ablaeufe').map((ablauf) => ({
		name: (ablauf.title as string) || (ablauf.id as string),
		value: ablauf.id as string,
		description:
			ablauf.status === 'disabled'
				? 'Currently disabled — this webhook starts firing once the Ablauf is switched back on'
				: undefined,
	}));
}

/** The company's forms, for scoping a `form.submitted` webhook. */
export async function loadFormulare(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const response = await petraApiRequest.call(this, 'GET', '/formulare');
	return rows(response, 'formulare').map((formular) => ({
		name: (formular.title as string) || (formular.id as string),
		value: formular.id as string,
		description:
			formular.status === 'disabled'
				? 'Currently inactive — this webhook starts firing once the form is switched back on'
				: undefined,
	}));
}
