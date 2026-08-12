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
	contactFieldsWithoutNameProperty,
	contactNameProperty,
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
			'Adds someone to the HalloPetra contact directory, so Petra knows them by name the next time they call. Returns the new contact including its ID. A name is required — it is what the HalloPetra app lists and searches by.',
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
		properties: [contactNameProperty, contactFieldsWithoutNameProperty, contactFieldDataProperty],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
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
}
