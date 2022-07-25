import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class SyncroMspApi implements ICredentialType {
	name = 'syncroMspApi';
	displayName = 'SyncroMSP API';
	documentationUrl = 'syncromsp';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Subdomain',
			name: 'subdomain',
			type: 'string',
			default: '',
		},
	];
}
