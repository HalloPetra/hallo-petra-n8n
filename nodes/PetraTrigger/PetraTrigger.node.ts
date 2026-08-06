import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { loadPetraTypes, petraApiRequest } from '../shared/GenericFunctions';

export class PetraTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Webhook Trigger',
		name: 'petraTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["hookType"]}}',
		description:
			'Starts the workflow when HalloPetra calls the registered webhook, e.g. right before a phone call. The webhook is registered automatically with HalloPetra when the workflow is activated.',
		defaults: {
			name: 'Petra Webhook Trigger',
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
				displayName: 'Hook Type Name or ID',
				name: 'hookType',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getHookTypes',
				},
				required: true,
				default: '',
				description:
					'Which synchronous HalloPetra hook this workflow handles, e.g. "call.incoming". Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
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
						name: 'Using Petra Finish Node',
						value: 'responseNode',
						description: 'The response is sent by a "Petra Finish" node in this workflow',
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

	methods = {
		loadOptions: {
			async getHookTypes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadPetraTypes.call(this, 'sync');
			},
		},
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
				const hookType = this.getNodeParameter('hookType') as string;
				try {
					const response = await petraApiRequest.call(
						this,
						'GET',
						`/webhook-subscriptions/${staticData.webhookId}`,
					);
					const subscription = (response.subscription ?? response) as IDataObject;
					if (subscription.url === webhookUrl && subscription.event === hookType) {
						return true;
					}
					// URL or hook type changed since registration — re-register from scratch
					await petraApiRequest.call(
						this,
						'DELETE',
						`/webhook-subscriptions/${staticData.webhookId}`,
					);
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
				const hookType = this.getNodeParameter('hookType') as string;

				let response;
				try {
					response = await petraApiRequest.call(this, 'POST', '/webhook-subscriptions', {
						event: hookType,
						url: webhookUrl,
						description: 'Registered by n8n (n8n-nodes-petra)',
					});
				} catch (error) {
					const httpCode = (error as { httpCode?: string }).httpCode;
					throw new NodeOperationError(
						this.getNode(),
						`Could not register the webhook with HalloPetra (POST /webhook-subscriptions failed${httpCode ? ` with status ${httpCode}` : ''})`,
						{
							description:
								httpCode === '404'
									? 'The HalloPetra API at the configured base URL has no webhook registration endpoint (yet). Check that the credential points to an environment that supports webhook registration.'
									: 'Check the API key and base URL in the Petra API credential.',
						},
					);
				}

				const subscription = (response.subscription ?? {}) as IDataObject;
				if (!subscription.id) {
					throw new NodeOperationError(
						this.getNode(),
						'The HalloPetra API did not return a subscription ID',
					);
				}

				const staticData = this.getWorkflowStaticData('node');
				staticData.webhookId = subscription.id;
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
						await petraApiRequest.call(
							this,
							'DELETE',
							`/webhook-subscriptions/${staticData.webhookId}`,
						);
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
