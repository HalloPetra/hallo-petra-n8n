import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildContactBody,
	contactFieldDataProperty,
	contactFieldsProperty,
	contactFieldsWithoutNameProperty,
	contactNameProperty,
} from '../shared/ContactFields';
import { petraApiRequest } from '../shared/GenericFunctions';

const PETRA_TRIGGER_NODE_TYPE = '@hallopetra/n8n-nodes-hallopetra.petraTrigger';

/** How the trigger's event options are labelled, for error messages. */
const EVENT_LABEL = {
	'call.incoming': 'Call Incoming',
	'call.tool': 'Call Tool',
	// call.finished and form.submitted are fire-and-forget: HalloPetra reads
	// nothing back from them, so they are deliberately not offered here.
} as const;

type RespondTo = keyof typeof EVENT_LABEL;

/** A key-value fixedCollection, used for each group of the `fields` envelope. */
function fieldsCollection(name: string, displayName: string, group: string) {
	return {
		displayName,
		name,
		type: 'fixedCollection' as const,
		typeOptions: {
			multipleValues: true,
		},
		displayOptions: {
			show: {
				resource: ['call'],
				operation: ['reply'],
			},
		},
		placeholder: 'Add field',
		default: {},
		description: `Key-value fields that HalloPetra persists (fields.${group} in the response)`,
		options: [
			{
				displayName: 'Field',
				name: 'values',
				values: [
					{
						displayName: 'Key',
						name: 'key',
						type: 'string' as const,
						default: '',
						description: 'Field name in snake_case, e.g. "customer_number"',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string' as const,
						default: '',
					},
				],
			},
		],
	};
}

