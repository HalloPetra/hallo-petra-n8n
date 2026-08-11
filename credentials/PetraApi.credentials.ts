import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class PetraApi implements ICredentialType {
	name = 'petraApi';

	displayName = 'Petra API';

	documentationUrl = 'https://hallopetra.de';

	icon: Icon = { light: 'file:petra.svg', dark: 'file:petra.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'API key created in the HalloPetra app for this integration',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.hallopetra.de/v1',
			description: 'Base URL of the HalloPetra integration API. Only change this for testing.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Listing webhooks is the cheapest call that proves the key works and reaches
	// the endpoint every trigger in this package depends on.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/webhooks',
			qs: { limit: 1 },
		},
	};
}
