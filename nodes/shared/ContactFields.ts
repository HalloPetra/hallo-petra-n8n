import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

/**
 * `name` when creating a contact: its own required field rather than one
 * option among many. The HalloPetra contact list and its search go by this
 * field, and the API neither derives it from first and last name nor complains
 * when it is missing — a contact without one is stored and answered with an id,
 * but stays invisible in the app. A collection cannot mark an option required,
 * so the field has to sit outside it.
 */
export const contactNameProperty: INodeProperties = {
	displayName: 'Name',
	name: 'name',
	type: 'string',
	default: '',
	required: true,
	placeholder: 'Jane Doe',
	description:
		'The name HalloPetra lists and searches this contact by. For a person the full name, for a company its name. First and last name below are stored in addition, but the app does not build the name from them.',
};

/**
 * The contact attributes `POST /contacts` and `PATCH /contacts/{id}` accept.
 * Both endpoints take the same set, so both operations show the same
 * collection. Options are alphabetical because the n8n linter requires it.
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
			description: 'Postal address, e.g. "123 Main Street, Springfield, IL 62701"',
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
				'Full name, e.g. "Jane Doe". Use this when you do not have first and last name separately.',
		},
		{
			displayName: 'Phone',
			name: 'phone',
			type: 'string',
			default: '',
			description: 'Phone number in international format, e.g. "+491234567890"',
		},
		{
			displayName: 'Salutation',
			name: 'salutation',
			type: 'string',
			default: '',
			description: 'Form of address, e.g. "Mr" or "Ms"',
		},
	],
};

/**
 * The same collection for the create operation, where `name` is a required
 * field of its own and would otherwise be offered twice.
 */
export const contactFieldsWithoutNameProperty: INodeProperties = {
	...contactFieldsProperty,
	options: (contactFieldsProperty.options as INodeProperties[]).filter(
		(option) => option.name !== 'name',
	),
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

	// The create operation carries `name` outside the collection, the update
	// operation inside it. Reading both keeps one builder for both; the
	// dedicated field wins, because it is the one the user was required to fill in.
	const separateName = context.getNodeParameter('name', itemIndex, '') as string;
	if (typeof separateName === 'string' && separateName.trim()) {
		body.name = separateName.trim();
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
