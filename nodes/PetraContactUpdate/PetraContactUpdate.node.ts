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

export class PetraContactUpdate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Update Petra Contact',
		name: 'petraContactUpdate',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: 'update contact',
		description:
			'Writes what you learned back to a contact in HalloPetra. Only the fields you fill in change; everything else stays as it is. Returns the updated contact.',
		defaults: {
			name: 'Update Petra Contact',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'petraApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				required: true,
				default: '',
				description:
					'Which contact to update. Both Petra triggers carry it: the Petra Incoming Call Trigger in the contact object of its payload, the Petra In-Call Trigger as contact_id on the call. Empty when the caller was unknown.',
			},
			contactFieldsProperty,
			contactFieldDataProperty,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
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
}
