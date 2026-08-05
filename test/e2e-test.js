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
						contact: {
							name: 'Max Mustermann',
							phone: '={{ $json.callerNumber }}',
						},
						otherData: { values: [{ key: 'data_1', value: 'Wert 1' }] },
						contentType: 'text',
						content: '=Anruf {{ $json.callId }}: sei nett',
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
		'Sync-Aufruf: Antwort im Petra-Agent-Format',
		responseBody.contact?.contact_data_name === 'Max Mustermann' &&
			responseBody.contact?.contact_data_phone === '+491701234567' &&
			responseBody.other_data?.data_1 === 'Wert 1' &&
			responseBody.content === 'Anruf call_1: sei nett',
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
					parameters: { maxAttempts: 3, backoffSeconds: 10 },
					credentials: { petraApi: { id: state.credentialId, name: 'Petra API (Mock)' } },
				},
				{
					id: crypto.randomUUID(),
					name: 'Erfolg',
					type: 'n8n-nodes-base.noOp',
					typeVersion: 1,
					position: [600, -100],
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
	check('Mindestens 3 Executions (Erst-Zustellung + 2 Redeliveries)', results.length >= 3);
	check('Executions erfolgreich (Fehler wurde im Error-Pfad abgefangen)', results.every((e) => e.status === 'success'), JSON.stringify(results.map((e) => e.status)));

	// Static Data des Workflows ansehen (nur noch der Cursor, single writer = Poller)
	const workflowB = await api('GET', `/rest/workflows/${state.workflowBId}`);
	const staticData = (workflowB.data ?? workflowB).staticData;
	console.log('Static Data Workflow B:', JSON.stringify(staticData));

	// Mock-Log: Redeliver-Calls des Retry-Nodes
	const mockState = await mock('GET', '/_test/state');
	const redelivers = mockState.redeliverLog;
	console.log('Redeliver-Log:', JSON.stringify(redelivers));
	// maxAttempts=3: Zustellung 1 und 2 schlagen fehl und werden redelivered (attempt 2, 3),
	// nach Fehlschlag von attempt 3 greift der Cap -> Given Up + Failure-Report.
	check(
		'Fehlgeschlagenes Event wurde redelivered (genau 2x wegen maxAttempts=3)',
		redelivers.length === 2,
		`${redelivers.length} Redeliver-Calls`,
	);
	check(
		'Fibonacci-Backoff: delaySeconds 10 (Basis x1), dann 20 (Basis x2)',
		redelivers[0]?.delaySeconds === 10 && redelivers[1]?.delaySeconds === 20,
		JSON.stringify(redelivers.map((r) => r.delaySeconds)),
	);
	console.log('Failed-Events:', JSON.stringify(mockState.failedEvents));
	const failed = mockState.failedEvents.find((f) => f.id === 'evt_fail');
	check(
		'Endgültiger Fehlschlag wurde an HalloPetra gemeldet (attempts=3, mit Grund)',
		failed?.attempts === 3 && typeof failed?.reason === 'string' && failed.reason.length > 0,
		JSON.stringify(failed),
	);
	const cursorFetches = mockState.requestLog.filter((r) => r.url.includes('after='));
	check('Cursor wird fortgeschrieben (after=-Parameter in Feed-Polls)', cursorFetches.length >= 1, cursorFetches.map((r) => r.url).slice(-3).join(' | '));
	const feedAttempts = mockState.events.filter((e) => e.id === 'evt_fail').map((e) => e.attempt);
	check('Feed enthält evt_fail mit attempt 1, 2, 3', JSON.stringify(feedAttempts) === '[1,2,3]', JSON.stringify(feedAttempts));
}

const phase = process.argv[2];
({ phase1, phase2, phase3 })[phase]().catch((error) => {
	console.error('FEHLER:', error.message);
	process.exit(1);
});
