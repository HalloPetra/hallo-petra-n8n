import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { petraApiRequest } from '../shared/GenericFunctions';
import {
	buildContactBody,
	contactFieldDataProperty,
	contactFieldsProperty,
} from '../shared/ContactFields';

export class PetraContactCreate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Create Petra Contact',
		name: 'petraContactCreate',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: 'create contact',
		description:
			'Adds someone to the HalloPetra contact directory, so Petra knows them by name the next time they call. Returns the new contact including its ID.',
		defaults: {
			name: 'Create Petra Contact',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'petraApi',
				required: true,
			},
		],
		properties: [contactFieldsProperty, contactFieldDataProperty],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const body = buildContactBody(this, itemIndex);
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
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [results];
	}
}
