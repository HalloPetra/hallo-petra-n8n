// E2E-Test für n8n-nodes-hallopetra gegen lokales n8n (Port 5678) + Mock-Petra-API (Port 7788).
//
//   node e2e-test.js run
//
// Alles ist webhook-basiert, also läuft der Test in einem Stück: der Trigger
// registriert sich viermal (einmal je Event), bekommt je eine signierte
// Zustellung, und die beiden synchronen Events antworten. Die asynchronen
// legen einen Kontakt an — daran ist ohne Blick in die n8n-Executions
// ablesbar, dass die Zustellung ankam.
const fs = require('fs');
const crypto = require('crypto');

// Überschreibbar, damit der Test neben einer laufenden Entwicklungsinstanz auf
// einem zweiten Port laufen kann, statt ihr die Workflows umzuschreiben:
//   N8N_URL=http://localhost:5679 E2E_STATE=… node test/e2e-test.js run
const N8N = process.env.N8N_URL ?? 'http://localhost:5678';
const MOCK = process.env.MOCK_URL ?? 'http://localhost:7788';
// n8n läuft im Docker-Container — von dort ist die Mock-API über host.docker.internal erreichbar
const MOCK_FROM_N8N = process.env.MOCK_URL_FROM_N8N ?? 'http://host.docker.internal:7788';
const STATE_FILE = process.env.E2E_STATE ?? __dirname + '/e2e-state.json';

// Zwei der drei Call-Flows aus dem Mock — der dritte bleibt bewusst außen vor,
// damit die Eingrenzung nachweislich nicht "alles" bedeutet.
const CALL_FLOW_IDS = [
	'0c4f8a6e-2b91-4d37-8e5a-6f1d3c7b9a02',
	'1d5e9b7f-3ca2-4e48-9f6b-7a2e4d8c0b13',
];

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

/** Die Kontakt-IDs, die es jetzt schon gibt. */
async function knownContactIds() {
	return new Set(Object.keys((await mock('GET', '/_test/state')).contacts));
}

/**
 * Auf den Kontakt warten, den dieser Durchlauf anlegt — der Nachweis, dass eine
 * asynchrone Zustellung wirklich angekommen ist und den Workflow durchlaufen
 * hat. Der Mock läuft über mehrere Testläufe hinweg weiter, also zählt nicht
 * "ein Kontakt mit dem Namen existiert", sondern "ein neuer ist dazugekommen".
 */
