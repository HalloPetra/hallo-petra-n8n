# @hallopetra/n8n-nodes-hallopetra

n8n community node package that connects [HalloPetra](https://hallopetra.de) — the digital office worker for trade businesses — to n8n workflows. Petra answers the phone when nobody else can, notes what the call was about, and leaves nobody on hold.

This package lets your workflows join in, in two ways:

1. **Before the call:** While the phone is still ringing, HalloPetra calls a webhook registered in n8n and waits for the answer — for example the customer record looked up in your CRM. Petra greets the caller by name instead of asking who is speaking.
2. **After the call:** Workflows react to what Petra did (finished calls, new contacts, booked appointments, form submissions), delivered through a polled event feed with built-in retry handling. The caller ends up as a contact in your accounting software, the summary as an email in the office — nobody types up notes in the evening.

## Installation

1. In n8n, go to **Settings → Community Nodes → Install** and enter `@hallopetra/n8n-nodes-hallopetra`.
2. In the HalloPetra app, create an API key for the integration (format `hp_ck_…`).
3. In n8n, create a **Petra API** credential and paste the key. The default base URL is `https://api.hallopetra.de/v1`. Use **Test** to confirm the connection.
4. Add a Petra trigger to a workflow, select the credential and publish the workflow — webhook registration happens automatically.

## Nodes

### Petra Webhook Trigger (synchronous)

Starts the workflow when HalloPetra calls the registered webhook. When the workflow is published, the node registers a webhook through the HalloPetra API — visible in your HalloPetra dashboard under the workflow's name — and removes it again when the workflow is unpublished. Select the hook type (for example `call.incoming`) from the dropdown, which loads the available synchronous event types from your account.

Incoming deliveries are verified with an HMAC signature (see [API contract](#api-contract)). If you prefer to configure the webhook URL manually in the HalloPetra app, set **Registration** to *Manual* — the node then skips both the API call and the signature check.

**Respond** controls how the answer is produced: through a *Petra Finish* node (default), with the output of the last executed node, or immediately without waiting for the workflow.

> **You have 2.5 seconds.** Petra waits at most 2500 ms for the response — there is no setting to extend this, because a caller is on the line. Keep the workflow to a single lookup and nothing else. n8n's own execution start-up latency counts towards that budget, so a queue-mode instance under load leaves noticeably less room than a warm one.
>
> **Nothing is ever lost if you miss it.** If the workflow is too slow, fails, or finds nothing, Petra simply greets the caller normally and carries on without the extra data. The call is never dropped and the caller never waits. The worst case is a generic greeting instead of a personal one — which is exactly what happens for every first-time caller anyway.

> **Self-hosted:** Your n8n instance must know its public URL (`WEBHOOK_URL` environment variable, especially behind a reverse proxy). Otherwise n8n registers an unreachable address with HalloPetra. On n8n Cloud this works out of the box.

### Petra Finish

Sends the synchronous response back to HalloPetra in exactly the format Petra expects:

```json
{
  "contact": {
    "contact_data_name": "Max Mustermann",
    "contact_data_email": "max@example.com",
    "contact_data_phone": "+491234567890",
    "contact_data_address": "Musterstraße 1, 12345 Musterstadt"
  },
  "other_data": { "data_1": "value 1" },
  "content": "Free-form context for Petra, in plain language",
  "fields": { "kontakt": {}, "prozess": {}, "projekt": {} }
}
```

Fill in the contact fields and arbitrary key-value pairs (**Other Data**) with what you looked up. Anything that does not fit a field belongs in **Content** (None/Text/JSON) as a plain sentence — *"Regular customer, heating last serviced in March."* Expressions work in every field.

Under advanced options, **Persist Fields** behaves differently from everything else here: those values do not go into the conversation. They tell HalloPetra to store them permanently on the contact, the running process or the project.

**All sections are optional:** anything left empty is omitted from the response entirely. This is a terminal node without outputs — it marks the end of the synchronous part. To run additional steps after responding (logging, for instance), branch off *before* this node; the response is sent the moment the node runs.

### Petra Events Trigger (polling)

Polls the HalloPetra event feed (at most once per minute) and starts the workflow with a batch of new events. Every item carries `_petra` metadata (`eventId`, `attempt`) used by the retry node. Filter by event type in the node; the dropdown loads the available asynchronous types from your account.

**Semantics: delivered means done.** An event counts as processed once it has been delivered — unless a *Petra Retry on Next Poll* node asks for redelivery. The only client-side state is the feed cursor, stored in n8n's workflow static data and written exclusively by the poller.

**A failed run does not lose data.** HalloPetra keeps events for **30 days**. If a workflow was broken or your CRM was unreachable, the events are still there — and a workflow that was switched off over the weekend catches up on everything once it is published again.

### Petra Retry on Next Poll

Place this in the **error path** of your workflow (a node's error output, or "Continue (using error output)"). It is a terminal node without outputs. It asks HalloPetra to redeliver the event, which then reappears in the feed with an incremented `attempt` and is delivered again on a later poll.

- **Fibonacci backoff:** The wait before redelivery grows with each failed attempt — `Backoff Base` (default 60 s) × 1, 2, 3, 5, 8, … The node passes it as `delaySeconds`; HalloPetra keeps the event out of the feed until then.
- **Failure report:** Once `Max Attempts` (default 5) is reached, the event is no longer redelivered. Instead the node reports the permanent failure to HalloPetra so it can be shown to the business in the app. After that the event is done as far as n8n is concerned; retrying it again is a server-side action.

> **Why redelivery instead of local retry state?** n8n does not share workflow static data live between a polling trigger (cached in the main process) and workflow executions — a marker written by the retry node would never reach the poller. Going through the API works in queue mode too and keeps the poller the single writer of the cursor.

**Rules for reliable retries:**

- Errors must be caught **inside the same workflow** through error outputs, otherwise the retry node never runs. If an execution crashes uncaught, the event is not redelivered (deliberate best-effort design).
- Delivery is **at-least-once** — build idempotent workflows.
- Workflow static data is only persisted for active (production) workflows. In the editor's test mode the trigger therefore returns the latest events without touching the cursor.

## Example workflows

**Petra knows who is calling.** One lookup, then the answer — nothing in between:

```
Petra Webhook Trigger (call.incoming)
  → HTTP Request (query your CRM with {{ $json.contact.phone }})
  → Petra Finish (Contact: name/email from the CRM, Content: open tickets)
```

> **Phone number formats bite here.** The number arrives as your phone system delivers it — usually `+49…`, but that is not guaranteed. If your CRM stores `0170…`, the two will not match. Normalise one side before comparing, or store both spellings.

**After hanging up, the right thing happens by itself:**

```
Petra Events Trigger (call.finished)
  → Code / HTTP Request (store the summary)   ── error output ──→ Petra Retry on Next Poll
```

## API contract

Base URL `https://api.hallopetra.de/v1`. Every request sends `Authorization: Bearer <API key>` and the user agent `n8n-nodes-hallopetra/<version>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /events/types` | Event catalogue: `{ types: [{ name, label, mode: "sync"\|"async", description }] }`. `sync` types drive the webhook trigger, `async` types the events trigger. Also used to validate the credential. |
| `POST /webhooks` | `{ url, event, name?, description?, headers? }` → `201 { webhook: { id, url, event, name, active, createdAt }, secret }`. Only `sync` event types can be subscribed to; anything else is rejected with a 400. |
| `GET /webhooks/{id}` | The webhook itself (no wrapper object), or 404 once it is gone |
| `GET /webhooks/{id}/secret` | `{ secret }` — the signing secret stays retrievable, so a receiver can be repaired without re-registering |
| `DELETE /webhooks/{id}` | `{ deleted: true, id }` |
| `POST /webhooks/{id}/test` | Sends a representative signed delivery and reports the outcome as `{ ok, status?, body?, error? }` — useful to confirm that an n8n instance is reachable from HalloPetra |
| `GET /events?after=&types=&ids=&limit=` | Feed: `{ events: [{ id, type, occurredAt, payload }], nextCursor }` — `after` is exclusive, `limit` max 100, async events only |

**Signature of incoming webhook calls:** `X-HalloPetra-Signature: t=<unixSeconds>,v1=<hex>` — HMAC-SHA256 over `"<t>.<rawBody>"` using the webhook's secret, with a ±300 s tolerance (Stripe-style scheme). The trigger verifies this automatically whenever the webhook was registered through the API. If the secret is ever missing locally, the trigger re-fetches it from `GET /webhooks/{id}/secret` when the workflow is activated, rather than falling back to unverified deliveries.

Two endpoints backing the retry node — `POST /events/{id}/redeliver` and `POST /events/{id}/failed` — are specified but not yet available in the public API.

## Development

```bash
npm install      # install dependencies
npm run dev      # run a local n8n with this package linked (hot reload)
npm run build    # compile to dist/
npm run lint     # lint with the n8n community node rules
```

`npm run dev` starts a local n8n instance (by default at http://localhost:5678) with the nodes from this package available and reloaded on change.

### End-to-end test with Docker

`test/` contains an end-to-end setup that installs the package as a real community package inside an n8n container and exercises it against a mock of the HalloPetra API:

```bash
npm run build && npm pack --pack-destination /tmp   # build the tarball
node test/mock-petra-api.js &                       # mock API on port 7788

DATA=$(mktemp -d) && chmod 777 "$DATA"
docker run --rm -v "$DATA:/home/node/.n8n" -v /tmp/hallopetra-n8n-nodes-hallopetra-0.1.0.tgz:/tmp/petra.tgz \
  --entrypoint sh n8nio/n8n:latest -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install /tmp/petra.tgz"
docker run -d --name n8n-petra -p 5678:5678 -v "$DATA:/home/node/.n8n" \
  -e N8N_SECURE_COOKIE=false n8nio/n8n:latest

node test/e2e-test.js phase1   # owner setup, credential, sync round trip incl. signature check
node test/e2e-test.js phase2   # activate the events workflow with an error path and retry node
sleep 150
node test/e2e-test.js phase3   # verify redelivery, backoff, failure report and cursor progress
```

The mock expects the API key `test-key` and is reachable from inside the container at `http://host.docker.internal:7788` (the test script pre-configures the credential accordingly).

## Contributing

Architecture decisions, repository layout, the release process and the verification checklist live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE.md)
