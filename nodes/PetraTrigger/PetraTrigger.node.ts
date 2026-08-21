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

import { loadCallFlows, loadForms } from '../shared/GenericFunctions';
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

/**
 * One registration body per event — see POST /webhooks. `call.tool` is the
 * special case: registering it *defines* the tool (`name` is what Petra calls
 * it, `description` is what she reads to decide when to call it, and
 * `callFlowIds` is where it gets attached), so the API requires all three and
 * a missing value is caught here with a message that names the field rather
 * than being bounced as an opaque 400. None of it is sent when the operator
 * registers the webhook in the app instead, so that mode is not held to it.
 */
function registration(context: IHookFunctions): PetraWebhookRegistration {
	const event = context.getNodeParameter('event', 'call.incoming') as string;

	switch (event) {
		case 'call.tool': {
			const name = (context.getNodeParameter('toolName', '') as string).trim();
			const description = (context.getNodeParameter('toolDescription', '') as string).trim();
			const callFlowIds = context.getNodeParameter('callFlowIds', []) as string[];
			const registersItself =
				(context.getNodeParameter('registration', 'automatic') as string) === 'automatic';

			if (registersItself && !name) {
				throw new NodeOperationError(context.getNode(), 'This tool needs a name', {
					description: 'Petra calls the workflow by this name. Fill in "Tool Name".',
				});
			}
			if (registersItself && !callFlowIds.length) {
				throw new NodeOperationError(context.getNode(), 'This tool needs at least one call flow', {
					description:
						'The tool is attached as a step to the call flows you pick, and Petra reaches for it once a conversation gets there. Select at least one under "Call Flow Names or IDs".',
				});
			}

			const parameters = (context.getNodeParameter('parameters.values', []) as PetraToolParameter[])
				.filter((parameter) => parameter.key)
				.map((parameter) => ({
					key: parameter.key,
					label: parameter.label || undefined,
					description: parameter.description || undefined,
				}));

			return petraRegistration(context, event, {
				// Falls back to the dashboard label in manual mode, where nothing is
				// sent and an empty name would only make the comparison confusing.
				...(name ? { name } : {}),
				...(description ? { description } : {}),
				scope: { field: 'callFlowIds', ids: callFlowIds },
				parameters,
			});
		}
		case 'call.finished':
		case 'form.submitted': {
			// An empty selection is a company-wide registration: HalloPetra then
			// delivers for every call flow or form.
			const field = event === 'call.finished' ? 'callFlowIds' : 'formIds';
			const ids =
				(context.getNodeParameter('fires', 'all') as string) === 'selected'
					? (context.getNodeParameter(field, []) as string[])
					: [];
			return petraRegistration(context, event, { scope: { field, ids } });
		}
		default:
			return petraRegistration(context, event);
	}
}

