// Mock der HalloPetra-Integrations-API laut Kontrakt im README.
// Start: node mock-petra-api.js  → http://localhost:7788
// Test-Helfer: POST /_test/events (Event einspeisen), GET /_test/state (Zustand ansehen)
const http = require('http');
const crypto = require('crypto');

const PORT = 7788;
const API_KEY = 'test-key';

const state = {
	webhooks: {}, // id -> { id, event, url, secret }
	events: [], // { seq, id, type, occurredAt, payload }
	requestLog: [], // { method, url, userAgent, time }
	nextWebhookId: 1,
	nextSeq: 1,
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
			type: body.type ?? 'call.ended',
			occurredAt: new Date().toISOString(),
			payload: body.payload ?? { note: 'test event' },
		};
		state.events.push(event);
		return json(res, 201, event);
	}
	if (path === '/_test/state' && req.method === 'GET') {
		return json(res, 200, state);
	}
	// Helfer: signierten Call an einen registrierten Webhook schicken
	if (path === '/_test/call-webhook' && req.method === 'POST') {
		const body = await readBody(req);
		const webhook = Object.values(state.webhooks).find((w) => w.event === (body.event ?? 'pre_call'));
		if (!webhook) return json(res, 404, { message: 'no webhook registered' });
		const payload = JSON.stringify(body.payload ?? { caller: '+491701234567', callId: 'call_1' });
		const signature = crypto.createHmac('sha256', webhook.secret).update(payload).digest('hex');
		const start = Date.now();
		try {
			const response = await fetch(webhook.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-petra-signature': body.badSignature ? 'ffff' : signature },
				body: payload,
			});
			const text = await response.text();
			return json(res, 200, { status: response.status, durationMs: Date.now() - start, body: text });
		} catch (error) {
			return json(res, 502, { message: error.message });
		}
	}

	// Ab hier: Auth erforderlich
	if (req.headers.authorization !== `Bearer ${API_KEY}`) {
		return json(res, 401, { message: 'Unauthorized' });
	}

	if (path === '/me' && req.method === 'GET') {
		return json(res, 200, { company: 'Testbetrieb GmbH' });
	}
	if (path === '/webhook-types' && req.method === 'GET') {
		return json(res, 200, {
			types: [{ slug: 'pre_call', label: 'Pre-Call', description: 'Before an outbound call starts' }],
		});
	}
	if (path === '/event-types' && req.method === 'GET') {
		return json(res, 200, {
			types: [
				{ slug: 'call.ended', label: 'Call Ended' },
				{ slug: 'call.missed', label: 'Call Missed' },
			],
		});
	}
	if (path === '/webhooks' && req.method === 'POST') {
		const body = await readBody(req);
		const id = `wh_${state.nextWebhookId++}`;
		const secret = crypto.randomBytes(16).toString('hex');
		state.webhooks[id] = { id, event: body.event, url: body.url, secret };
		console.log(`  -> registered webhook ${id} for ${body.event}: ${body.url}`);
		return json(res, 201, { id, secret });
	}
	const webhookMatch = path.match(/^\/webhooks\/([^/]+)$/);
	if (webhookMatch) {
		const webhook = state.webhooks[webhookMatch[1]];
		if (!webhook) return json(res, 404, { message: 'Not found' });
		if (req.method === 'GET') {
			return json(res, 200, { id: webhook.id, event: webhook.event, url: webhook.url });
		}
		if (req.method === 'DELETE') {
			delete state.webhooks[webhook.id];
			console.log(`  -> deregistered webhook ${webhook.id}`);
			return json(res, 204, {});
		}
	}
	if (path === '/events' && req.method === 'GET') {
		const ids = url.searchParams.get('ids');
		if (ids) {
			const wanted = new Set(ids.split(','));
			const events = state.events.filter((e) => wanted.has(e.id));
			return json(res, 200, { events: events.map(({ seq, ...e }) => e) });
		}
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
