import { createHmac, timingSafeEqual } from 'crypto';
import type {
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
				const staticData = this.getWorkflowStaticData('node');
				if (!staticData.webhookId) {
					return false;
				}

				const webhookUrl = this.getNodeWebhookUrl('default');
				const hookType = this.getNodeParameter('hookType') as string;
				try {
					const webhook = await petraApiRequest.call(
						this,
						'GET',
						`/webhooks/${staticData.webhookId}`,
					);
					if (webhook.url === webhookUrl && webhook.event === hookType) {
						return true;
					}
					// URL or hook type changed since registration — re-register from scratch
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
				const webhookUrl = this.getNodeWebhookUrl('default');
				const hookType = this.getNodeParameter('hookType') as string;

				const response = await petraApiRequest.call(this, 'POST', '/webhooks', {
					event: hookType,
					url: webhookUrl,
				});

				if (!response.id) {
					throw new NodeOperationError(
						this.getNode(),
						'The HalloPetra API did not return a webhook ID',
					);
				}

				const staticData = this.getWorkflowStaticData('node');
				staticData.webhookId = response.id;
				staticData.webhookSecret = response.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
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

		if (secret) {
			const headers = this.getHeaderData();
			const signature = headers['x-petra-signature'] as string | undefined;
			const rawBody =
				(this.getRequestObject() as unknown as { rawBody?: Buffer }).rawBody ??
				Buffer.from(JSON.stringify(this.getBodyData()));
			const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

			const signatureBuffer = Buffer.from(signature ?? '', 'utf8');
			const expectedBuffer = Buffer.from(expected, 'utf8');
			const isValid =
				signatureBuffer.length === expectedBuffer.length &&
				timingSafeEqual(signatureBuffer, expectedBuffer);

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
