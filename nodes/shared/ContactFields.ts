import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

/**
 * The contact attributes `POST /contacts` and `PATCH /contacts/{id}` accept.
 * Both endpoints take the same set, so both nodes show the same collection.
 * Options are alphabetical because the n8n linter requires it.
 */
export const contactFieldsProperty: INodeProperties = {
	displayName: 'Contact Fields',
	name: 'contactFields',
	type: 'collection',
	placeholder: 'Add contact field',
	default: {},
	options: [
		{
			displayName: 'Address',
			name: 'address',
			type: 'string',
			default: '',
			description: 'Postal address, e.g. "Musterstraße 1, 12345 Musterstadt"',
		},
		{
			displayName: 'Contact Group IDs',
			name: 'contactGroupIds',
			type: 'string',
			default: '',
			description: 'Comma-separated list of contact group IDs this contact belongs to',
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
			displayName: 'First Name',
			name: 'firstName',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Last Name',
			name: 'lastName',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Name',
			name: 'name',
			type: 'string',
			default: '',
			description:
				'Full name, e.g. "Max Mustermann". Use this when you do not have first and last name separately.',
		},
		{
			displayName: 'Phone',
			name: 'phone',
			type: 'string',
			default: '',
			description:
				'Phone number, e.g. "+491234567890". German numbers may also be given as "0151…".',
		},
		{
			displayName: 'Salutation',
			name: 'salutation',
			type: 'string',
			default: '',
			description: 'Form of address, e.g. "Herr" or "Frau"',
		},
	],
};

/** The contact's own field data — free-form keys, defined per company. */
export const contactFieldDataProperty: INodeProperties = {
	displayName: 'Field Data',
	name: 'fields',
	type: 'fixedCollection',
	typeOptions: {
		multipleValues: true,
	},
	placeholder: 'Add field',
	default: {},
	description:
		'Custom fields stored on the contact. Unknown keys are created automatically; keys are canonicalized to snake_case.',
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
					description: 'Field name in snake_case, e.g. "customer_number"',
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
};

/**
 * Build the request body from both properties. Only keys the user actually
 * filled in are sent — the API rejects unknown keys and an empty string is not
 * the same as "leave it alone".
 */
export function buildContactBody(context: IExecuteFunctions, itemIndex: number): IDataObject {
	const input = context.getNodeParameter('contactFields', itemIndex, {}) as IDataObject;
	const body: IDataObject = {};

	for (const key of [
		'name',
		'salutation',
		'firstName',
		'lastName',
		'phone',
		'email',
		'address',
	] as const) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) {
			body[key] = value.trim();
		}
	}

	const groupIds = ((input.contactGroupIds as string) ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
	if (groupIds.length) {
		body.contactGroupIds = groupIds;
	}

	const entries = context.getNodeParameter('fields.values', itemIndex, []) as Array<{
		key: string;
		value: string;
	}>;
	const fields: IDataObject = {};
	for (const { key, value } of entries) {
		if (key) fields[key] = value;
	}
	if (Object.keys(fields).length) {
		body.fields = fields;
	}

	return body;
}
