import type { INodeProperties } from 'n8n-workflow';

/**
 * Parameters every Petra trigger carries. Kept here rather than repeated in
 * four node descriptions: the wording is part of the contract with the user,
 * and four copies drift.
 */

/** How the webhook becomes known to HalloPetra. Offered by every trigger. */
export const registrationProperty: INodeProperties = {
	displayName: 'Registration',
	name: 'registration',
	type: 'options',
	options: [
		{
			name: 'Automatic (via HalloPetra API)',
			value: 'automatic',
			description:
				'Register the webhook automatically with HalloPetra when the workflow is published, and remove it again when it is unpublished. Deliveries are verified via HMAC signature.',
		},
		{
			name: 'Manual (Copy URL to HalloPetra)',
			value: 'manual',
			description:
				'Do not call the HalloPetra API. Copy the production webhook URL from this trigger and configure it in the HalloPetra app yourself. Deliveries are not signature-checked.',
		},
	],
	default: 'automatic',
	description: 'How the webhook becomes known to HalloPetra',
};

/**
 * Response parameters for the two synchronous events. Only `call.incoming` and
 * `call.tool` are answered — HalloPetra waits for the reply and works with it.
 * Everything else is fire-and-forget, so those triggers do not offer these.
 */
export const syncResponseProperties: INodeProperties[] = [
	{
		displayName: 'Respond',
		name: 'responseMode',
		type: 'options',
		options: [
			{
				name: 'Using Reply to Petra Node',
				value: 'responseNode',
				description: 'The response is sent by a "Reply to Petra" node in this workflow',
			},
			{
				name: 'When Last Node Finishes',
				value: 'lastNode',
				description: 'The response contains data of the last-executed node',
			},
			{
				name: 'Immediately',
				value: 'onReceived',
				description: 'Respond as soon as the webhook is received, without waiting for the workflow',
			},
		],
		default: 'responseNode',
		description: 'When and how to respond to HalloPetra',
	},
	{
		displayName: 'Response Data',
		name: 'responseData',
		type: 'options',
		displayOptions: {
			show: {
				responseMode: ['lastNode'],
			},
		},
		options: [
			{
				name: 'First Entry JSON',
				value: 'firstEntryJson',
				description: 'Returns the JSON data of the first entry of the last node',
			},
			{
				name: 'All Entries',
				value: 'allEntries',
				description: 'Returns all entries of the last node',
			},
			{
				name: 'No Response Body',
				value: 'noData',
				description: 'Returns without a body',
			},
		],
		default: 'firstEntryJson',
		description: 'What data should be returned when responding with the last node',
	},
];
