// Mock der HalloPetra-Integrations-API laut Kontrakt im README.
// Start: node mock-petra-api.js  → http://localhost:7788
// Test-Helfer: POST /_test/events (Event einspeisen), GET /_test/state (Zustand ansehen)
const http = require('http');
const crypto = require('crypto');

const PORT = 7788;
const API_KEY = 'test-key';

// Registrierbar sind nur die Webhooks, auf deren Antwort Petra im Anruf wartet:
// call.incoming vor der Begrüßung, call.during als Werkzeug mitten im Gespräch.
// Alles andere kommt aus dem Feed (GET /events) und wird hier mit 400 abgelehnt.
const REGISTRABLE_TYPES = new Set(['call.incoming', 'call.during']);
// call.during ohne Name und Beschreibung wäre für Petra unsichtbar — sie liest
// beides, um zu entscheiden, ob sie das Werkzeug aufruft.
const DURING_CALL_TYPE = 'call.during';

const state = {
	webhooks: {}, // id -> { id, type, url, name, description, secret, createdAt }
	events: [], // { seq, id, type, occurredAt, attempt, payload }
	scheduled: [], // Redeliveries, die erst nach dueAt in den Feed wandern
	redeliverLog: [], // { id, attempt, delaySeconds }
	failedEvents: [], // { id, attempts, reason }
	contacts: {}, // id -> Kontakt laut POST /contacts
	tasks: {}, // id -> Aufgabe laut POST /tasks
	requestLog: [], // { method, url, userAgent, time }
	nextSeq: 1,
};

// Fällige Redeliveries in den Feed übernehmen (Sequenznummer erst jetzt vergeben,
// damit der Cursor monoton bleibt)
function materializeScheduled() {
	const now = Date.now();
	const due = state.scheduled.filter((s) => s.dueAt <= now);
	state.scheduled = state.scheduled.filter((s) => s.dueAt > now);
	for (const { event } of due) {
		state.events.push({ ...event, seq: state.nextSeq++ });
	}
}

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
// Auf der Wire heißt der Integrationspunkt `type`, nicht `event`.
function publicWebhook(w) {
	return {
		id: w.id,
		name: w.name,
		url: w.url,
		type: w.type,
		description: w.description,
		active: true,
		createdAt: w.createdAt,
	};
}

