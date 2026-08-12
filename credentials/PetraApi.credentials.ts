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
			default: 'https://hallopetra-api.vercel.app',
			placeholder: 'https://hallopetra-api.vercel.app',
			description:
				'Host of the HalloPetra API, without the version — the nodes add "/v1" themselves. Only change this to test against another environment.',
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
	// the endpoint every trigger in this package depends on. The base URL is
	// normalised the same way the nodes do it, so a credential still carrying
	// the old `/v1` suffix tests green instead of failing with a 404.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/, "") }}',
			url: '/v1/webhooks',
			qs: { limit: 1 },
		},
	};
}
