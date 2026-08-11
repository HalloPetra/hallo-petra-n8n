// E2E-Test für n8n-nodes-hallopetra gegen lokales n8n (Port 5678) + Mock-Petra-API (Port 7788).
//
//   node e2e-test.js run
//
// Alles ist webhook-basiert, also läuft der Test in einem Stück: vier Trigger
// registrieren sich, bekommen je eine signierte Zustellung, und die beiden
// synchronen antworten. Die asynchronen legen eine Aufgabe an — daran ist ohne
// Blick in die n8n-Executions ablesbar, dass die Zustellung ankam.
const fs = require('fs');
const crypto = require('crypto');

const N8N = 'http://localhost:5678';
const MOCK = 'http://localhost:7788';
// n8n läuft im Docker-Container — von dort ist die Mock-API über host.docker.internal erreichbar
const MOCK_FROM_N8N = 'http://host.docker.internal:7788';
const STATE_FILE = __dirname + '/e2e-state.json';

// Zwei der drei Abläufe aus dem Mock — die dritte Auswahl bleibt bewusst außen vor,
// damit die Eingrenzung nachweislich nicht "alles" bedeutet.
const ABLAUF_IDS = ['0c4f8a6e-2b91-4d37-8e5a-6f1d3c7b9a02', '1d5e9b7f-3ca2-4e48-9f6b-7a2e4d8c0b13'];

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Auf einen Zustand im Mock warten — asynchrone Zustellungen laufen nebenläufig. */
async function waitFor(description, predicate, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await mock('GET', '/_test/state');
		if (predicate(last)) return last;
		await sleep(500);
	}
	console.log(`  (Timeout beim Warten auf ${description})`);
	return last;
}

/** Die Aufgaben-IDs, die es jetzt schon gibt. */
async function knownTaskIds() {
	return new Set(Object.keys((await mock('GET', '/_test/state')).tasks));
}

/**
 * Auf die Aufgabe warten, die dieser Durchlauf anlegt. Der Mock läuft über
 * mehrere Testläufe hinweg weiter, also zählt nicht "eine Aufgabe existiert",
 * sondern "eine neue mit dieser Herkunft ist dazugekommen".
 */
async function waitForNewTask(origin, before) {
	const isNew = (task) => task.origin === origin && !before.has(task.id);
	const state = await waitFor(`Aufgabe mit origin=${origin}`, (s) =>
		Object.values(s.tasks).some(isNew),
	);
	return { state, task: Object.values(state.tasks).find(isNew) };
}

const credentials = () => ({ petraApi: { id: state.credentialId, name: 'Petra API (Mock)' } });

const triggerNode = (name, type, parameters) => ({
	id: crypto.randomUUID(),
	name,
	type,
	typeVersion: 1,
	position: [0, 0],
	webhookId: crypto.randomUUID(),
	parameters,
	credentials: credentials(),
});

async function getWorkflow(workflowId) {
	const workflow = await api('GET', `/rest/workflows/${workflowId}`);
	return workflow.data ?? workflow;
}

async function activateWorkflow(workflowId) {
	const wfData = await getWorkflow(workflowId);
	if (wfData.active) return;
	await api('POST', `/rest/workflows/${workflowId}/activate`, { versionId: wfData.versionId });
}

async function deactivateWorkflow(workflowId) {
	const wfData = await getWorkflow(workflowId);
	if (!wfData.active) return;
	await api('POST', `/rest/workflows/${workflowId}/deactivate`, { versionId: wfData.versionId });
}

/**
 * Workflow anlegen — oder einen vorhandenen auf den Soll-Stand zurücksetzen.
 * Ohne das Zurücksetzen liefe ein zweiter Durchlauf auf dem Ergebnis des
 * ersten: der Drift-Test am Ende ändert die Ablauf-Auswahl dauerhaft.
 */
