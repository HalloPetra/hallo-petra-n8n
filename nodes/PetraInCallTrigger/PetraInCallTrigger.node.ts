import type {
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { registrationProperty, syncResponseProperties } from '../shared/TriggerProperties';
import {
	checkPetraWebhook,
	createPetraWebhook,
	deletePetraWebhook,
	petraRegistration,
	receivePetraWebhook,
	type PetraWebhookRegistration,
} from '../shared/WebhookFunctions';

/** The event this trigger registers for — see POST /webhooks. */
const WEBHOOK_EVENT = 'call.tool';

function registration(context: IHookFunctions): PetraWebhookRegistration {
	return petraRegistration(context, WEBHOOK_EVENT);
}

export class PetraInCallTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra In-Call Trigger',
		name: 'petraInCallTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: 'while Petra is on the call',
		description:
			'Starts the workflow while Petra is on the call, when she needs something she cannot answer herself — look up an order, check a delivery date, book a slot. Registers itself with HalloPetra when the workflow is published; when Petra reaches for it is configured on the Ablauf in the HalloPetra app. The delivery arrives as { body: { webhook_id, call, parameter, fields } }, where "parameter" holds what Petra asked the caller. Finish the workflow with a "Reply to Petra" node so she can keep talking.',
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
		properties: [registrationProperty, ...syncResponseProperties],
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