export class Petra implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'HalloPetra',
		name: 'petra',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Works with HalloPetra: reply to a call Petra is waiting on, or create and update contacts in the HalloPetra directory',
		defaults: {
			name: 'HalloPetra',
		},
		inputs: [NodeConnectionTypes.Main],
		// A call gets exactly one response, so replying ends the branch; the
		// contact operations pass their result on.
		outputs: '={{$parameter["resource"] === "call" ? [] : ["main"]}}',
		credentials: [
			{
				name: 'petraApi',
				required: true,
				// Replying answers the trigger's open webhook — no API call, no key.
				displayOptions: {
					show: {
						resource: ['contact'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Call',
						value: 'call',
					},
					{
						name: 'Contact',
						value: 'contact',
					},
				],
				default: 'contact',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['call'],
					},
				},
				options: [
					{
						name: 'Reply',
						value: 'reply',
						action: 'Reply to a call',
						description:
							'Send the response Petra is waiting for — answers a "Call Incoming" or "Call Tool" trigger. Terminal: to run additional steps after responding, branch off before this node.',
					},
				],
				default: 'reply',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['contact'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a contact',
						description:
							'Add someone to the HalloPetra contact directory, so Petra knows them by name the next time they call',
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a contact',
						description:
							'Write what you learned back to a contact. Only the fields you fill in change.',
					},
				],
				default: 'create',
			},

			// ----------------------------------
			//            call: reply
			// ----------------------------------
			{
				displayName: 'Respond To',
				name: 'respondTo',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['call'],
						operation: ['reply'],
					},
				},
				options: [
					{
						name: 'Incoming Call',
						value: 'call.incoming',
						description:
							'Answers a trigger set to "Call Incoming" — what Petra knows before the greeting',
					},
					{
						name: 'During a Call',
						value: 'call.tool',
						description:
							'Answers a trigger set to "Call Tool" — what Petra says and learns mid-conversation',
					},
				],
				default: 'call.incoming',
				required: true,
				description: 'Which trigger event this workflow started from',
			},
			{
				displayName: 'Message',
				name: 'messageContent',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				displayOptions: {
					show: {
						resource: ['call'],
						operation: ['reply'],
						respondTo: ['call.tool'],
					},
				},
				default: '',
				description:
					'What Petra should say next, in plain language. Leave empty to hand her fields and instructions without a spoken announcement.',
			},
			fieldsCollection('fieldsKontakt', 'Persist Fields (Kontakt)', 'kontakt'),
			fieldsCollection('fieldsProzess', 'Persist Fields (Prozess)', 'prozess'),
			{
				displayName: 'Instructions',
				name: 'instructions',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				displayOptions: {
					show: {
						resource: ['call'],
						operation: ['reply'],
					},
				},
				default: '',
				description:
					'How Petra should handle this call, in plain language, e.g. "Customer has an open invoice — do not raise it, note the request and pass it to accounting"',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				displayOptions: {
					show: {
						resource: ['call'],
						operation: ['reply'],
					},
				},
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Response Code',
						name: 'responseCode',
						type: 'number',
						typeOptions: {
							minValue: 100,
							maxValue: 599,
						},
						default: 200,
						description: 'HTTP status code of the response',
					},
				],
			},

			// ----------------------------------
			//         contact: create
			// ----------------------------------
			{
				...contactNameProperty,
				displayOptions: {
					show: {
						resource: ['contact'],
						operation: ['create'],
					},
				},
			},
			{
				...contactFieldsWithoutNameProperty,
				displayOptions: {
					show: {
						resource: ['contact'],
						operation: ['create'],
					},
				},
			},

			// ----------------------------------
			//         contact: update
			// ----------------------------------
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['contact'],
						operation: ['update'],
					},
				},
				default: '',
				description:
					'Which contact to update. The HalloPetra Trigger carries it: for "Call Incoming" in the contact object of its payload, for "Call Tool" as contact_id on the call. Empty when the caller was unknown.',
			},
			{
				...contactFieldsProperty,
				displayOptions: {
					show: {
						resource: ['contact'],
						operation: ['update'],
					},
				},
			},

			// Both contact operations take the same free-form field data.
			{
				...contactFieldDataProperty,
				displayOptions: {
					show: {
						resource: ['contact'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;

		if (resource === 'call') {
			return await replyToPetra.call(this);
		}

		const operation = this.getNodeParameter('operation', 0) as string;
		return operation === 'update'
			? await updateContacts.call(this)
			: await createContacts.call(this);
	}
}

/** Answer the webhook the trigger is holding open — no API request involved. */
async function replyToPetra(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const respondTo = this.getNodeParameter('respondTo', 0) as RespondTo;
	const expectedLabel = EVENT_LABEL[respondTo];

	const parentNodes = this.getParentNodes(this.getNode().name, { includeNodeParameters: true });
	const activeTriggers = parentNodes.filter(
		(node) => !node.disabled && node.type === PETRA_TRIGGER_NODE_TYPE,
	);
	if (!activeTriggers.length) {
		throw new NodeOperationError(this.getNode(), 'No HalloPetra trigger found in the workflow', {
			description: `Add a "HalloPetra Trigger" with its Event set to "${expectedLabel}" to this workflow, and set its "Respond" parameter to "Using Reply to Petra Node"`,
		});
	}
	// A response built for the wrong phase is silently useless — Petra reads
	// `message` only during a call, and never sends one before the greeting.
	// The event defaults to call.incoming, which n8n leaves out of the stored
	// parameters; a missing parameters object means an n8n version that cannot
	// report them, and then the check is skipped rather than failed.
	const eventMatches = activeTriggers.some(
		(node) =>
			node.parameters === undefined ||
			((node.parameters.event as string | undefined) ?? 'call.incoming') === respondTo,
	);
	if (!eventMatches) {
		throw new NodeOperationError(
			this.getNode(),
			`"Respond To" is set to "${respondTo}", but this workflow starts from a different HalloPetra event`,
			{
				description: `Either set the trigger's Event to "${expectedLabel}", or change "Respond To" to match the event this workflow actually starts from`,
			},
		);
	}

	// A HalloPetra call gets exactly one response, so the first item forms it by design.
	// Surface that as a hint rather than silently dropping the rest of a batch.
	const itemCount = this.getInputData().length;
	if (itemCount > 1) {
		this.addExecutionHints({
			message: `Only the first of ${itemCount} items forms the response — HalloPetra receives a single answer per call.`,
			location: 'outputPane',
		});
	}

	// Only sections that actually contain data end up in the response
	const body: IDataObject = {};

	if (respondTo === 'call.tool') {
		const message = this.getNodeParameter('messageContent', 0, '') as string;
		if (message) {
			body.message = message;
		}
	}

	// fields envelope: values HalloPetra persists on Kontakt/Prozess.
	// A live call carries no Projekt group — the server drops it.
	const fields: IDataObject = {};
	for (const [parameter, key] of [
		['fieldsKontakt', 'kontakt'],
		['fieldsProzess', 'prozess'],
	] as const) {
		const entries = this.getNodeParameter(`${parameter}.values`, 0, []) as Array<{
			key: string;
			value: string;
		}>;
		const section: IDataObject = {};
		for (const { key: entryKey, value } of entries) {
			if (entryKey) section[entryKey] = value;
		}
		if (Object.keys(section).length) {
			fields[key] = section;
		}
	}
	if (Object.keys(fields).length) {
		body.fields = fields;
	}

	const instructions = this.getNodeParameter('instructions', 0, '') as string;
	if (instructions) {
		body.instructions = instructions;
	}

	const options = this.getNodeParameter('options', 0, {}) as IDataObject;
	const responseCode = (options.responseCode as number) ?? 200;

	this.sendResponse({
		body,
		headers: { 'content-type': 'application/json' },
		statusCode: responseCode,
	});

	return [];
}

async function createContacts(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const body = buildContactBody(this, itemIndex);
			// `required` does not catch an expression that resolves to nothing, and
			// the API would happily store a nameless contact the app never shows.
			if (!body.name) {
				throw new NodeOperationError(this.getNode(), 'This contact needs a name', {
					itemIndex,
					description:
						'HalloPetra lists and searches contacts by their name. Without one the contact is created but stays invisible in the app, so the node stops here instead. Check the expression in "Name" — it resolved to nothing for this item.',
				});
			}
			const contact = await petraApiRequest.call(this, 'POST', '/contacts', body);
			results.push({ json: contact, pairedItem: { item: itemIndex } });
		} catch (error) {
			if (this.continueOnFail()) {
				results.push({
					json: { error: (error as Error).message },
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			// Pass our own errors through — re-wrapping them would drop the
			// description, which is where the explanation lives.
			throw error instanceof NodeOperationError
				? error
				: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
		}
	}

	return [results];
}

async function updateContacts(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const contactId = (this.getNodeParameter('contactId', itemIndex) as string).trim();
		if (!contactId) {
			const error = new NodeOperationError(this.getNode(), 'Item has no contact ID', {
				itemIndex,
				description:
					'HalloPetra only knows the contact when the caller was recognised. Branch on it before this node, or create the contact instead.',
			});
			if (this.continueOnFail()) {
				results.push({ json: { error: error.message }, pairedItem: { item: itemIndex } });
				continue;
			}
			throw error;
		}

		const body = buildContactBody(this, itemIndex);
		// The API rejects an empty patch, and a request that changes nothing
		// is a configuration mistake worth naming rather than passing on.
		if (!Object.keys(body).length) {
			const error = new NodeOperationError(this.getNode(), 'No contact fields to update', {
				itemIndex,
				description: 'Fill in at least one contact field or one field data entry',
			});
			if (this.continueOnFail()) {
				results.push({ json: { error: error.message }, pairedItem: { item: itemIndex } });
				continue;
			}
			throw error;
		}

		try {
			const contact = await petraApiRequest.call(this, 'PATCH', `/contacts/${contactId}`, body);
			results.push({ json: contact, pairedItem: { item: itemIndex } });
		} catch (error) {
			if (this.continueOnFail()) {
				results.push({
					json: { error: (error as Error).message },
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
		}
	}

	return [results];
}
