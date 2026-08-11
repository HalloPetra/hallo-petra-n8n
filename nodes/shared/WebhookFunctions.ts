import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { petraApiRequest } from './GenericFunctions';

/**
 * What `POST /webhooks` registers. For three of the four events `name` and
 * `description` are just the operator's label in the HalloPetra dashboard, and
 * every trigger derives them from the workflow. `call.tool` is the exception:
 * there the registration defines the tool itself, so that trigger overrides
 * both with what the user wrote and adds `parameters`.
 */
export interface PetraWebhookRegistration {
	event: string;
	url: string;
	name: string;
	description: string;
	/**
	 * Narrows an event to a subset, e.g. `ablauf_ids` for `call.finished`.
	 * Omitted or empty means company-wide — except for `call.tool`, where the
	 * API requires at least one Ablauf to attach the tool to.
	 */
	scope?: PetraWebhookScope;
	/** `call.tool` only: the arguments Petra fills from the conversation. */
	parameters?: PetraToolParameter[];
}

export interface PetraWebhookScope {
	/** The field name the API expects, e.g. `ablauf_ids`. */
	field: string;
	ids: string[];
}

export interface PetraToolParameter {
	key: string;
	label?: string;
	description?: string;
}

/**
 * The label the operator sees in the HalloPetra dashboard. Carries the node
 * name as well as the workflow's, because one workflow can register several
 * webhooks and a list of identical rows helps nobody.
 */
export function dashboardName(context: IHookFunctions): string {
	return `n8n: ${context.getWorkflow().name ?? 'workflow'} · ${context.getNode().name}`;
}

/** The registration body for a trigger that subscribes to exactly one event. */
export function petraRegistration(
	context: IHookFunctions,
	event: string,
	overrides: Partial<Omit<PetraWebhookRegistration, 'event' | 'url'>> = {},
): PetraWebhookRegistration {
	return {
		event,
		url: context.getNodeWebhookUrl('default') as string,
		name: dashboardName(context),
		description: 'Registered by n8n (n8n-nodes-hallopetra)',
		...overrides,
	};
}

/** True when the node is configured to leave registration to the operator. */
function isManual(context: IHookFunctions): boolean {
	return (context.getNodeParameter('registration', 'automatic') as string) === 'manual';
}

/** Order-insensitive comparison of a scope against what the API reports. */
function sameIds(reported: unknown, wanted: string[]): boolean {
	const actual = Array.isArray(reported) ? [...(reported as string[])].sort() : [];
	const expected = [...wanted].sort();
	return actual.length === expected.length && actual.every((id, i) => id === expected[i]);
}

/**
 * Order-insensitive comparison of the declared tool parameters. Keys are unique
 * per registration, so keying by them is enough; label and description are
 * compared too, because both are what Petra reads when filling an argument.
 */
function sameParameters(reported: unknown, wanted: PetraToolParameter[]): boolean {
	const actual = Array.isArray(reported) ? (reported as PetraToolParameter[]) : [];
	if (actual.length !== wanted.length) {
		return false;
	}
	const byKey = new Map(actual.map((parameter) => [parameter.key, parameter]));
	return wanted.every((parameter) => {
		const match = byKey.get(parameter.key);
		return (
			match !== undefined &&
			(match.label ?? '') === (parameter.label ?? '') &&
			(match.description ?? '') === (parameter.description ?? '')
		);
	});
}

/**
 * Is the stored registration still the one we want? Re-registers on any drift
 * in what HalloPetra delivers to or shows about this workflow.
 */
export async function checkPetraWebhook(
	this: IHookFunctions,
	registration: PetraWebhookRegistration,
): Promise<boolean> {
	if (isManual(this)) {
		return true;
	}
	const staticData = this.getWorkflowStaticData('node');
	if (!staticData.webhookId) {
		return false;
	}

	try {
		// GET /webhooks/{id} returns the webhook itself, not a wrapper object
		const webhook = await petraApiRequest.call(this, 'GET', `/webhooks/${staticData.webhookId}`);
		// The event is immutable server-side and a node only ever registers one, so
		// a mismatch is only checked when the API actually reports an event.
		const eventMatches = !webhook.event || webhook.event === registration.event;
		// The scope is not patchable either — a changed selection means re-registering.
		const scopeMatches =
			!registration.scope || sameIds(webhook[registration.scope.field], registration.scope.ids);
		// The tool parameters are explicitly immutable server-side.
		const parametersMatch =
			!registration.parameters || sameParameters(webhook.parameters, registration.parameters);
		const matches =
			webhook.url === registration.url &&
			eventMatches &&
			scopeMatches &&
			parametersMatch &&
			webhook.name === registration.name &&
			webhook.description === registration.description;
		if (matches) {
			// The secret is retrievable, so a registration whose secret got lost
			// (e.g. a workflow imported without its static data) can be repaired
			// instead of silently falling back to unverified deliveries.
			if (!staticData.webhookSecret) {
				const secretResponse = await petraApiRequest.call(
					this,
					'GET',
					`/webhooks/${staticData.webhookId}/secret`,
				);
				staticData.webhookSecret = secretResponse.secret;
			}
			return true;
		}
		// URL, scope, name or description changed since registration — start over
		await petraApiRequest.call(this, 'DELETE', `/webhooks/${staticData.webhookId}`);
	} catch (error) {
		// Webhook is unknown to HalloPetra (deleted remotely or never created)
		this.logger.warn(
			`Petra webhook ${staticData.webhookId as string} could not be verified, re-registering: ${(error as Error).message}`,
		);
	}

	delete staticData.webhookId;
	delete staticData.webhookSecret;
	return false;
}