async function waitForNewContact(name, before) {
	const isNew = (contact) => contact.name === name && !before.has(contact.id);
	const state = await waitFor(`Kontakt "${name}"`, (s) =>
		Object.values(s.contacts).some(isNew),
	);
	return { state, contact: Object.values(state.contacts).find(isNew) };
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
	check('Beide Nodes geladen', petraTypes.length === 2, petraTypes.join(', '));
	const nodeType = (suffix) => petraTypes.find((n) => n.endsWith(`.${suffix}`));
	const triggerType = nodeType('petraTrigger');
	const actionType = nodeType('petra');

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
			triggerNode('HalloPetra Trigger', triggerType, {
				event: 'call.incoming',
				responseMode: 'responseNode',
			}),
			{
				id: crypto.randomUUID(),
				name: 'Reply to Petra',
				type: actionType,
				typeVersion: 1,
				position: [300, 0],
				parameters: {
					resource: 'call',
					operation: 'reply',
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
			'HalloPetra Trigger': {
				main: [[{ node: 'Reply to Petra', type: 'main', index: 0 }]],
			},
		},
	});

	// ----------------- B: während des Anrufs — Trigger, drei Aktions-Nodes, Antwort.
	// Ein Durchlauf prüft alles auf einmal.
	await ensureWorkflow('workflowBId', {
		name: 'E2E In-Call Tool',
		nodes: [
			// Die Registrierung ist zugleich die Werkzeugdefinition: Name, Anweisung,
			// die Call-Flows, an denen Petra es findet, und ihre Argumente.
			triggerNode('HalloPetra Trigger', triggerType, {
				event: 'call.tool',
				responseMode: 'responseNode',
				toolName: 'Auftragsstatus nachschlagen',
				toolDescription: 'Schlägt den Status eines Auftrags nach, wenn der Anrufer danach fragt.',
				callFlowIds: CALL_FLOW_IDS,
				parameters: {
					values: [
						{
							key: 'auftragsnummer',
							label: 'Auftragsnummer',
							description: 'Die Auftragsnummer, nach der der Anrufer fragt.',
						},
					],
				},
			}),
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Contact',
				type: actionType,
				typeVersion: 1,
				position: [220, 0],
				parameters: {
					resource: 'contact',
					operation: 'create',
					// Der Name ist ein eigenes Pflichtfeld, nicht Teil der Collection:
					// ohne ihn legt die API zwar an, aber die HalloPetra-App zeigt
					// den Kontakt nirgends.
					name: 'Max Mustermann',
					contactFields: {
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
				type: actionType,
				typeVersion: 1,
				position: [440, 0],
				parameters: {
					resource: 'contact',
					operation: 'update',
					contactId: '={{ $json.id }}',
					contactFields: { email: 'max@mustermann.de' },
				},
				credentials: credentials(),
			},
			{
				id: crypto.randomUUID(),
				name: 'Reply to Petra',
				type: actionType,
				typeVersion: 1,
				position: [660, 0],
				parameters: {
					resource: 'call',
					operation: 'reply',
					respondTo: 'call.tool',
					messageContent: 'Ihr Auftrag ist in Bearbeitung.',
					fieldsKontakt: { values: [{ key: 'customer_number', value: 'K-4711' }] },
					instructions: 'Kunde ist Premiumkunde — biete den Express-Termin an.',
				},
			},
		],
		connections: {
			'HalloPetra Trigger': { main: [[{ node: 'Create Petra Contact', type: 'main', index: 0 }]] },
			'Create Petra Contact': { main: [[{ node: 'Update Petra Contact', type: 'main', index: 0 }]] },
			'Update Petra Contact': { main: [[{ node: 'Reply to Petra', type: 'main', index: 0 }]] },
		},
	});

	// -------- C: nach dem Anruf, eingegrenzt auf zwei Call-Flows, ohne Antwort
	await ensureWorkflow('workflowCId', {
		name: 'E2E Call Finished',
		nodes: [
			triggerNode('HalloPetra Trigger', triggerType, {
				event: 'call.finished',
				fires: 'selected',
				callFlowIds: CALL_FLOW_IDS,
			}),
			// Der angelegte Kontakt ist der Nachweis, dass die Zustellung ankam:
			// asynchrone Ereignisse antworten nicht, also braucht es eine Spur.
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Contact',
				type: actionType,
				typeVersion: 1,
				position: [300, 0],
				parameters: {
					resource: 'contact',
					operation: 'create',
					name: '=Nachbereitung: {{ $json.data.topic }}',
					contactFields: { phone: '={{ $json.data.phone }}' },
				},
				credentials: credentials(),
			},
		],
		connections: {
			'HalloPetra Trigger': {
				main: [[{ node: 'Create Petra Contact', type: 'main', index: 0 }]],
			},
		},
	});

	// ------------------ D: Formular abgeschickt, unternehmensweit, ohne Antwort
	await ensureWorkflow('workflowDId', {
		name: 'E2E Form Submission',
		nodes: [
			triggerNode('HalloPetra Trigger', triggerType, { event: 'form.submitted', fires: 'all' }),
			{
				id: crypto.randomUUID(),
				name: 'Create Petra Contact',
				type: actionType,
				typeVersion: 1,
				position: [300, 0],
				parameters: {
					resource: 'contact',
					operation: 'create',
					name: '=Formular: {{ $json.data.form.title }}',
					contactFields: { email: '={{ $json.data.contact.email }}' },
				},
				credentials: credentials(),
			},
		],
		connections: {
			'HalloPetra Trigger': {
				main: [[{ node: 'Create Petra Contact', type: 'main', index: 0 }]],
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
			['call.incoming', 'call.tool', 'call.finished', 'form.submitted'].every((e) => byEvent[e]),
		JSON.stringify(registered.map((w) => w.event)),
	);
	check(
		'Registrierung trägt einen sprechenden Namen fürs Dashboard',
		byEvent['call.finished']?.name?.startsWith('n8n: E2E Call Finished ·'),
		byEvent['call.finished']?.name,
	);
	// call.tool ist der Sonderfall: die Registrierung IST die Werkzeugdefinition.
	const registeredTool = byEvent['call.tool'];
	check(
		'call.tool registriert Name und Anweisung, die Petra liest',
		registeredTool?.name === 'Auftragsstatus nachschlagen' &&
			registeredTool?.description?.startsWith('Schlägt den Status'),
		JSON.stringify({ name: registeredTool?.name, description: registeredTool?.description }),
	);
	check(
		'call.tool hängt an genau den zwei gewählten Call-Flows',
		JSON.stringify([...(registeredTool?.callFlowIds ?? [])].sort()) ===
			JSON.stringify([...CALL_FLOW_IDS].sort()),
		JSON.stringify(registeredTool?.callFlowIds),
	);
	check(
		'call.tool deklariert das Argument, das Petra beim Anrufer erfragt',
		registeredTool?.parameters?.length === 1 &&
			registeredTool.parameters[0].key === 'auftragsnummer' &&
			registeredTool.parameters[0].label === 'Auftragsnummer',
		JSON.stringify(registeredTool?.parameters),
	);
	check(
		'call.finished ist auf genau die zwei gewählten Call-Flows eingegrenzt',
		JSON.stringify([...(byEvent['call.finished']?.callFlowIds ?? [])].sort()) ===
			JSON.stringify([...CALL_FLOW_IDS].sort()),
		JSON.stringify(byEvent['call.finished']?.callFlowIds),
	);
	check(
		'form.submitted ist unternehmensweit registriert (keine Eingrenzung)',
		byEvent['form.submitted'] !== undefined && byEvent['form.submitted'].formIds === undefined,
		JSON.stringify(byEvent['form.submitted']?.formIds ?? null),
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
	const beforeTool = await knownContactIds();
	const tool = await mock('POST', '/_test/call-webhook', { event: 'call.tool' });
	console.log('Sync-Antwort (call.tool):', JSON.stringify(tool));
	let toolBody = {};
	try {
		toolBody = JSON.parse(tool.body);
	} catch {}
	check('call.tool: Status 200', tool.status === 200, `status=${tool.status}`);
	check(
		'call.tool: Antwort trägt message, fields und instructions',
		toolBody.message === 'Ihr Auftrag ist in Bearbeitung.' &&
			toolBody.fields?.kontakt?.customer_number === 'K-4711' &&
			toolBody.instructions?.startsWith('Kunde ist Premiumkunde'),
		tool.body,
	);

	// Der Kontakt dieses Durchlaufs trägt beide Schritte der Kette: angelegt vom
	// Create-Node, um die E-Mail ergänzt vom Update-Node.
	const { contact } = await waitForNewContact('Max Mustermann', beforeTool);
	check(
		'Kontakt angelegt — mit Name, Telefonnummer und Feld aus dem Anruf',
		contact?.phone === '+491701234567' && contact?.fields?.customer_number === 'K-4711',
		JSON.stringify(contact),
	);
	check(
		'Kontakt aktualisiert — E-Mail ergänzt, Feld aus dem Anlegen erhalten',
		contact?.email === 'max@mustermann.de' && contact?.fields?.customer_number === 'K-4711',
		JSON.stringify(contact),
	);

	// --------------------------------------------------- Asynchron: call.finished
	const beforeFinished = await knownContactIds();
	const finished = await mock('POST', '/_test/call-webhook', { event: 'call.finished' });
	check('call.finished: Status 200', finished.status === 200, `status=${finished.status}`);
	check(
		'call.finished: keine Petra-Antwort im Body — fire-and-forget',
		!JSON.parse(finished.body || '{}').fields && !JSON.parse(finished.body || '{}').message,
		finished.body,
	);
	const { contact: finishedContact } = await waitForNewContact(
		'Nachbereitung: Heizung ausgefallen',
		beforeFinished,
	);
	check(
		'Nach dem Anruf: Workflow lief, Daten aus der Zustellung angekommen',
		finishedContact?.phone === '+491701234567',
		JSON.stringify(finishedContact),
	);

	// ------------------------------------------------- Asynchron: form.submitted
	const beforeForm = await knownContactIds();
	const form = await mock('POST', '/_test/call-webhook', { event: 'form.submitted' });
	check('form.submitted: Status 200', form.status === 200, `status=${form.status}`);
	const { contact: formContact } = await waitForNewContact('Formular: Rückrufbitte', beforeForm);
	check(
		'Formular: Workflow lief, Daten aus der Einreichung angekommen',
		formContact?.email === 'max@example.de',
		JSON.stringify(formContact),
	);

	// ------------------------------------------- Lebenszyklus: Drift und Abmelden
	// Auswahl ändern -> alte Registrierung verwerfen, neu registrieren.
	const workflowC = await getWorkflow(state.workflowCId);
	await deactivateWorkflow(state.workflowCId);
	// Der Trigger-Typ allein reicht nicht mehr — im Workflow steht nur einer,
	// aber sicherheitshalber zusätzlich am Event festmachen.
	const patched = workflowC.nodes.map((node) =>
		node.type === triggerType && node.parameters.event === 'call.finished'
			? { ...node, parameters: { ...node.parameters, callFlowIds: [CALL_FLOW_IDS[0]] } }
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
		'Geänderte Call-Flow-Auswahl registriert neu (genau eine Registrierung, ein Call-Flow)',
		afterDrift.length === 1 &&
			JSON.stringify(afterDrift[0].callFlowIds) === JSON.stringify([CALL_FLOW_IDS[0]]),
		JSON.stringify(afterDrift.map((w) => w.callFlowIds)),
	);

	// Abmelden beim Deaktivieren
	await deactivateWorkflow(state.workflowDId);
	const afterDeactivate = Object.values((await mock('GET', '/_test/state')).webhooks);
	check(
		'Deaktivieren meldet den Webhook bei Petra ab',
		!afterDeactivate.some((w) => w.event === 'form.submitted'),
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
