import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { petraApiRequest } from '../shared/GenericFunctions';

/** The integration point this trigger registers for — see POST /webhooks. */
const WEBHOOK_TYPE = 'call.incoming';

export class PetraTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Incoming Call Trigger',
		name: 'petraTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: 'before Petra answers',
		description:
			'Starts the workflow while the phone is still ringing, before Petra takes the call — look up who is calling so Petra can greet them by name. Registers itself with HalloPetra when the workflow is published. The call data arrives as { webhook_id, event, data: { call_id, calling_phone_number, inbound_phone_number, start_time, contact, fields } }. Petra waits at most 2.5 seconds for the answer, so keep this workflow to a single lookup.',
		defaults: {
			name: 'Petra Incoming Call Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'petraApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: '={{$parameter["responseMode"]}}',
				responseData: '={{$parameter["responseData"]}}',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Registration',
				name: 'registration',
				type: 'options',
				options: [
					{
						name: 'Automatic (via HalloPetra API)',
						value: 'automatic',
						description:
							'Register the webhook automatically with HalloPetra when the workflow is published. Incoming calls are verified via HMAC signature.',
					},
					{
						name: 'Manual (Copy URL to HalloPetra)',
						value: 'manual',
						description:
							'Do not call the HalloPetra API. Copy the production webhook URL from this trigger and configure it in the HalloPetra app yourself. Incoming calls are not signature-checked.',
					},
				],
				default: 'automatic',
				description: 'How the webhook becomes known to HalloPetra',
			},
			{
				displayName: 'Respond',
				name: 'responseMode',
				type: 'options',
				options: [
					{
						name: 'Using Reply to Petra Node',
						value: 'responseNode',
						description: 'The response is sent by a "Reply to Petra" node in this workflow',
					},
					{
						name: 'When Last Node Finishes',
						value: 'lastNode',
						description: 'The response contains data of the last-executed node',
					},
					{
						name: 'Immediately',
						value: 'onReceived',
						description: 'Respond as soon as the webhook is received, without waiting for the workflow',
					},
				],
				default: 'responseNode',
				description: 'When and how to respond to HalloPetra',
			},
			{
				displayName: 'Response Data',
				name: 'responseData',
				type: 'options',
				displayOptions: {
					show: {
						responseMode: ['lastNode'],
					},
				},
				options: [
					{
						name: 'First Entry JSON',
						value: 'firstEntryJson',
						description: 'Returns the JSON data of the first entry of the last node',
					},
					{
						name: 'All Entries',
						value: 'allEntries',
						description: 'Returns all entries of the last node',
					},
					{
						name: 'No Response Body',
						value: 'noData',
						description: 'Returns without a body',
					},
				],
				default: 'firstEntryJson',
				description: 'What data should be returned when responding with the last node',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('registration', 'automatic') as string) === 'manual') {
					return true;
				}
				const staticData = this.getWorkflowStaticData('node');
				if (!staticData.webhookId) {
					return false;
				}

				const webhookUrl = this.getNodeWebhookUrl('default');
				try {
					// GET /webhooks/{id} returns the webhook itself, not a wrapper object
					const webhook = await petraApiRequest.call(
						this,
						'GET',
						`/webhooks/${staticData.webhookId}`,
					);
					// The type is immutable server-side and this node only ever registers one,
					// so a mismatch is only checked when the API actually reports a type.
					const typeMatches = !webhook.type || webhook.type === WEBHOOK_TYPE;
					if (webhook.url === webhookUrl && typeMatches) {
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
					// URL changed since registration — re-register from scratch
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
			},

			async create(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('registration', 'automatic') as string) === 'manual') {
					// The user configures the webhook URL in the HalloPetra app themselves
					return true;
				}
				const webhookUrl = this.getNodeWebhookUrl('default');

				let response;
				try {
					response = await petraApiRequest.call(this, 'POST', '/webhooks', {
						type: WEBHOOK_TYPE,
						url: webhookUrl,
						// Shown in the operator's HalloPetra dashboard — name it after the
						// workflow so a registration can be traced back to what created it.
						name: `n8n: ${this.getWorkflow().name ?? 'workflow'}`,
						description: 'Registered by n8n (n8n-nodes-hallopetra)',
					});
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
										? `HalloPetra rejected the registration of type "${WEBHOOK_TYPE}". The API at the configured base URL may predate the webhook type contract — this node requires an environment that accepts "type" on POST /webhooks.`
										: 'Check the API key and base URL in the Petra API credential.',
						},
					);
				}

				const webhook = (response.webhook ?? {}) as IDataObject;
				if (!webhook.id) {
					throw new NodeOperationError(
						this.getNode(),
						'The HalloPetra API did not return a webhook ID',
					);
				}

				const staticData = this.getWorkflowStaticData('node');
				staticData.webhookId = webhook.id;
				staticData.webhookSecret = response.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('registration', 'automatic') as string) === 'manual') {
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
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const staticData = this.getWorkflowStaticData('node');
		const secret = staticData.webhookSecret as string | undefined;

		// HalloPetra signs deliveries Stripe-style: `t=<unixSeconds>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>">`.
		// Only verified when a secret exists, i.e. the webhook was registered via the API.
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
}
