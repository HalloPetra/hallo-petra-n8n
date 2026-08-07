import type {
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	checkPetraWebhook,
	createPetraWebhook,
	deletePetraWebhook,
	receivePetraWebhook,
	type PetraWebhookRegistration,
} from '../shared/WebhookFunctions';

/** The integration point this trigger registers for — see POST /webhooks. */
const WEBHOOK_TYPE = 'call.during';

function registration(context: IHookFunctions): PetraWebhookRegistration {
	return {
		type: WEBHOOK_TYPE,
		url: context.getNodeWebhookUrl('default') as string,
		// Not decoration: these two are what Petra reads mid-conversation to
		// decide whether this workflow is the right tool for what the caller
		// just asked. HalloPetra rejects a `call.during` registration without them.
		name: context.getNodeParameter('toolName') as string,
		description: context.getNodeParameter('toolDescription') as string,
	};
}

export class PetraInCallTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra In-Call Trigger',
		name: 'petraInCallTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["toolName"]}}',
		description:
			'Starts the workflow while Petra is on the call, when she needs something she cannot answer herself — look up an order, check a delivery date, book a slot. Registers itself with HalloPetra as a tool Petra can reach for; the name and description below are what she reads to decide when to use it. The delivery arrives as { body: { webhook_id, call, parameter, fields } }, where "parameter" holds what Petra asked the caller. Finish the workflow with a "Reply to Petra" node so she can keep talking. Petra waits up to 10 seconds.',
		defaults: {
			name: 'Petra In-Call Trigger',
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
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Look up order status',
				description:
					'What this workflow does, in a few words. Petra sees it as the name of the tool, and the operator sees it in the HalloPetra dashboard.',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				required: true,
				default: '',
				placeholder:
					'Looks up the status of an order when the caller asks about an order they placed',
				description:
					'When Petra should use this workflow, in plain language. This is the instruction she reads mid-conversation to decide whether to call it — be specific about the situation, not about the technical steps.',
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
							'Register the tool automatically with HalloPetra when the workflow is published. Incoming calls are verified via HMAC signature.',
					},
					{
						name: 'Manual (Copy URL to HalloPetra)',
						value: 'manual',
						description:
							'Do not call the HalloPetra API. Copy the production webhook URL from this trigger and configure it in the HalloPetra app yourself. Incoming calls are not signature-checked.',
					},
				],
				default: 'automatic',
				description: 'How the tool becomes known to HalloPetra',
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
				return await checkPetraWebhook.call(this, registration(this));
			},

			async create(this: IHookFunctions): Promise<boolean> {
				return await createPetraWebhook.call(this, registration(this));
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				return await deletePetraWebhook.call(this);
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return await receivePetraWebhook.call(this);
	}
}
