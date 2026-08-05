import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { jsonParse, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const PETRA_TRIGGER_NODE_TYPE = 'n8n-nodes-petra.petraTrigger';

export class PetraFinish implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Petra Finish',
		name: 'petraFinish',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: 'respond to HalloPetra',
		description:
			'Sends the synchronous response back to HalloPetra in the format the Petra agent expects (contact data, additional data, content). Terminal node without outputs — to run additional steps after responding, branch off before this node.',
		defaults: {
			name: 'Petra Finish',
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
				description: 'Contact data that ends up in the context of the Petra agent',
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
				description: 'Additional key-value data that ends up in the context of the Petra agent',
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
				displayName: 'Content Type',
				name: 'contentType',
				type: 'options',
				options: [
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
				default: 'text',
				description: 'How the content for the Petra agent is provided',
			},
			{
				displayName: 'Content',
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
				description: 'Free-form content that ends up in the context of the Petra agent',
			},
			{
				displayName: 'Content (JSON)',
				name: 'contentJson',
				type: 'json',
				displayOptions: {
					show: {
						contentType: ['json'],
					},
				},
				default: '{}',
				description: 'JSON content that ends up in the context of the Petra agent',
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
				'No Petra Webhook trigger found in the workflow',
				{
					description:
						'Add a "Petra Webhook" trigger to this workflow and set its "Respond" parameter to "Using Petra Finish Node"',
				},
			);
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

		const contentType = this.getNodeParameter('contentType', 0) as string;
		let content: IDataObject | IDataObject[] | string;
		if (contentType === 'json') {
			const rawContent = this.getNodeParameter('contentJson', 0) as IDataObject | string;
			content =
				typeof rawContent === 'string'
					? jsonParse<IDataObject>(rawContent, {
							errorMessage: 'Content (JSON) must be valid JSON',
						})
					: rawContent;
		} else {
			content = this.getNodeParameter('content', 0, '') as string;
		}

		const options = this.getNodeParameter('options', 0, {}) as IDataObject;
		const responseCode = (options.responseCode as number) ?? 200;

		this.sendResponse({
			body: {
				contact,
				other_data: otherData,
				content,
			},
			headers: { 'content-type': 'application/json' },
			statusCode: responseCode,
		});

		return [];
	}
}
