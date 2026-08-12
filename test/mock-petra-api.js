// Mock der HalloPetra-Integrations-API laut Kontrakt im README.
// Start: node mock-petra-api.js  → http://localhost:7788
// Test-Helfer: GET /_test/state (Zustand ansehen), POST /_test/call-webhook (Zustellung auslösen)
const http = require('http');
const crypto = require('crypto');

const PORT = 7788;
const API_KEY = 'test-key';

// Die vier Ereignisse, für die sich ein Workflow registrieren kann. Alles andere
// lehnt POST /webhooks mit 400 ab.
const EVENTS = {
	'call.incoming': { sync: true },
	// Die Registrierung definiert hier das Werkzeug selbst: Name und Abläufe sind
	// Pflicht, `parameters` deklariert, was Petra beim Anrufer erfragt.
	'call.tool': { sync: true, scopeField: 'ablauf_ids', scopeRequired: true, definesTool: true },
	// Die asynchronen Ereignisse lassen sich optional eingrenzen.
	'call.finished': { sync: false, scopeField: 'ablauf_ids' },
	'form.submitted': { sync: false, scopeField: 'formular_ids' },
};
const SCOPE_FIELDS = ['ablauf_ids', 'formular_ids'];

// Feste IDs, damit der E2E-Test gezielt auswählen kann
const ABLAEUFE = [
	{ id: '0c4f8a6e-2b91-4d37-8e5a-6f1d3c7b9a02', title: 'Notdienst-Anfrage aufnehmen', status: 'enabled' },
	{ id: '1d5e9b7f-3ca2-4e48-9f6b-7a2e4d8c0b13', title: 'Termin vereinbaren', status: 'enabled' },
	{ id: '2e6fac80-4db3-4f59-a07c-8b3f5e9d1c24', title: 'Alter Ablauf', status: 'disabled' },
];
const FORMULARE = [
	{ id: '3f70bd91-5ec4-4a6a-b18d-9c4a6f0e2d35', title: 'Rückrufbitte', status: 'enabled' },
	{ id: '4a81cea2-6fd5-4b7b-c29e-0d5b7a1f3e46', title: 'Schadensmeldung', status: 'enabled' },
];
const IDS_BY_SCOPE_FIELD = { ablauf_ids: ABLAEUFE, formular_ids: FORMULARE };

const state = {
	webhooks: {}, // id -> { id, event, url, name, description, ablauf_ids?, formular_ids?, parameters?, secret, createdAt }
	contacts: {}, // id -> Kontakt laut POST /contacts
	// /tasks fehlt bewusst: kein Node im Paket legt noch Aufgaben an.
	requestLog: [], // { method, url, userAgent, time }
};

function json(res, code, body) {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => resolve(data ? JSON.parse(data) : {}));
	});
}

// Fehler-Envelope der echten API: { error: { code, message, requestId } }
const STATUS_BY_CODE = {
	VALIDATION_ERROR: 400,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
};
function apiError(res, code, message) {
	return json(res, STATUS_BY_CODE[code] ?? 400, {
		error: { code, message, requestId: crypto.randomUUID() },
	});
}

// Die Schreib-Endpunkte sind strict: ein vertippter Key darf nicht still
// verschluckt werden, sondern muss die Anfrage ablehnen.
function rejectUnknownKeys(res, body, allowed) {
	const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		apiError(res, 'VALIDATION_ERROR', `Unknown field(s): ${unknown.join(', ')}`);
		return true;
	}
	return false;
}

// Webhook ohne Secret — genau das, was die Lese-Endpunkte zurückgeben.
// Die Eingrenzung fehlt bei unternehmensweiten Registrierungen ganz.
function publicWebhook(w) {
	const out = {
		id: w.id,
		name: w.name,
		url: w.url,
		event: w.event,
		description: w.description,
		active: true,
		createdAt: w.createdAt,
	};
	for (const field of SCOPE_FIELDS) {
		if (w[field]?.length) out[field] = w[field];
	}
	if (w.parameters?.length) out.parameters = w.parameters;
	return out;
}

