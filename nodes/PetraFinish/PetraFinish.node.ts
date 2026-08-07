import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { jsonParse, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const PETRA_TRIGGER_NODE_TYPE = '@hallopetra/n8n-nodes-hallopetra.petraTrigger';

export class PetraFinish implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Reply to Petra',
		name: 'petraFinish',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: 'respond to HalloPetra',
		description:
			'Sends what you looked up back to Petra, in the format Petra expects (contact data, additional data, content). Terminal node without outputs — to run additional steps after responding, branch off before this node.',
		defaults: {
			name: 'Reply to Petra',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [],
		properties: [
			{
				displayName: 'Contact',
				name: 'contact',
				type: 'collection',
				placeholder: 'Add contact field',
				default: {},
				description: 'Contact data Petra has available during the call',
				options: [
					{
						displayName: 'Address',
						name: 'address',
						type: 'string',
						default: '',
						description: 'Postal address of the contact, e.g. "Musterstraße 1, 12345 Musterstadt"',
					},
					{
						displayName: 'Email',
						name: 'email',
						type: 'string',
						placeholder: 'name@email.com',
						default: '',
						description: 'Email address of the contact',
					},
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						description: 'Full name of the contact, e.g. "Max Mustermann"',
					},
					{
						displayName: 'Phone',
						name: 'phone',
						type: 'string',
						default: '',
						description: 'Phone number of the contact, e.g. "+491234567890"',
					},
				],
			},
			{
				displayName: 'Other Data',
				name: 'otherData',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add data field',
				default: {},
				description: 'Additional key-value data Petra has available during the call',
				options: [
					{
						displayName: 'Data',
						name: 'values',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
								description: 'Name of the data field, e.g. "data_1"',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Value of the data field',
							},
						],
					},
				],
			},
			{
				displayName: 'Persist Fields (Kontakt)',
				name: 'fieldsKontakt',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add field',
				default: {},
				description:
					'Key-value fields that HalloPetra persists on the contact (fields.kontakt in the response)',
				options: [
					{
						displayName: 'Field',
						name: 'values',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Persist Fields (Prozess)',
				name: 'fieldsProzess',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add field',
				default: {},
				description:
					'Key-value fields that HalloPetra persists on the process (fields.prozess in the response)',
				options: [
					{
						displayName: 'Field',
						name: 'values',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Persist Fields (Projekt)',
				name: 'fieldsProjekt',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add field',
				default: {},
				description:
					'Key-value fields that HalloPetra persists on the project (fields.projekt in the response)',
				options: [
					{
						displayName: 'Field',
						name: 'values',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Content',
				name: 'contentType',
				type: 'options',
				options: [
					{
						name: 'None',
						value: 'none',
						description: 'Send no content field at all',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'Content is free-form text',
					},
					{
						name: 'JSON',
						value: 'json',
						description: 'Content is a JSON structure',
					},
				],
				default: 'none',
				description:
					'Content Petra has available during the call. With "None" the response contains no content field.',
			},
			{
				displayName: 'Text',
				name: 'content',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						contentType: ['text'],
					},
				},
				default: '',
				description: 'Free-form content Petra has available during the call, in plain language',
			},
			{
				displayName: 'JSON',
				name: 'contentJson',
				type: 'json',
				displayOptions: {
					show: {
						contentType: ['json'],
					},
				},
				default: '{}',
				description: 'JSON content Petra has available during the call',
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
		const parentNodes = this.getParentNodes(this.getNode().name);
		const hasPetraTrigger = parentNodes.some(
			(node) => node.type === PETRA_TRIGGER_NODE_TYPE && !node.disabled,
		);
		if (!hasPetraTrigger) {
			throw new NodeOperationError(
				this.getNode(),
				'No Petra Incoming Call Trigger found in the workflow',
				{
					description:
						'Add a "Petra Incoming Call Trigger" to this workflow and set its "Respond" parameter to "Using Reply to Petra Node"',
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

		const contactInput = this.getNodeParameter('contact', 0, {}) as IDataObject;
		const contact: IDataObject = {};
		if (contactInput.name) contact.contact_data_name = contactInput.name;
		if (contactInput.email) contact.contact_data_email = contactInput.email;
		if (contactInput.phone) contact.contact_data_phone = contactInput.phone;
		if (contactInput.address) contact.contact_data_address = contactInput.address;

		const otherDataInput = this.getNodeParameter('otherData.values', 0, []) as Array<{
			key: string;
			value: string;
		}>;
		const otherData: IDataObject = {};
		for (const { key, value } of otherDataInput) {
			if (key) otherData[key] = value;
		}

		// Only sections that actually contain data end up in the response
		const body: IDataObject = {};
		if (Object.keys(contact).length) {
			body.contact = contact;
		}
		if (Object.keys(otherData).length) {
			body.other_data = otherData;
		}

		// fields envelope: values HalloPetra persists on Kontakt/Prozess/Projekt
		const fields: IDataObject = {};
		for (const [parameter, key] of [
			['fieldsKontakt', 'kontakt'],
			['fieldsProzess', 'prozess'],
			['fieldsProjekt', 'projekt'],
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

		const contentType = this.getNodeParameter('contentType', 0) as string;
		if (contentType === 'json') {
			const rawContent = this.getNodeParameter('contentJson', 0) as IDataObject | string;
			body.content =
				typeof rawContent === 'string'
					? jsonParse<IDataObject>(rawContent, {
							errorMessage: 'Content (JSON) must be valid JSON',
						})
					: rawContent;
		} else if (contentType === 'text') {
			body.content = this.getNodeParameter('content', 0, '') as string;
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
