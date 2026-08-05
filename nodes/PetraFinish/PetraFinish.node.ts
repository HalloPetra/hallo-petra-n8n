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
		subtitle: '={{$parameter["respondWith"]}}',
		description:
			'Sends the synchronous HTTP response back to HalloPetra for a workflow started by a Petra Webhook trigger with "Respond: Using Petra Finish Node"',
		defaults: {
			name: 'Petra Finish',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Respond With',
				name: 'respondWith',
				type: 'options',
				options: [
					{
						name: 'First Incoming Item',
						value: 'firstIncomingItem',
						description: 'Respond with the JSON of the first input item',
					},
					{
						name: 'All Incoming Items',
						value: 'allIncomingItems',
						description: 'Respond with a JSON array of all input items',
					},
					{
						name: 'Custom JSON',
						value: 'json',
						description: 'Respond with a custom JSON body',
					},
				],
				default: 'firstIncomingItem',
				description: 'What data to send back to HalloPetra',
			},
			{
				displayName: 'Response Body',
				name: 'responseBody',
				type: 'json',
				displayOptions: {
					show: {
						respondWith: ['json'],
					},
				},
				default: '{\n  "myField": "value"\n}',
				description: 'The JSON body to send back to HalloPetra',
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
		const items = this.getInputData();

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

		const respondWith = this.getNodeParameter('respondWith', 0) as string;
		const options = this.getNodeParameter('options', 0, {}) as IDataObject;
		const responseCode = (options.responseCode as number) ?? 200;

		let responseBody: IDataObject | IDataObject[];
		if (respondWith === 'json') {
			const rawBody = this.getNodeParameter('responseBody', 0) as IDataObject | string;
			responseBody =
				typeof rawBody === 'string'
					? jsonParse<IDataObject>(rawBody, {
							errorMessage: 'Response Body must be valid JSON',
						})
					: rawBody;
		} else if (respondWith === 'allIncomingItems') {
			responseBody = items.map((item) => item.json);
		} else {
			responseBody = items[0]?.json ?? {};
		}

		this.sendResponse({
			body: responseBody,
			headers: { 'content-type': 'application/json' },
			statusCode: responseCode,
		});

		return [items];
	}
}