// Beispiel-Zustellungen in den Formaten, die die echte API schickt.
function samplePayload(event) {
	const now = new Date().toISOString();
	if (event === 'call.tool') {
		// Als einziges Ereignis komplett unter `body` verschachtelt
		return {
			body: {
				webhook_id: 'wh_test',
				call: {
					calling_phone_number: '+491701234567',
					inbound_phone_number: '+4930123456',
					start_time: now,
					call_id: 'call_1',
					duration: 42,
					contact_id: 'c0ffee00-0000-4000-8000-000000000001',
					messages: [
						{ role: 'user', content: 'Wie ist der Stand meines Auftrags?' },
						{ role: 'assistant', content: 'Einen Moment, ich schaue nach.' },
					],
					previous_webhook_calls: [],
				},
				parameter: { auftragsnummer: 'A-4711' },
				fields: { kontakt: { customer_number: 'K-4711' }, prozess: {}, projekt: {} },
			},
			variables: {},
		};
	}
	if (event === 'call.finished') {
		return {
			webhook_id: 'wh_test',
			event,
			data: {
				id: 'call_1',
				duration: 184,
				phone: '+491701234567',
				topic: 'Heizung ausgefallen',
				summary: 'Herr Mustermann meldet einen Totalausfall seiner Gasheizung.',
				messages: [
					{ role: 'assistant', content: 'Mustermann Haustechnik, Sie sprechen mit Petra.' },
					{ role: 'user', content: 'Meine Heizung ist ausgefallen.', secondsFromStart: 4.2 },
				],
				collected_data: { name: 'Max Mustermann', issue_information: 'Fehlercode F28' },
				contact_data: {
					id: 'c0ffee00-0000-4000-8000-000000000001',
					name: 'Max Mustermann',
					phone: '+491701234567',
				},
				email_send_to: null,
				forwarded_to: null,
				main_task_id: ABLAEUFE[0].id,
				previous_webhook_calls: [],
				fields: { kontakt: { customer_number: 'K-4711' }, prozess: {}, projekt: {} },
			},
		};
	}
	if (event === 'form.submitted') {
		return {
			webhook_id: 'wh_test',
			event,
			data: {
				form: { id: FORMULARE[0].id, title: FORMULARE[0].title, slug: 'rueckrufbitte' },
				submission: {
					submitted_at: now,
					data: { name: 'Max Mustermann', anliegen: 'Bitte um Rückruf' },
				},
				contact: {
					id: 'c0ffee00-0000-4000-8000-000000000001',
					name: 'Max Mustermann',
					phone: '+491701234567',
					email: 'max@example.de',
				},
				call: { id: 'call_1', topic: 'Rückrufbitte', summary: 'Kunde bittet um Rückruf', date: now },
			},
		};
	}
	return {
		webhook_id: 'wh_test',
		event: 'call.incoming',
		data: {
			call_id: 'call_1',
			calling_phone_number: '+491701234567',
			inbound_phone_number: '+4930123456',
			start_time: now,
			contact: null,
			fields: { kontakt: { customer_number: 'K-4711' } },
		},
	};
}

