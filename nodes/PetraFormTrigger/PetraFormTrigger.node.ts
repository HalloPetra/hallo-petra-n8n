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

import { loadForms } from '../shared/GenericFunctions';
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
const WEBHOOK_EVENT = 'form_submission';

function registration(context: IHookFunctions): PetraWebhookRegistration {
	// An empty selection is a company-wide registration: every form counts.
	const ids =
		(context.getNodeParameter('fires', 'all') as string) === 'selected'
			? (context.getNodeParameter('formIds', []) as string[])
			: [];
	return petraRegistration(context, WEBHOOK_EVENT, { field: 'form_ids', ids });
}

export class PetraFormTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Form Submission Trigger',
		name: 'petraFormTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["fires"] === "selected" ? "for selected forms" : "for every form"}}',
		description:
			'Starts the workflow when someone submits a HalloPetra form. The delivery arrives as { event, form: { id, title, slug }, submission: { submitted_at, data }, contact, call }, where "data" holds the entries keyed by field, and "call" is filled when the form belongs to a call. Nothing waits for an answer — write results back with the Petra contact and task nodes instead of replying.',
		defaults: {
			name: 'Petra Form Submission Trigger',
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
				// Fire-and-forget: acknowledge at once, nothing reads the response.
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
						name: 'For Every Form',
						value: 'all',
						description: 'Any submitted form starts this workflow',
					},
					{
						name: 'Only for Selected Forms',
						value: 'selected',
						description: 'Only submissions of the chosen forms start this workflow',
					},
				],
				default: 'all',
				description: 'Which submissions start this workflow',
			},
			{
				displayName: 'Form Names or IDs',
				name: 'formIds',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getForms',
				},
				displayOptions: {
					show: {
						fires: ['selected'],
					},
				},
				default: [],
				description:
					'The forms this workflow reacts to. A submission of any one of them starts it. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			registrationProperty,
		],
	};

	methods = {
		loadOptions: {
			async getForms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadForms.call(this);
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
