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

import { loadAblaeufe } from '../shared/GenericFunctions';
import { registrationProperty, syncResponseProperties } from '../shared/TriggerProperties';
import {
	checkPetraWebhook,
	createPetraWebhook,
	deletePetraWebhook,
	petraRegistration,
	receivePetraWebhook,
	type PetraToolParameter,
	type PetraWebhookRegistration,
} from '../shared/WebhookFunctions';

/** The event this trigger registers for — see POST /webhooks. */
const WEBHOOK_EVENT = 'call.tool';

/**
 * Unlike the other three triggers, registering this one *defines* the tool:
 * `name` is what Petra calls it, `description` is what she reads to decide
 * when to call it, and `ablauf_ids` is where it gets attached. The API
 * requires all three, so a missing value is caught here with a message that
 * names the field rather than being bounced as an opaque 400. None of it is
 * sent when the operator registers the tool in the app instead, so that mode
 * is not held to it.
 */
function registration(context: IHookFunctions): PetraWebhookRegistration {
	const name = (context.getNodeParameter('toolName', '') as string).trim();
	const description = (context.getNodeParameter('toolDescription', '') as string).trim();
	const ablaufIds = context.getNodeParameter('ablaufIds', []) as string[];
	const registersItself =
		(context.getNodeParameter('registration', 'automatic') as string) === 'automatic';

	if (registersItself && !name) {
		throw new NodeOperationError(context.getNode(), 'This tool needs a name', {
			description: 'Petra calls the workflow by this name. Fill in "Tool Name".',
		});
	}
	if (registersItself && !ablaufIds.length) {
		throw new NodeOperationError(context.getNode(), 'This tool needs at least one Ablauf', {
			description:
				'The tool is attached as a step to the Abläufe you pick, and Petra reaches for it once a conversation gets there. Select at least one under "Ablauf Names or IDs".',
		});
	}

	const parameters = (
		context.getNodeParameter('parameters.values', []) as PetraToolParameter[]
	)
		.filter((parameter) => parameter.key)
		.map((parameter) => ({
			key: parameter.key,
			label: parameter.label || undefined,
			description: parameter.description || undefined,
		}));

	return petraRegistration(context, WEBHOOK_EVENT, {
		// Falls back to the dashboard label in manual mode, where nothing is sent
		// and an empty name would only make the comparison confusing.
		...(name ? { name } : {}),
		...(description ? { description } : {}),
		scope: { field: 'ablauf_ids', ids: ablaufIds },
		parameters,
	});
}

export class PetraInCallTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra In-Call Trigger',
		name: 'petraInCallTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["toolName"] || "while Petra is on the call"}}',
		description:
			'Makes this workflow a tool Petra can use mid-conversation, when she needs something she cannot answer herself — look up an order, check a delivery date, book a slot. Publishing the workflow creates the tool in HalloPetra and attaches it to the Abläufe you pick; Petra reaches for it once a conversation gets there. The delivery arrives as { body: { webhook_id, call, parameter, fields } }, where "parameter" holds the values Petra collected from the caller. She waits up to 10 seconds — finish the workflow with a "Reply to Petra" node so she can keep talking.',
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
				default: '',
				required: true,
				placeholder: 'Auftragsstatus nachschlagen',
				description:
					'The name Petra calls this workflow by. Keep it short and descriptive — it shows up in the Ablauf editor as a step.',
			},
			{
				displayName: 'When Petra Should Use It',
				name: 'toolDescription',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				placeholder:
					'Schlägt den Status eines Auftrags nach. Nutze das, wenn der Anrufer wissen will, wo seine Bestellung bleibt.',
				description:
					'What Petra reads to decide whether to reach for this tool. Write it as an instruction to her, in the language she speaks with your callers.',
			},
			{
				displayName: 'Ablauf Names or IDs',
				name: 'ablaufIds',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getAblaeufe',
				},
				default: [],
				required: true,
				description:
					'The Abläufe this tool is attached to — Petra can only use it while she is running one of them. Pick at least one. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Parameters',
				name: 'parameters',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add parameter',
				default: {},
				description:
					'What Petra asks the caller for before calling this workflow. The values arrive under "body.parameter", keyed by the key you give here.',
				options: [
					{
						displayName: 'Parameter',
						name: 'values',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
								placeholder: 'bestellnummer',
								description:
									'The key this value arrives under in "body.parameter". Letters, digits, hyphens and underscores.',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								typeOptions: {
									rows: 2,
								},
								default: '',
								placeholder:
									'Die Bestellnummer, nach der der Anrufer fragt. Frage nach, wenn sie nicht genannt wurde.',
								description:
									'What Petra reads to fill this value — write it as an instruction to her',
							},
							{
								displayName: 'Label',
								name: 'label',
								type: 'string',
								default: '',
								description: 'How the parameter is labelled in the HalloPetra app',
							},
						],
					},
				],
			},
			registrationProperty,
			...syncResponseProperties,
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