async function ensureWorkflow(key, definition) {
	if (!state[key]) {
		const workflow = await api('POST', '/rest/workflows', {
			settings: {},
			active: false,
			...definition,
		});
		state[key] = workflow.data?.id ?? workflow.id;
		saveState();
	} else {
		// Erst abmelden, dann überschreiben — sonst bliebe die alte Registrierung
		// stehen, denn mit dem Workflow wechselt auch die Webhook-URL.
		await deactivateWorkflow(state[key]);
		const current = await getWorkflow(state[key]);
		await api('PATCH', `/rest/workflows/${state[key]}`, {
			name: definition.name,
			nodes: definition.nodes,
			connections: definition.connections,
			versionId: current.versionId,
		});
	}
	console.log(`${definition.name}:`, state[key]);
	return state[key];
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

async function run() {
	await ensureLogin();

	// ---------------------------------------------------------------- Node-Typen
	const types = await api('GET', '/types/nodes.json');
	const petraTypes = types
		.filter((t) => t.name.toLowerCase().includes('petra') && !t.name.endsWith('Tool'))
		.map((t) => t.name);
	console.log('Gefundene Petra-Node-Typen:', petraTypes);
	check('Alle 8 Nodes geladen', petraTypes.length === 8, petraTypes.join(', '));
	const nodeType = (suffix) => petraTypes.find((n) => n.endsWith(`.${suffix}`));
	const incomingType = nodeType('petraTrigger');
	const inCallType = nodeType('petraInCallTrigger');
	const finishedType = nodeType('petraCallFinishedTrigger');
	const formType = nodeType('petraFormTrigger');
	const finishType = nodeType('petraFinish');
	const contactCreateType = nodeType('petraContactCreate');
	const contactUpdateType = nodeType('petraContactUpdate');
	const taskCreateType = nodeType('petraTaskCreate');

	// ---------------------------------------------------------------- Credential
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

	// ------------------------------------------- A: vor dem Anruf, mit Antwort
	await ensureWorkflow('workflowAId', {
		name: 'E2E Incoming Call',
		nodes: [
			triggerNode('Petra Incoming Call Trigger', incomingType, { responseMode: 'responseNode' }),
			{
				id: crypto.randomUUID(),
				name: 'Reply to Petra',
				type: finishType,
				typeVersion: 1,
				position: [300, 0],
				parameters: {
					respondTo: 'call.incoming',
					fieldsKontakt: {
						values: [{ key: 'customer_number', value: '=K-{{ $json.data.call_id }}' }],
					},
					fieldsProzess: { values: [{ key: 'anliegen', value: 'Heizung tropft' }] },
					instructions: '=Anrufer {{ $json.data.calling_phone_number }} ist Bestandskunde',
				},
			},
		],
		connections: {
			'Petra Incoming Call Trigger': {
				main: [[{ node: 'Reply to Petra', type: 'main', index: 0 }]],
			},
		},
	});

	// ----------------- B: während des Anrufs — Trigger, drei Aktions-Nodes, Antwort.
	// Ein Durchlauf prüft alles auf einmal.
	await ensureWorkflow('workflowBId', {
		name: 'E2E In-Call Tool',
		nodes: [
			triggerNode('Petra In-Call Trigger', inCallType, { responseMode: 'responseNode' }),
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Contact',
				type: contactCreateType,
				typeVersion: 1,
				position: [220, 0],
				parameters: {
					contactFields: {
						name: 'Max Mustermann',
						phone: '={{ $json.body.call.calling_phone_number }}',
					},
					fields: {
						values: [
							{
								key: 'customer_number',
								value: '={{ $json.body.fields.kontakt.customer_number }}',
							},
						],
					},
				},
				credentials: credentials(),
			},
			{
				id: crypto.randomUUID(),
				name: 'Update Petra Contact',
				type: contactUpdateType,
				typeVersion: 1,
				position: [440, 0],
				parameters: {
					contactId: '={{ $json.id }}',
					contactFields: { email: 'max@mustermann.de' },
				},
				credentials: credentials(),
			},
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Task',
				type: taskCreateType,
				typeVersion: 1,
				position: [660, 0],
				parameters: {
					title: 'Rückruf zum Auftrag',
					assignment: 'team',
					additionalFields: { contactId: '={{ $json.id }}', origin: 'n8n-e2e-tool' },
				},
				credentials: credentials(),
			},
			{
				id: crypto.randomUUID(),
				name: 'Reply to Petra',
				type: finishType,
				typeVersion: 1,
				position: [880, 0],
				parameters: {
					respondTo: 'call.tool',
					messageContent: 'Ihr Auftrag ist in Bearbeitung.',
					messageType: 'SAY',
					fieldsKontakt: { values: [{ key: 'customer_number', value: 'K-4711' }] },
					instructions: 'Kunde ist Premiumkunde — biete den Express-Termin an.',
				},
			},
		],
		connections: {
			'Petra In-Call Trigger': { main: [[{ node: 'Create Petra Contact', type: 'main', index: 0 }]] },
			'Create Petra Contact': { main: [[{ node: 'Update Petra Contact', type: 'main', index: 0 }]] },
			'Update Petra Contact': { main: [[{ node: 'Create Petra Task', type: 'main', index: 0 }]] },
			'Create Petra Task': { main: [[{ node: 'Reply to Petra', type: 'main', index: 0 }]] },
		},
	});

	// -------- C: nach dem Anruf, eingegrenzt auf zwei Abläufe, ohne Antwort
	await ensureWorkflow('workflowCId', {
		name: 'E2E Call Finished',
		nodes: [
			triggerNode('Petra Call Finished Trigger', finishedType, {
				fires: 'selected',
				ablaufIds: ABLAUF_IDS,
			}),
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Task',
				type: taskCreateType,
				typeVersion: 1,
				position: [300, 0],
				parameters: {
					title: '=Nachbereitung: {{ $json.data.topic }}',
					assignment: 'team',
					additionalFields: { content: '={{ $json.data.summary }}', origin: 'n8n-e2e-finished' },
				},
				credentials: credentials(),
			},
		],
		connections: {
			'Petra Call Finished Trigger': {
				main: [[{ node: 'Create Petra Task', type: 'main', index: 0 }]],
			},
		},
	});

	// ------------------ D: Formular abgeschickt, unternehmensweit, ohne Antwort
	await ensureWorkflow('workflowDId', {
		name: 'E2E Form Submission',
		nodes: [
			triggerNode('Petra Form Submission Trigger', formType, { fires: 'all' }),
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Task',
				type: taskCreateType,
				typeVersion: 1,
				position: [300, 0],
				parameters: {
					title: '=Formular: {{ $json.form.title }}',
					assignment: 'team',
					additionalFields: {
						content: '={{ $json.submission.data.anliegen }}',
						origin: 'n8n-e2e-form',
					},
				},
				credentials: credentials(),
			},
		],
		connections: {
			'Petra Form Submission Trigger': {
				main: [[{ node: 'Create Petra Task', type: 'main', index: 0 }]],
			},
		},
	});

	for (const key of ['workflowAId', 'workflowBId', 'workflowCId', 'workflowDId']) {
		await activateWorkflow(state[key]);
	}

	// ------------------------------------------------------------ Registrierung
	const registered = Object.values((await mock('GET', '/_test/state')).webhooks);
	const byEvent = Object.fromEntries(registered.map((w) => [w.event, w]));
	check(
		'Alle vier Webhooks registriert',
		registered.length === 4 &&
			['call.incoming', 'call.tool', 'call.finished', 'form_submission'].every((e) => byEvent[e]),
		JSON.stringify(registered.map((w) => w.event)),
	);
	check(
		'Registrierung trägt einen sprechenden Namen fürs Dashboard',
		byEvent['call.tool']?.name?.startsWith('n8n: E2E In-Call Tool ·'),
		byEvent['call.tool']?.name,
	);
	check(
		'call.finished ist auf genau die zwei gewählten Abläufe eingegrenzt',
		JSON.stringify([...(byEvent['call.finished']?.ablauf_ids ?? [])].sort()) ===
			JSON.stringify([...ABLAUF_IDS].sort()),
		JSON.stringify(byEvent['call.finished']?.ablauf_ids),
	);
	check(
		'form_submission ist unternehmensweit registriert (keine Eingrenzung)',
		byEvent['form_submission'] !== undefined && byEvent['form_submission'].form_ids === undefined,
		JSON.stringify(byEvent['form_submission']?.form_ids ?? null),
	);
	const userAgents = [...new Set((await mock('GET', '/_test/state')).requestLog.map((r) => r.userAgent))];
	check(
		'User-Agent gesetzt',
		userAgents.some((ua) => ua && ua.startsWith('n8n-nodes-hallopetra/')),
		userAgents.join(' | '),
	);

	// -------------------------------------------------- Synchron: call.incoming
	const incoming = await mock('POST', '/_test/call-webhook', { event: 'call.incoming' });
	console.log('Sync-Antwort (call.incoming):', JSON.stringify(incoming));
	let incomingBody = {};
	try {
		incomingBody = JSON.parse(incoming.body);
	} catch {}
	check('call.incoming: Status 200', incoming.status === 200, `status=${incoming.status}`);
	check(
		'call.incoming: Antwort ist fields + instructions, ohne message',
		incomingBody.fields?.kontakt?.customer_number === 'K-call_1' &&
			incomingBody.fields?.prozess?.anliegen === 'Heizung tropft' &&
			incomingBody.instructions === 'Anrufer +491701234567 ist Bestandskunde' &&
			incomingBody.message === undefined,
		incoming.body,
	);

	const badCall = await mock('POST', '/_test/call-webhook', {
		event: 'call.incoming',
		badSignature: true,
	});
	check('Falsche Signatur wird abgelehnt (401)', badCall.status === 401, `status=${badCall.status}`);

	// ------------------------------------------------------ Synchron: call.tool
	const beforeTool = await knownTaskIds();
	const tool = await mock('POST', '/_test/call-webhook', { event: 'call.tool' });
	console.log('Sync-Antwort (call.tool):', JSON.stringify(tool));
	let toolBody = {};
	try {
		toolBody = JSON.parse(tool.body);
	} catch {}
	check('call.tool: Status 200', tool.status === 200, `status=${tool.status}`);
	check(
		'call.tool: Antwort trägt message, fields und instructions',
		toolBody.message?.content === 'Ihr Auftrag ist in Bearbeitung.' &&
			toolBody.message?.message_type === 'SAY' &&
			toolBody.fields?.kontakt?.customer_number === 'K-4711' &&
			toolBody.instructions?.startsWith('Kunde ist Premiumkunde'),
		tool.body,
	);

	// Die Aufgabe zeigt auf den Kontakt, den derselbe Durchlauf angelegt hat —
	// darüber ist die ganze Kette ohne Zählerei nachweisbar.
	const { state: afterTool, task: toolTask } = await waitForNewTask('n8n-e2e-tool', beforeTool);
	const contact = afterTool.contacts[toolTask?.contactId];
	check(
		'Kontakt angelegt — mit Telefonnummer und Feld aus dem Anruf',
		contact?.phone === '+491701234567' && contact?.fields?.customer_number === 'K-4711',
		JSON.stringify(contact),
	);
	check(
		'Kontakt aktualisiert — E-Mail ergänzt, Feld aus dem Anlegen erhalten',
		contact?.email === 'max@mustermann.de' && contact?.fields?.customer_number === 'K-4711',
		JSON.stringify(contact),
	);
	check(
		'Aufgabe erstellt — am Kontakt, mit Team-Zuweisung',
		toolTask?.title === 'Rückruf zum Auftrag' && toolTask?.assignment?.type === 'team',
		JSON.stringify(toolTask),
	);

	// --------------------------------------------------- Asynchron: call.finished
	const beforeFinished = await knownTaskIds();
	const finished = await mock('POST', '/_test/call-webhook', { event: 'call.finished' });
	check('call.finished: Status 200', finished.status === 200, `status=${finished.status}`);
	check(
		'call.finished: keine Petra-Antwort im Body — fire-and-forget',
		!JSON.parse(finished.body || '{}').fields && !JSON.parse(finished.body || '{}').message,
		finished.body,
	);
	const { task: finishedTask } = await waitForNewTask('n8n-e2e-finished', beforeFinished);
	check(
		'Nach dem Anruf: Aufgabe aus Thema und Zusammenfassung angelegt',
		finishedTask?.title === 'Nachbereitung: Heizung ausgefallen' &&
			finishedTask?.content?.startsWith('Herr Mustermann meldet'),
		JSON.stringify(finishedTask),
	);

	// ------------------------------------------------- Asynchron: form_submission
	const beforeForm = await knownTaskIds();
	const form = await mock('POST', '/_test/call-webhook', { event: 'form_submission' });
	check('form_submission: Status 200', form.status === 200, `status=${form.status}`);
	const { task: formTask } = await waitForNewTask('n8n-e2e-form', beforeForm);
	check(
		'Formular: Aufgabe aus Formulartitel und Eingabe angelegt',
		formTask?.title === 'Formular: Rückrufbitte' && formTask?.content === 'Bitte um Rückruf',
		JSON.stringify(formTask),
	);

	// ------------------------------------------- Lebenszyklus: Drift und Abmelden
	// Auswahl ändern -> alte Registrierung verwerfen, neu registrieren.
	const workflowC = await getWorkflow(state.workflowCId);
	await deactivateWorkflow(state.workflowCId);
	const patched = workflowC.nodes.map((node) =>
		node.type === finishedType
			? { ...node, parameters: { ...node.parameters, ablaufIds: [ABLAUF_IDS[0]] } }
			: node,
	);
	const current = await getWorkflow(state.workflowCId);
	await api('PATCH', `/rest/workflows/${state.workflowCId}`, {
		nodes: patched,
		connections: workflowC.connections,
		versionId: current.versionId,
	});
	await activateWorkflow(state.workflowCId);
	const afterDrift = Object.values((await mock('GET', '/_test/state')).webhooks).filter(
		(w) => w.event === 'call.finished',
	);
	check(
		'Geänderte Ablauf-Auswahl registriert neu (genau eine Registrierung, ein Ablauf)',
		afterDrift.length === 1 && JSON.stringify(afterDrift[0].ablauf_ids) === JSON.stringify([ABLAUF_IDS[0]]),
		JSON.stringify(afterDrift.map((w) => w.ablauf_ids)),
	);

	// Abmelden beim Deaktivieren
	await deactivateWorkflow(state.workflowDId);
	const afterDeactivate = Object.values((await mock('GET', '/_test/state')).webhooks);
	check(
		'Deaktivieren meldet den Webhook bei Petra ab',
		!afterDeactivate.some((w) => w.event === 'form_submission'),
		JSON.stringify(afterDeactivate.map((w) => w.event)),
	);
	await activateWorkflow(state.workflowDId);
}

const command = process.argv[2] ?? 'run';
const commands = { run };
if (!commands[command]) {
	console.error(`Unbekannter Befehl "${command}". Verfügbar: ${Object.keys(commands).join(', ')}`);
	process.exit(1);
}
commands[command]().catch((error) => {
	console.error('FEHLER:', error.message);
	process.exit(1);
});
