import type {
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { loadAblaeufe } from '../shared/GenericFunctions';
import { registrationProperty } from '../shared/TriggerProperties';
import {
	checkPetraWebhook,
	createPetraWebhook,
	deletePetraWebhook,
	petraRegistration,
	receivePetraWebhook,
	type PetraWebhookRegistration,
} from '../shared/WebhookFunctions';

/** The event this trigger registers for — see POST /webhooks. */
const WEBHOOK_EVENT = 'call.finished';

function registration(context: IHookFunctions): PetraWebhookRegistration {
	// An empty selection is a company-wide registration: HalloPetra then delivers
	// after every call, whichever Ablauf ran.
	const ids =
		(context.getNodeParameter('fires', 'all') as string) === 'selected'
			? (context.getNodeParameter('ablaufIds', []) as string[])
			: [];
	return petraRegistration(context, WEBHOOK_EVENT, { field: 'ablauf_ids', ids });
}

export class PetraCallFinishedTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Call Finished Trigger',
		name: 'petraCallFinishedTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["fires"] === "selected" ? "for selected Abläufe" : "after every call"}}',
		description:
			'Starts the workflow after a call has ended and Petra has written it up — hand the result to a CRM, a ticket system or a spreadsheet. The delivery carries the summary, the topic, the full transcript, the data collected during the call and the linked contact. It arrives once, is never retried, and nothing waits for an answer: write results back with the Petra contact and task nodes instead of replying.',
		defaults: {
			name: 'Petra Call Finished Trigger',
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
				// Fire-and-forget: acknowledge at once, never make a finished call wait.
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Fires',
				name: 'fires',
				type: 'options',
				options: [
					{
						name: 'After Every Call',
						value: 'all',
						description: 'Every finished call starts this workflow, whichever Ablauf ran',
					},
					{
						name: 'Only After Selected Abläufe',
						value: 'selected',
						description: 'Only calls that ran one of the chosen Abläufe start this workflow',
					},
				],
				default: 'all',
				description: 'Which finished calls start this workflow',
			},
			{
				displayName: 'Ablauf Names or IDs',
				name: 'ablaufIds',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getAblaeufe',
				},
				displayOptions: {
					show: {
						fires: ['selected'],
					},
				},
				default: [],
				description:
					'The Abläufe this workflow reacts to. A call that ran any one of them starts it. The webhook also appears on each of these Abläufe in the HalloPetra app under "Nach dem Anruf". Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			registrationProperty,
		],
	};

	methods = {
		loadOptions: {
			async getAblaeufe(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadAblaeufe.call(this);
			},
		},
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