// Deliberately no `usableAsTool`: a trigger cannot be invoked as an AI tool.
	// The rule below flipped meaning between plugin versions — 0.28 (bundled with
	// node-cli) demands the property, 0.29 (used by scan-community-package, the
	// gate for verification) forbids it here. The scanner wins; drop this once
	// node-cli ships 0.29.
	// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class PetraTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'HalloPetra Trigger',
		name: 'petraTrigger',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["event"] === "call.tool" ? ($parameter["toolName"] || "while Petra is on the call") : $parameter["event"] === "call.finished" ? "after every call" : $parameter["event"] === "form.submitted" ? "on form submission" : "before Petra answers"}}',
		description:
			'Starts the workflow on a HalloPetra event: before Petra answers a call (to look up the caller), mid-conversation as a tool Petra can use, after a call has been written up, or when a form is submitted. Registers itself with HalloPetra when the workflow is published. The two call events Petra waits on ("Call Incoming", "Call Tool") are answered with the "HalloPetra" node; the other two are fire-and-forget.',
		defaults: {
			name: 'HalloPetra Trigger',
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
				// Only the two synchronous events honour the user's response settings;
				// call.finished and form.submitted are fire-and-forget and acknowledge
				// at once. The fallbacks matter: parameters still at their default are
				// not persisted in the workflow, so $parameter can come back undefined.
				// `responseData` must resolve to a value — left out, n8n defaults it to
				// `firstEntryJson` and writes that literal string as the response body.
				responseMode:
					'={{["call.incoming","call.tool"].includes($parameter["event"]) ? ($parameter["responseMode"] || "responseNode") : "onReceived"}}',
				responseData:
					'={{["call.incoming","call.tool"].includes($parameter["event"]) && $parameter["responseMode"] === "lastNode" ? ($parameter["responseData"] || "firstEntryJson") : "noData"}}',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: [
					{
						name: 'Call Finished',
						value: 'call.finished',
						description:
							'After a call has ended and Petra has written it up — summary, topic, transcript, collected data and the linked contact. Fire-and-forget, never retried.',
					},
					{
						name: 'Call Incoming',
						value: 'call.incoming',
						description:
							'Before Petra answers, while the phone is still ringing — look up who is calling. Petra waits at most 2.5 seconds for the response.',
					},
					{
						name: 'Call Tool',
						value: 'call.tool',
						description:
							'Mid-conversation, as a tool Petra can use when she needs something she cannot answer herself. Petra waits up to 10 seconds for the response.',
					},
					{
						name: 'Form Submitted',
						value: 'form.submitted',
						description:
							'When someone submits a HalloPetra form — during a call or through a public form link. Fire-and-forget, never retried.',
					},
				],
				default: 'call.incoming',
				required: true,
				description: 'Which HalloPetra event starts this workflow',
			},
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				displayOptions: {
					show: {
						event: ['call.tool'],
					},
				},
				default: '',
				required: true,
				placeholder: 'Look up order status',
				description:
					'The name Petra calls this workflow by. Keep it short and descriptive — it shows up in the call flow editor as a step.',
			},
			{
				displayName: 'When Petra Should Use It',
				name: 'toolDescription',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				displayOptions: {
					show: {
						event: ['call.tool'],
					},
				},
				default: '',
				placeholder:
					'Looks up the status of an order. Use this when the caller wants to know where their order is.',
				description:
					'What Petra reads to decide whether to reach for this tool. Write it as an instruction to her, in the language she speaks with your callers.',
			},
			{
				displayName: 'Call Flow Names or IDs',
				name: 'callFlowIds',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getCallFlows',
				},
				displayOptions: {
					show: {
						event: ['call.tool'],
					},
				},
				default: [],
				required: true,
				description:
					'The call flows this tool is attached to — Petra can only use it while she is running one of them. Pick at least one. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Parameters',
				name: 'parameters',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				displayOptions: {
					show: {
						event: ['call.tool'],
					},
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
								placeholder: 'order_number',
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
									'The order number the caller is asking for. Ask for it if they have not mentioned it yet.',
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
			{
				displayName: 'Fires',
				name: 'fires',
				type: 'options',
				displayOptions: {
					show: {
						event: ['call.finished', 'form.submitted'],
					},
				},
				options: [
					{
						name: 'Always',
						value: 'all',
						description:
							'Every finished call or submitted form starts this workflow, company-wide',
					},
					{
						name: 'Only for Selected',
						value: 'selected',
						description:
							'Only calls that ran one of the chosen call flows, or submissions of the chosen forms, start this workflow',
					},
				],
				default: 'all',
				description: 'Which deliveries start this workflow',
			},
			{
				displayName: 'Call Flow Names or IDs',
				name: 'callFlowIds',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getCallFlows',
				},
				displayOptions: {
					show: {
						event: ['call.finished'],
						fires: ['selected'],
					},
				},
				default: [],
				description:
					'The call flows this workflow reacts to. A call that ran any one of them starts it. The webhook also appears on each of these call flows in the HalloPetra app. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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
						event: ['form.submitted'],
						fires: ['selected'],
					},
				},
				default: [],
				description:
					'The forms this workflow reacts to. A submission of any one of them starts it. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			registrationProperty,
			...syncResponseProperties,
		],
	};

	methods = {
		loadOptions: {
			async getCallFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadCallFlows.call(this);
			},
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
