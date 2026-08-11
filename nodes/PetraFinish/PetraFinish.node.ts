import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const PETRA_TRIGGER_NODE_TYPE = '@hallopetra/n8n-nodes-hallopetra.petraTrigger';
const PETRA_IN_CALL_TRIGGER_NODE_TYPE = '@hallopetra/n8n-nodes-hallopetra.petraInCallTrigger';

/** Which trigger a given `respondTo` value belongs to, and how to name it in an error. */
const RESPOND_TO_TRIGGER = {
	'call.incoming': {
		nodeType: PETRA_TRIGGER_NODE_TYPE,
		displayName: 'Petra Incoming Call Trigger',
	},
	'call.tool': {
		nodeType: PETRA_IN_CALL_TRIGGER_NODE_TYPE,
		displayName: 'Petra In-Call Trigger',
	},
	// call.finished and form_submission are fire-and-forget: HalloPetra reads
	// nothing back from them, so they are deliberately not offered here.
} as const;

type RespondTo = keyof typeof RESPOND_TO_TRIGGER;

/** A key-value fixedCollection, used for each group of the `fields` envelope. */
function fieldsCollection(name: string, displayName: string, group: string) {
	return {
		displayName,
		name,
		type: 'fixedCollection' as const,
		typeOptions: {
			multipleValues: true,
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

export class PetraFinish implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Reply to Petra',
		name: 'petraFinish',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["respondTo"]}}',
		description:
			'Sends what you looked up back to Petra, in the format Petra expects. Answers either the Petra Incoming Call Trigger or the Petra In-Call Trigger — pick which one below. Terminal node without outputs: to run additional steps after responding, branch off before this node.',
		defaults: {
			name: 'Reply to Petra',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [],
		properties: [
			{
				displayName: 'Respond To',
				name: 'respondTo',
				type: 'options',
				options: [
					{
						name: 'Incoming Call',
						value: 'call.incoming',
						description:
							'Answers a "Petra Incoming Call Trigger" — what Petra knows before the greeting',
					},
					{
						name: 'During a Call',
						value: 'call.tool',
						description:
							'Answers a "Petra In-Call Trigger" — what Petra says and learns mid-conversation',
					},
				],
				default: 'call.incoming',
				required: true,
				description: 'Which trigger this workflow started from',
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
						respondTo: ['call.tool'],
					},
				},
				default: '',
				description:
					'What Petra should say next, in plain language. Leave empty and set the message type to "Silent" to add context without an announcement.',
			},
			{
				displayName: 'Message Type',
				name: 'messageType',
				type: 'options',
				displayOptions: {
					show: {
						respondTo: ['call.tool'],
					},
				},
				options: [
					{
						name: 'Say',
						value: 'SAY',
						description: 'Petra speaks the message to the caller',
					},
					{
						name: 'Silent',
						value: 'SILENT',
						description: 'No announcement — the message is only context for Petra',
					},
				],
				default: 'SAY',
				description: 'Whether Petra says the message out loud',
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
				default: '',
				description:
					'How Petra should handle this call, in plain language, e.g. "Customer has an open invoice — do not raise it, note the request and pass it to accounting"',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const respondTo = this.getNodeParameter('respondTo', 0) as RespondTo;
		const expected = RESPOND_TO_TRIGGER[respondTo];

		const parentNodes = this.getParentNodes(this.getNode().name);
		const activeTriggers = parentNodes.filter(
			(node) =>
				!node.disabled &&
				(node.type === PETRA_TRIGGER_NODE_TYPE ||
					node.type === PETRA_IN_CALL_TRIGGER_NODE_TYPE),
		);
		if (!activeTriggers.length) {
			throw new NodeOperationError(this.getNode(), 'No Petra trigger found in the workflow', {
				description: `Add a "${expected.displayName}" to this workflow and set its "Respond" parameter to "Using Reply to Petra Node"`,
			});
		}
		// A response built for the wrong phase is silently useless — Petra reads
		// `message` only during a call, and never sends one before the greeting.
		if (!activeTriggers.some((node) => node.type === expected.nodeType)) {
			throw new NodeOperationError(
				this.getNode(),
				`"Respond To" is set to "${respondTo}", but this workflow starts from a different Petra trigger`,
				{
					description: `Either add a "${expected.displayName}", or change "Respond To" to match the trigger this workflow actually uses`,
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
			body.message = {
				content: this.getNodeParameter('messageContent', 0, '') as string,
				message_type: this.getNodeParameter('messageType', 0, 'SAY') as string,
			};
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
}