// Signierte Zustellung wie die echte API:
// X-HalloPetra-Signature: t=<unixSeconds>,v1=<hex HMAC-SHA256 über "<t>.<rawBody>">
// Ergebnis im Format von POST /webhooks/{id}/test: { ok, status, body, error }.
async function deliverSigned(webhook, payloadObject, { badSignature = false } = {}) {
	const payload = JSON.stringify(payloadObject);
	const t = Math.floor(Date.now() / 1000);
	const hmac = crypto.createHmac('sha256', webhook.secret).update(`${t}.${payload}`).digest('hex');
	const signature = badSignature ? `t=${t},v1=${'f'.repeat(64)}` : `t=${t},v1=${hmac}`;
	const start = Date.now();
	try {
		const response = await fetch(webhook.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-hallopetra-signature': signature },
			body: payload,
		});
		const text = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			body: text,
			durationMs: Date.now() - start,
		};
	} catch (error) {
		return { ok: false, error: error.message, durationMs: Date.now() - start };
	}
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	// Wie die echte API liegt alles unter /v1; die Routen unten führen den
	// Präfix nicht mit. Die Test-Helfer unter /_test bleiben davon unberührt.
	const path = url.pathname.replace(/^\/v1(?=\/|$)/, '');
	state.requestLog.push({
		method: req.method,
		url: req.url,
		userAgent: req.headers['user-agent'],
		time: new Date().toISOString(),
	});
	console.log(`${req.method} ${req.url} ua=${req.headers['user-agent']}`);

	// Test-Helfer ohne Auth
	if (path === '/_test/state' && req.method === 'GET') {
		return json(res, 200, state);
	}
	// Signierten Call an einen registrierten Webhook schicken — dieselbe
	// Zustellung wie POST /webhooks/{id}/test, nur ohne Auth und mit der
	// Möglichkeit, absichtlich falsch zu signieren.
	if (path === '/_test/call-webhook' && req.method === 'POST') {
		const body = await readBody(req);
		const event = body.event ?? 'call.incoming';
		const webhook = Object.values(state.webhooks).find((w) => w.event === event);
		if (!webhook) return json(res, 404, { message: `no webhook registered for ${event}` });
		const result = await deliverSigned(webhook, body.payload ?? samplePayload(event), {
			badSignature: body.badSignature,
		});
		return json(res, result.error ? 502 : 200, result);
	}

	// Ab hier: Auth erforderlich
	if (req.headers.authorization !== `Bearer ${API_KEY}`) {
		return json(res, 401, { message: 'Unauthorized' });
	}

	// Auswahlquellen für die Eingrenzung der asynchronen Trigger
	if (path === '/ablaeufe' && req.method === 'GET') {
		return json(res, 200, { ablaeufe: ABLAEUFE });
	}
	if (path === '/formulare' && req.method === 'GET') {
		return json(res, 200, { formulare: FORMULARE });
	}

	if (path === '/webhooks' && req.method === 'POST') {
		const body = await readBody(req);
		if (
			rejectUnknownKeys(res, body, [
				'url',
				'event',
				'name',
				'description',
				'headers',
				'parameters',
				...SCOPE_FIELDS,
			])
		)
			return;
		const definition = EVENTS[body.event];
		if (!definition) {
			return apiError(
				res,
				'VALIDATION_ERROR',
				`Unknown event "${body.event}". Registrable events: ${Object.keys(EVENTS).join(', ')}.`,
			);
		}
		// Eine Eingrenzung gehört immer zu genau einem Ereignis
		for (const field of SCOPE_FIELDS) {
			if (body[field] === undefined) continue;
			if (field !== definition.scopeField) {
				return apiError(res, 'VALIDATION_ERROR', `${field} is not allowed for "${body.event}"`);
			}
			if (!Array.isArray(body[field]) || !body[field].length || body[field].length > 20) {
				return apiError(res, 'VALIDATION_ERROR', `${field} must hold between 1 and 20 ids`);
			}
			const known = new Set(IDS_BY_SCOPE_FIELD[field].map((row) => row.id));
			const unknown = body[field].filter((id) => !known.has(id));
			if (unknown.length) {
				return apiError(res, 'VALIDATION_ERROR', `Unknown ${field}: ${unknown.join(', ')}`);
			}
		}
		// call.tool ist das einzige Ereignis mit Pflicht-Eingrenzung: ohne Ablauf
		// gäbe es keine Stelle, an der Petra das Werkzeug anbieten könnte.
		if (definition.scopeRequired && !body[definition.scopeField]?.length) {
			return apiError(
				res,
				'VALIDATION_ERROR',
				`${definition.scopeField} is required for "${body.event}"`,
			);
		}
		// Die Registrierung eines Werkzeugs ist zugleich seine Definition
		if (definition.definesTool) {
			if (typeof body.name !== 'string' || !body.name.length) {
				return apiError(res, 'VALIDATION_ERROR', `name is required for "${body.event}"`);
			}
			if (body.parameters !== undefined) {
				if (!Array.isArray(body.parameters) || body.parameters.length > 20) {
					return apiError(res, 'VALIDATION_ERROR', 'parameters must hold at most 20 entries');
				}
				const keys = body.parameters.map((parameter) => parameter?.key);
				if (keys.some((key) => !/^[a-zA-Z0-9_-]{1,64}$/.test(key ?? ''))) {
					return apiError(res, 'VALIDATION_ERROR', 'each parameter needs a valid key');
				}
				if (new Set(keys).size !== keys.length) {
					return apiError(res, 'VALIDATION_ERROR', 'parameter keys must be unique');
				}
			}
		} else if (body.parameters !== undefined) {
			return apiError(res, 'VALIDATION_ERROR', `parameters is not allowed for "${body.event}"`);
		}
		const id = crypto.randomUUID();
		const secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
		state.webhooks[id] = {
			id,
			event: body.event,
			url: body.url,
			name: body.name,
			description: body.description,
			ablauf_ids: body.ablauf_ids,
			formular_ids: body.formular_ids,
			parameters: body.parameters,
			secret,
			createdAt: new Date().toISOString(),
		};
		const scope = definition.scopeField && body[definition.scopeField];
		console.log(
			`  -> registered webhook ${id} for ${body.event}${scope ? ` scoped to ${scope.length}` : ''}: ${body.url}`,
		);
		return json(res, 201, { webhook: publicWebhook(state.webhooks[id]), secret });
	}
	if (path === '/webhooks' && req.method === 'GET') {
		const wantedUrl = url.searchParams.get('url');
		const wantedEvent = url.searchParams.get('event');
		const items = Object.values(state.webhooks)
			.filter((w) => (wantedUrl ? w.url === wantedUrl : true))
			.filter((w) => (wantedEvent ? w.event === wantedEvent : true))
			.map(publicWebhook);
		return json(res, 200, { items, totalCount: items.length });
	}
	// GET/PATCH/DELETE /webhooks/{id}, GET /webhooks/{id}/secret, POST /webhooks/{id}/test
	const webhookMatch = path.match(/^\/webhooks\/([^/]+)(\/secret|\/test)?$/);
	if (webhookMatch) {
		const webhook = state.webhooks[webhookMatch[1]];
		if (!webhook) return apiError(res, 'NOT_FOUND', 'Webhook not found');
		const sub = webhookMatch[2];

		if (!sub && req.method === 'GET') {
			// Die echte API antwortet mit dem Webhook selbst, nicht mit einem Wrapper
			return json(res, 200, publicWebhook(webhook));
		}
		if (!sub && req.method === 'PATCH') {
			const body = await readBody(req);
			// Weder Ereignis noch Eingrenzung noch Werkzeug-Parameter sind änderbar
			if (rejectUnknownKeys(res, body, ['url', 'name', 'description', 'active', 'headers'])) return;
			Object.assign(webhook, body);
			return json(res, 200, publicWebhook(webhook));
		}
		if (!sub && req.method === 'DELETE') {
			delete state.webhooks[webhook.id];
			console.log(`  -> deregistered webhook ${webhook.id}`);
			return json(res, 200, { deleted: true, id: webhook.id });
		}
		if (sub === '/secret' && req.method === 'GET') {
			return json(res, 200, { secret: webhook.secret });
		}
		if (sub === '/test' && req.method === 'POST') {
			// Die echte API baut die Testzustellung mit denselben Buildern wie die
			// Live-Zustellung — gleicher Body, gleiche Signatur.
			const result = await deliverSigned(webhook, samplePayload(webhook.event));
			return json(res, 200, result);
		}
	}
	// Kontakte
	const CONTACT_FIELDS = [
		'name',
		'salutation',
		'firstName',
		'lastName',
		'phone',
		'email',
		'address',
		'contactGroupIds',
		'fields',
	];
	if (path === '/contacts' && req.method === 'POST') {
		const body = await readBody(req);
		if (rejectUnknownKeys(res, body, CONTACT_FIELDS)) return;
		const id = crypto.randomUUID();
		state.contacts[id] = {
			id,
			...body,
			contactGroupIds: body.contactGroupIds ?? [],
			fields: body.fields ?? {},
			createdAt: new Date().toISOString(),
		};
		console.log(`  -> created contact ${id}`);
		return json(res, 201, state.contacts[id]);
	}
	const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
	if (contactMatch && req.method === 'PATCH') {
		const contact = state.contacts[contactMatch[1]];
		if (!contact) return apiError(res, 'NOT_FOUND', 'Contact not found');
		const body = await readBody(req);
		if (rejectUnknownKeys(res, body, CONTACT_FIELDS)) return;
		if (!Object.keys(body).length) {
			return apiError(res, 'VALIDATION_ERROR', 'At least one field is required');
		}
		// `fields` merged pro Key, der Rest wird ersetzt
		const { fields, ...rest } = body;
		Object.assign(contact, rest);
		if (fields) contact.fields = { ...contact.fields, ...fields };
		console.log(`  -> updated contact ${contact.id}: ${Object.keys(body).join(', ')}`);
		return json(res, 200, contact);
	}
	json(res, 404, { message: `No route: ${req.method} ${path}` });
});

server.listen(PORT, () => console.log(`Mock Petra API listening on http://localhost:${PORT}`));
