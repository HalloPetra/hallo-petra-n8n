// Protokollierendes Proxy zwischen n8n und der HalloPetra-API. Zeigt jeden
// Aufruf mit Body, Status und Antwort — die Stelle, an der sonst nur eine
// generische Fehlermeldung im Node ankommt.
//
//   node test/api-proxy.js [ziel-basis-url]
//
// In n8n die Basis-URL der Credential auf http://host.docker.internal:7789
// stellen (aus dem Container heraus) bzw. http://localhost:7789 (ohne Docker).
// Die Nodes hängen /v1 selbst an, das Proxy reicht den Pfad unverändert weiter.
const http = require('http');

const PORT = 7789;
const TARGET = (process.argv[2] ?? 'https://hallopetra-api.vercel.app').replace(/\/+$/, '');

const c = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function pretty(text) {
	if (!text) return '(leer)';
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/** Nur die Existenz des Schlüssels ist interessant, nicht sein Wert. */
function maskedHeaders(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		if (k === 'host' || k === 'content-length' || k === 'connection') continue;
		out[k] = k === 'authorization' ? String(v).slice(0, 12) + '…' : v;
	}
	return out;
}

let counter = 0;

const server = http.createServer(async (req, res) => {
	const n = ++counter;
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = Buffer.concat(chunks);
	const started = Date.now();

	console.log(`\n${c.bold(`──── #${n}  ${req.method} ${req.url}`)}`);
	console.log(c.dim(`     ${JSON.stringify(maskedHeaders(req.headers))}`));
	if (body.length) console.log(`${c.dim('     Request:')}\n${pretty(body.toString('utf8'))}`);

	try {
		const upstream = await fetch(`${TARGET}${req.url}`, {
			method: req.method,
			headers: Object.fromEntries(
				Object.entries(req.headers).filter(([k]) => !['host', 'content-length'].includes(k)),
			),
			body: body.length ? body : undefined,
		});
		const text = await upstream.text();
		const ms = Date.now() - started;
		const tag = upstream.ok ? c.green(`${upstream.status} OK`) : c.red(`${upstream.status} FEHLER`);
		console.log(`     -> ${tag} ${c.dim(`in ${ms} ms`)}`);
		if (!upstream.ok || text) console.log(`${c.dim('     Antwort:')}\n${pretty(text)}`);

		// Die requestId der API ist der Schlüssel zum serverseitigen Log
		try {
			const id = JSON.parse(text)?.error?.requestId;
			if (id) console.log(c.bold(`     requestId: ${id}`));
		} catch {}

		res.writeHead(upstream.status, {
			'content-type': upstream.headers.get('content-type') ?? 'application/json',
		});
		res.end(text);
	} catch (error) {
		console.log(`     -> ${c.red('Verbindung fehlgeschlagen')}: ${error.message}`);
		res.writeHead(502, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: { code: 'PROXY_ERROR', message: error.message } }));
	}
});

server.listen(PORT, () => {
	console.log(`Proxy auf http://localhost:${PORT}  ->  ${TARGET}`);
	console.log('Basis-URL der Credential in n8n hierauf zeigen lassen.\n');
});