// Beispiel-Zustellungen in den Formaten, die die echte API schickt.
// call.incoming liegt flach unter `data`, call.during komplett unter `body`.
function samplePayload(type) {
	if (type === DURING_CALL_TYPE) {
		return {
			body: {
				webhook_id: 'wh_test',
				call: {
					calling_phone_number: '+491701234567',
					inbound_phone_number: '+4930123456',
					start_time: new Date().toISOString(),
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
				fields: { kontakt: { customer_number: 'K-4711' } },
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
			start_time: new Date().toISOString(),
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
	const path = url.pathname;
	state.requestLog.push({
		method: req.method,
		url: req.url,
		userAgent: req.headers['user-agent'],
		time: new Date().toISOString(),
	});
	console.log(`${req.method} ${req.url} ua=${req.headers['user-agent']}`);

	// Test-Helfer ohne Auth
	if (path === '/_test/events' && req.method === 'POST') {
		const body = await readBody(req);
		const event = {
			seq: state.nextSeq++,
			id: body.id ?? `evt_${state.nextSeq}`,
			type: body.type ?? 'call.finished',
			occurredAt: new Date().toISOString(),
			attempt: 1,
			payload: body.payload ?? { note: 'test event' },
		};
		state.events.push(event);
		return json(res, 201, event);
	}
	if (path === '/_test/state' && req.method === 'GET') {
		return json(res, 200, state);
	}
	// Helfer: signierten Call an einen registrierten Webhook schicken — dieselbe
	// Zustellung wie POST /webhooks/{id}/test, nur ohne Auth und mit der
	// Möglichkeit, absichtlich falsch zu signieren.
	if (path === '/_test/call-webhook' && req.method === 'POST') {
		const body = await readBody(req);
		const type = body.type ?? 'call.incoming';
		const webhook = Object.values(state.webhooks).find((w) => w.type === type);
		if (!webhook) return json(res, 404, { message: `no webhook registered for ${type}` });
		const result = await deliverSigned(webhook, body.payload ?? samplePayload(type), {
			badSignature: body.badSignature,
		});
		return json(res, result.error ? 502 : 200, result);
	}

	// Ab hier: Auth erforderlich
	if (req.headers.authorization !== `Bearer ${API_KEY}`) {
		return json(res, 401, { message: 'Unauthorized' });
	}

	if (path === '/events/types' && req.method === 'GET') {
		return json(res, 200, {
			// `label` ist der deutsche, operator-sichtbare Name aus der echten Registry
			types: [
				{
					name: 'call.incoming',
					label: 'Vor einem Anruf',
					mode: 'sync',
					description: 'Fired synchronously when a call reaches Petra',
				},
				{
					name: 'call.finished',
					label: 'Nach einem Anruf',
					mode: 'async',
					description: 'Fired after a call ends',
				},
				{
					name: 'contact.created',
					label: 'Neuer Kontakt',
					mode: 'async',
					description: 'Fired when a new contact is created',
				},
			],
		});
	}
	if (path === '/webhooks' && req.method === 'POST') {
		const body = await readBody(req);
		if (rejectUnknownKeys(res, body, ['url', 'type', 'name', 'description', 'headers'])) return;
		if (!REGISTRABLE_TYPES.has(body.type)) {
			return apiError(
				res,
				'VALIDATION_ERROR',
				`Unknown webhook type "${body.type}". Registrable webhook types: ${[...REGISTRABLE_TYPES].join(', ')}.`,
			);
		}
		if (body.type === DURING_CALL_TYPE && (!body.name?.trim() || !body.description?.trim())) {
			return apiError(
				res,
				'VALIDATION_ERROR',
				`name and description are required for type "${DURING_CALL_TYPE}"`,
			);
		}
		const id = crypto.randomUUID();
		const secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
		state.webhooks[id] = {
			id,
			type: body.type,
			url: body.url,
			name: body.name,
			description: body.description,
			secret,
			createdAt: new Date().toISOString(),
		};
		console.log(`  -> registered webhook ${id} for ${body.type}: ${body.url}`);
		return json(res, 201, { webhook: publicWebhook(state.webhooks[id]), secret });
	}
	if (path === '/webhooks' && req.method === 'GET') {
		const wantedUrl = url.searchParams.get('url');
		const wantedType = url.searchParams.get('type');
		const items = Object.values(state.webhooks)
			.filter((w) => (wantedUrl ? w.url === wantedUrl : true))
			.filter((w) => (wantedType ? w.type === wantedType : true))
			.map(publicWebhook);
		return json(res, 200, { items, totalCount: items.length });
	}
	// GET/DELETE /webhooks/{id}, GET /webhooks/{id}/secret, POST /webhooks/{id}/test
	const webhookMatch = path.match(/^\/webhooks\/([^/]+)(\/secret|\/test)?$/);
	if (webhookMatch) {
		const webhook = state.webhooks[webhookMatch[1]];
		if (!webhook) return json(res, 404, { message: 'Webhook not found' });
		const sub = webhookMatch[2];

		if (!sub && req.method === 'GET') {
			// Die echte API antwortet mit dem Webhook selbst, nicht mit einem Wrapper
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
			const result = await deliverSigned(webhook, samplePayload(webhook.type));
			return json(res, 200, result);
		}
	}
	// Redeliver: Event erscheint nach delaySeconds erneut im Feed
	const redeliverMatch = path.match(/^\/events\/([^/]+)\/redeliver$/);
	if (redeliverMatch && req.method === 'POST') {
		const body = await readBody(req);
		const original = [...state.events].reverse().find((e) => e.id === redeliverMatch[1]);
		if (!original) return json(res, 404, { message: 'Unknown event' });
		const attempt = body.attempt ?? (original.attempt ?? 1) + 1;
		const delaySeconds = body.delaySeconds ?? 0;
		const { seq, ...event } = original;
		state.scheduled.push({ dueAt: Date.now() + delaySeconds * 1000, event: { ...event, attempt } });
		state.redeliverLog.push({ id: original.id, attempt, delaySeconds });
		console.log(`  -> redeliver ${original.id} as attempt ${attempt} in ${delaySeconds}s`);
		return json(res, 201, { id: original.id, attempt, delaySeconds });
	}
	// Endgültig gescheitertes Event melden (wird dem Nutzer in HalloPetra angezeigt)
	const failedMatch = path.match(/^\/events\/([^/]+)\/failed$/);
	if (failedMatch && req.method === 'POST') {
		const body = await readBody(req);
		state.failedEvents.push({ id: failedMatch[1], attempts: body.attempts, reason: body.reason });
		console.log(`  -> event ${failedMatch[1]} permanently failed after ${body.attempts} attempts: ${body.reason ?? '(no reason)'}`);
		return json(res, 201, { ok: true });
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
	// Aufgaben
	if (path === '/tasks' && req.method === 'POST') {
		const body = await readBody(req);
		if (
			rejectUnknownKeys(res, body, [
				'title',
				'content',
				'dueAt',
				'recurrenceRule',
				'assignment',
				'command',
				'onBehalfOfUserId',
				'projektId',
				'contactId',
				'origin',
			])
		)
			return;
		if (!body.title?.trim()) {
			return apiError(res, 'VALIDATION_ERROR', 'title is required');
		}
		const id = crypto.randomUUID();
		state.tasks[id] = {
			id,
			status: 'open',
			assignment: { type: 'team' },
			...body,
			createdAt: new Date().toISOString(),
		};
		console.log(`  -> created task ${id}: ${body.title}`);
		return json(res, 201, state.tasks[id]);
	}

	if (path === '/events' && req.method === 'GET') {
		materializeScheduled();
		const after = Number(url.searchParams.get('after') ?? 0);
		const limit = Number(url.searchParams.get('limit') ?? 50);
		const types = url.searchParams.get('types');
		let events = state.events.filter((e) => e.seq > after);
		if (types) {
			const wanted = new Set(types.split(','));
			events = events.filter((e) => wanted.has(e.type));
		}
		events = events.slice(0, limit);
		const nextCursor = events.length ? String(events[events.length - 1].seq) : url.searchParams.get('after');
		return json(res, 200, { events: events.map(({ seq, ...e }) => e), nextCursor });
	}

	json(res, 404, { message: `No route: ${req.method} ${path}` });
});

server.listen(PORT, () => console.log(`Mock Petra API listening on http://localhost:${PORT}`));