/** Register with HalloPetra and remember the id and signing secret. */
export async function createPetraWebhook(
	this: IHookFunctions,
	registration: PetraWebhookRegistration,
): Promise<boolean> {
	if (isManual(this)) {
		// The user configures the webhook URL in the HalloPetra app themselves
		return true;
	}

	const body: IDataObject = {
		event: registration.event,
		url: registration.url,
		name: registration.name,
		description: registration.description,
	};
	// An empty selection is company-wide, and the API rejects an empty array.
	if (registration.scope?.ids.length) {
		body[registration.scope.field] = registration.scope.ids;
	}
	if (registration.parameters?.length) {
		body.parameters = registration.parameters;
	}

	let response;
	try {
		response = await petraApiRequest.call(this, 'POST', '/webhooks', body);
	} catch (error) {
		const httpCode = (error as { httpCode?: string }).httpCode;
		throw new NodeOperationError(
			this.getNode(),
			`Could not register the webhook with HalloPetra (POST /webhooks failed${httpCode ? ` with status ${httpCode}` : ''})`,
			{
				description:
					httpCode === '404'
						? 'The HalloPetra API at the configured base URL has no webhook registration endpoint (yet). Check that the credential points to an environment that supports webhook registration.'
						: httpCode === '400'
							? `HalloPetra rejected a registration for "${registration.event}". Either the API at the configured base URL does not know this event yet, or a selected entry no longer exists — reopen the selection in this node and publish again.`
							: 'Check the API key and base URL in the Petra API credential.',
			},
		);
	}

	const webhook = (response.webhook ?? {}) as IDataObject;
	if (!webhook.id) {
		throw new NodeOperationError(this.getNode(), 'The HalloPetra API did not return a webhook ID');
	}

	const staticData = this.getWorkflowStaticData('node');
	staticData.webhookId = webhook.id;
	staticData.webhookSecret = response.secret;
	return true;
}

/** Deregister on deactivation. Never blocks — the row may already be gone. */
export async function deletePetraWebhook(this: IHookFunctions): Promise<boolean> {
	if (isManual(this)) {
		return true;
	}
	const staticData = this.getWorkflowStaticData('node');
	if (staticData.webhookId) {
		try {
			await petraApiRequest.call(this, 'DELETE', `/webhooks/${staticData.webhookId}`);
		} catch (error) {
			// Do not block deactivation — the registration may already be gone remotely
			this.logger.warn(
				`Could not deregister Petra webhook ${staticData.webhookId as string}: ${(error as Error).message}`,
			);
		}
		delete staticData.webhookId;
		delete staticData.webhookSecret;
	}
	return true;
}

/**
 * Verify the delivery and hand its body to the workflow.
 *
 * HalloPetra signs deliveries Stripe-style:
 * `t=<unixSeconds>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>">`. Only verified when
 * a secret exists, i.e. the webhook was registered through the API.
 */
export async function receivePetraWebhook(
	this: IWebhookFunctions,
): Promise<IWebhookResponseData> {
	const staticData = this.getWorkflowStaticData('node');
	const secret = staticData.webhookSecret as string | undefined;

	if (secret) {
		const header = (this.getHeaderData()['x-hallopetra-signature'] as string | undefined) ?? '';
		// n8n runtime boundary: express.Request is augmented by n8n with the captured raw body,
		// which the public typings do not expose. The HMAC is computed over these exact bytes —
		// without them, verification is impossible, so fail loudly instead of a misleading 401.
		const rawBodyBuffer = (this.getRequestObject() as unknown as { rawBody?: Buffer }).rawBody;
		if (!rawBodyBuffer) {
			this.logger.error(
				'Petra webhook: raw request body is unavailable on this n8n instance — cannot verify the HalloPetra signature',
			);
			const response = this.getResponseObject();
			response
				.status(500)
				.json({ message: 'Cannot verify signature: raw request body unavailable' });
			return { noWebhookResponse: true };
		}
		const rawBody = rawBodyBuffer.toString('utf8');

		let isValid = false;
		const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
		if (match) {
			const timestamp = Number.parseInt(match[1], 10);
			const toleranceSeconds = 300;
			if (Math.abs(Date.now() / 1000 - timestamp) <= toleranceSeconds) {
				const expected = Buffer.from(
					createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'),
					'utf8',
				);
				const provided = Buffer.from(match[2], 'utf8');
				isValid = expected.length === provided.length && timingSafeEqual(expected, provided);
			}
		}

		if (!isValid) {
			const response = this.getResponseObject();
			response.status(401).json({ message: 'Invalid signature' });
			return { noWebhookResponse: true };
		}
	}

	return {
		workflowData: [this.helpers.returnJsonArray(this.getBodyData())],
	};
}
