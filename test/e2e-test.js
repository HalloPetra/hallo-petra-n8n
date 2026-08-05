// E2E-Test für n8n-nodes-petra gegen lokales n8n (Port 5678) + Mock-Petra-API (Port 7788).
// Phase 1 (node e2e-test.js phase1): Setup, Sync-Webhook-Test
// Phase 2 (node e2e-test.js phase2): Events-Workflow anlegen + aktivieren, Events einspeisen
// Phase 3 (node e2e-test.js phase3): Poll-/Retry-Ergebnisse prüfen
const fs = require('fs');
const crypto = require('crypto');

const N8N = 'http://localhost:5678';
const MOCK = 'http://localhost:7788';
// n8n läuft im Docker-Container — von dort ist die Mock-API über host.docker.internal erreichbar
const MOCK_FROM_N8N = 'http://host.docker.internal:7788';
const STATE_FILE = __dirname + '/e2e-state.json';

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

let cookie = state.cookie ?? '';

async function api(method, path, body) {
	const res = await fetch(`${N8N}${path}`, {
		method,
		headers: { 'content-type': 'application/json', cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const setCookie = res.headers.get('set-cookie');
	if (setCookie) {
		cookie = setCookie.split(';')[0];
		state.cookie = cookie;
		saveState();
	}
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		json = { raw: text };
	}
	if (!res.ok) {
		throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
	}
	return json;
}

async function mock(method, path, body) {
	const res = await fetch(`${MOCK}${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return await res.json();
}

const check = (name, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) process.exitCode = 1;
};

async function activateWorkflow(workflowId) {
	const workflow = await api('GET', `/rest/workflows/${workflowId}`);
	const wfData = workflow.data ?? workflow;
	if (wfData.active) return;
	await api('POST', `/rest/workflows/${workflowId}/activate`, { versionId: wfData.versionId });
}

async function ensureLogin() {
	if (state.ownerDone) {
		await api('POST', '/rest/login', {
			emailOrLdapLoginId: 'torben@hallopetra.de',
			password: 'Test1234!e2e',
		});
		return;
	}
	await api('POST', '/rest/owner/setup', {
		email: 'torben@hallopetra.de',
		firstName: 'Torben',
		lastName: 'Keller',
		password: 'Test1234!e2e',
	});
	state.ownerDone = true;
	saveState();
}

async function phase1() {
	await ensureLogin();

	// Node-Typen prüfen
	const types = await api('GET', '/types/nodes.json');
	const petraTypes = types
		.filter((t) => t.name.toLowerCase().includes('petra') && !t.name.endsWith('Tool'))
		.map((t) => t.name);
	console.log('Gefundene Petra-Node-Typen:', petraTypes);
	check('Alle 4 Nodes geladen', petraTypes.length === 4, petraTypes.join(', '));
	const triggerType = petraTypes.find((n) => n.endsWith('.petraTrigger'));
	const finishType = petraTypes.find((n) => n.endsWith('.petraFinish'));
	state.prefix = triggerType.split('.')[0];
	saveState();

	// Credential anlegen
	if (!state.credentialId) {
		const credential = await api('POST', '/rest/credentials', {
			name: 'Petra API (Mock)',
			type: 'petraApi',
			data: { apiKey: 'test-key', baseUrl: MOCK_FROM_N8N },
		});
		state.credentialId = credential.data?.id ?? credential.id;
		saveState();
	}
	console.log('Credential:', state.credentialId);

	// Workflow A: Petra Webhook Trigger -> Petra Finish
	if (!state.workflowAId) {
		const workflow = await api('POST', '/rest/workflows', {
			name: 'E2E Sync Webhook',
			nodes: [
				{
					id: crypto.randomUUID(),
					name: 'Petra Webhook Trigger',
					type: triggerType,
					typeVersion: 1,
					position: [0, 0],
					webhookId: crypto.randomUUID(),
					parameters: { hookType: 'pre_call', responseMode: 'responseNode' },
					credentials: { petraApi: { id: state.credentialId, name: 'Petra API (Mock)' } },
				},
				{
					id: crypto.randomUUID(),
					name: 'Petra Finish',
					type: finishType,
					typeVersion: 1,
					position: [300, 0],
					parameters: {
						respondWith: 'json',
						responseBody: '={ "greeting": "Hallo {{ $json.callerNumber }}", "instructions": "sei nett" }',
					},
				},
			],
			connections: {
				'Petra Webhook Trigger': {
					main: [[{ node: 'Petra Finish', type: 'main', index: 0 }]],
				},
			},
			settings: {},
			active: false,
		});
		state.workflowAId = workflow.data?.id ?? workflow.id;
		saveState();
	}
	console.log('Workflow A:', state.workflowAId);

	// Aktivieren
	await activateWorkflow(state.workflowAId);

	// Registrierung am Mock prüfen
	const mockState = await mock('GET', '/_test/state');
	const registered = Object.values(mockState.webhooks);
	check('Webhook bei Petra registriert', registered.length === 1, JSON.stringify(registered));
	const userAgents = [...new Set(mockState.requestLog.map((r) => r.userAgent))];
	check(
		'User-Agent gesetzt',
		userAgents.some((ua) => ua && ua.startsWith('n8n-nodes-petra/')),
		userAgents.join(' | '),
	);

	// Synchroner Aufruf mit korrekter Signatur
	const call = await mock('POST', '/_test/call-webhook', {
		event: 'pre_call',
		payload: { callerNumber: '+491701234567', callId: 'call_1' },
	});
	console.log('Sync-Antwort:', JSON.stringify(call));
	let responseBody = {};
	try {
		responseBody = JSON.parse(call.body);
	} catch {}
	check('Sync-Aufruf: Status 200', call.status === 200, `status=${call.status}`);
	check(
		'Sync-Aufruf: Antwort kommt vom Petra-Finish-Node',
		responseBody.greeting === 'Hallo +491701234567',
		call.body,
	);

	// Aufruf mit falscher Signatur -> 401
	const badCall = await mock('POST', '/_test/call-webhook', {
		event: 'pre_call',
		payload: { callerNumber: 'x' },
		badSignature: true,
	});
	check('Falsche Signatur wird abgelehnt (401)', badCall.status === 401, `status=${badCall.status}`);
}

async function phase2() {
	await ensureLogin();
	const types = await api('GET', '/types/nodes.json');
	const petraTypes = types.filter((t) => t.name.toLowerCase().includes('petra')).map((t) => t.name);
	const eventsType = petraTypes.find((n) => n.endsWith('.petraEventsTrigger'));
	const retryType = petraTypes.find((n) => n.endsWith('.petraEventRetry'));

	if (!state.workflowBId) {
		const workflow = await api('POST', '/rest/workflows', {
			name: 'E2E Events Feed',
			nodes: [
				{
					id: crypto.randomUUID(),
					name: 'Petra Events Trigger',
					type: eventsType,
					typeVersion: 1,
					position: [0, 0],
					parameters: { eventTypes: [], limit: 50, pollTimes: { item: [{ mode: 'everyMinute' }] } },
					credentials: { petraApi: { id: state.credentialId, name: 'Petra API (Mock)' } },
				},
				{
					id: crypto.randomUUID(),
					name: 'Verarbeitung',
					type: 'n8n-nodes-base.code',
					typeVersion: 2,
					position: [300, 0],
					onError: 'continueErrorOutput',
					parameters: {
						mode: 'runOnceForEachItem',
						jsCode: "if ($json.payload.fail) { throw new Error('Verarbeitung fehlgeschlagen'); }\nreturn $json;",
					},
				},
				{
					id: crypto.randomUUID(),
					name: 'Petra Event Retry',
					type: retryType,
					typeVersion: 1,
					position: [600, 200],
					parameters: { maxAttempts: 3 },
				},
				{
					id: crypto.randomUUID(),
					name: 'Erfolg',
					type: 'n8n-nodes-base.noOp',
					typeVersion: 1,
					position: [600, -100],
					parameters: {},
				},
				{
					id: crypto.randomUUID(),
					name: 'Dead Letter',
					type: 'n8n-nodes-base.noOp',
					typeVersion: 1,
					position: [900, 300],
					parameters: {},
				},
			],
			connections: {
				'Petra Events Trigger': { main: [[{ node: 'Verarbeitung', type: 'main', index: 0 }]] },
				Verarbeitung: {
					main: [
						[{ node: 'Erfolg', type: 'main', index: 0 }],
						[{ node: 'Petra Event Retry', type: 'main', index: 0 }],
					],
				},
				'Petra Event Retry': {
					main: [[], [{ node: 'Dead Letter', type: 'main', index: 0 }]],
				},
			},
			settings: {},
			active: false,
		});
		state.workflowBId = workflow.data?.id ?? workflow.id;
		saveState();
	}
	console.log('Workflow B:', state.workflowBId);

	// Events einspeisen BEVOR aktiviert wird, damit der Aktivierungs-Poll sie findet
	await mock('POST', '/_test/events', { id: 'evt_ok', type: 'call.ended', payload: { fail: false, n: 1 } });
	await mock('POST', '/_test/events', { id: 'evt_fail', type: 'call.ended', payload: { fail: true, n: 2 } });

	await activateWorkflow(state.workflowBId);
	console.log('Workflow B aktiviert — warte auf Polls (jede Minute)');
}

async function phase3() {
	await ensureLogin();

	// Executions ansehen
	const executions = await api(
		'GET',
		`/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: state.workflowBId }))}&limit=20`,
	);
	const results = (executions.data?.results ?? executions.data ?? []).map((e) => ({
		id: e.id,
		status: e.status,
		mode: e.mode,
		startedAt: e.startedAt,
	}));
	console.log('Executions Workflow B:', JSON.stringify(results, null, 2));
	check('Mindestens 2 Executions (Erst-Zustellung + Retry-Poll)', results.length >= 2);
	check('Executions erfolgreich (Fehler wurde im Error-Pfad abgefangen)', results.every((e) => e.status === 'success'), JSON.stringify(results.map((e) => e.status)));

	// Static Data des Workflows ansehen
	const workflowB = await api('GET', `/rest/workflows/${state.workflowBId}`);
	const staticData = (workflowB.data ?? workflowB).staticData;
	console.log('Static Data Workflow B:', JSON.stringify(staticData));

	// Mock-Log: wurde evt_fail per ?ids= nachgeladen?
	const mockState = await mock('GET', '/_test/state');
	const idFetches = mockState.requestLog.filter((r) => r.url.includes('ids='));
	console.log('Retry-Fetches (?ids=):', JSON.stringify(idFetches, null, 2));
	check('Fehlgeschlagenes Event wurde per ?ids= nachgeladen', idFetches.some((r) => r.url.includes('evt_fail')));
	const cursorFetches = mockState.requestLog.filter((r) => r.url.includes('after='));
	check('Cursor wird fortgeschrieben (after=-Parameter in Feed-Polls)', cursorFetches.length >= 1, cursorFetches.map((r) => r.url).join(' | '));
}

const phase = process.argv[2];
({ phase1, phase2, phase3 })[phase]().catch((error) => {
	console.error('FEHLER:', error.message);
	process.exit(1);
});
