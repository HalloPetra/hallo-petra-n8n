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
const WEBHOOK_EVENT = 'call.incoming';

function registration(context: IHookFunctions): PetraWebhookRegistration {
	return petraRegistration(context, WEBHOOK_EVENT);
}

// Deliberately no `usableAsTool`: a trigger cannot be invoked as an AI tool.
	// The rule below flipped meaning between plugin versions — 0.28 (bundled with
	// node-cli) demands the property, 0.29 (used by scan-community-package, the
	// gate for verification) forbids it here. The scanner wins; drop this once
	// node-cli ships 0.29.
	// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class PetraTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Incoming Call Trigger',
		name: 'petraTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'before Petra answers',
		description:
			'Starts the workflow while the phone is still ringing, before Petra takes the call — look up who is calling so Petra can greet them by name. Registers itself with HalloPetra when the workflow is published. The call data arrives as { webhook_id, event, data: { call_id, calling_phone_number, inbound_phone_number, start_time, contact, fields } }, where contact is null for an unknown caller. Answer with a "Reply to Petra" node. Petra waits at most 2.5 seconds — including this workflow\'s own startup — so keep it to a single lookup; on timeout the call simply proceeds without the data.',
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
