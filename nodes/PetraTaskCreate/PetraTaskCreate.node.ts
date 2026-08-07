import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { petraApiRequest } from '../shared/GenericFunctions';

export class PetraTaskCreate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Create Petra Task',
		name: 'petraTaskCreate',
		icon: { light: 'file:petra.svg', dark: 'file:petra.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["title"]}}',
		description:
			'Puts an Aufgabe on the team\'s list in HalloPetra — what came out of a call, and who takes care of it. Returns the new task including its ID.',
		defaults: {
			name: 'Create Petra Task',
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
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Call back about the leaking heater',
				description: 'What needs to be done, in one line',
			},
			{
				displayName: 'Assign To',
				name: 'assignment',
				type: 'options',
				options: [
					{
						name: 'Team',
						value: 'team',
						description: 'Nobody in particular — the whole team sees it',
					},
					{
						name: 'Member',
						value: 'member',
						description: 'One specific person',
					},
					{
						name: 'Petra',
						value: 'petra',
						description: 'Petra takes care of it herself',
					},
				],
				default: 'team',
				description: 'Who owns this task',
			},
			{
				displayName: 'Member ID',
				name: 'assignmentUserId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						assignment: ['member'],
					},
				},
				default: '',
				description: 'ID of the company member who owns this task',
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				options: [
					{
						displayName: 'Contact ID',
						name: 'contactId',
						type: 'string',
						default: '',
						description: 'Contact this task belongs to, so it shows up on their record',
					},
					{
						displayName: 'Content',
						name: 'content',
						type: 'string',
						typeOptions: {
							rows: 4,
						},
						default: '',
						description: 'The details, as Markdown',
					},
					{
						displayName: 'Due At',
						name: 'dueAt',
						type: 'dateTime',
						default: '',
						description: 'When the task is due',
					},
					{
						displayName: 'Origin',
						name: 'origin',
						type: 'string',
						default: 'n8n',
						description: 'Where this task came from — shown in the HalloPetra dashboard',
					},
					{
						displayName: 'Projekt ID',
						name: 'projektId',
						type: 'string',
						default: '',
						description: 'Projekt (job) this task belongs to',
					},
					{
						displayName: 'Recurrence Rule',
						name: 'recurrenceRule',
						type: 'string',
						default: '',
						placeholder: 'FREQ=WEEKLY;BYDAY=MO',
						description: 'Makes the task recur, as an iCalendar RRULE. Needs a due date.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const title = (this.getNodeParameter('title', itemIndex) as string).trim();
			const assignment = this.getNodeParameter('assignment', itemIndex) as string;
			const userId =
				assignment === 'member'
					? (this.getNodeParameter('assignmentUserId', itemIndex) as string).trim()
					: '';

			const missing = !title
				? new NodeOperationError(this.getNode(), 'Item has no task title', { itemIndex })
				: assignment === 'member' && !userId
					? new NodeOperationError(this.getNode(), 'Item has no member ID', {
							itemIndex,
							description: 'Assigning to a member needs the ID of the company member who owns it',
						})
					: undefined;
			if (missing) {
				if (this.continueOnFail()) {
					results.push({ json: { error: missing.message }, pairedItem: { item: itemIndex } });
					continue;
				}
				throw missing;
			}

			const body: IDataObject = {
				title,
				assignment: assignment === 'member' ? { type: 'member', userId } : { type: assignment },
			};

			const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
			for (const key of [
				'content',
				'dueAt',
				'recurrenceRule',
				'contactId',
				'projektId',
				'origin',
			] as const) {
				const value = additional[key];
				if (typeof value === 'string' && value.trim()) {
					body[key] = value.trim();
				}
			}

			try {
				const task = await petraApiRequest.call(this, 'POST', '/tasks', body);
				results.push({ json: task, pairedItem: { item: itemIndex } });
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
