# @hallopetra/n8n-nodes-hallopetra

n8n community node package that connects [HalloPetra](https://hallopetra.de) — the digital office worker for trade businesses — to n8n workflows. Petra answers the phone when nobody else can, notes what the call was about, and leaves nobody on hold.

Everything runs on webhooks that the nodes register with HalloPetra by themselves: publish the workflow and it is live, unpublish it and the registration is gone. Your workflows join in at five points:

1. **Before the call:** While the phone is still ringing, HalloPetra calls a webhook registered in n8n and waits for the answer — for example the customer record looked up in your CRM. Petra greets the caller by name instead of asking who is speaking.
2. **During the call:** Petra reaches for your workflow mid-conversation, the way she would ask a colleague — *"What is the status of order A-4711?"* You answer, and she keeps talking.
3. **After the call:** The moment Petra has written up the call, the summary, the transcript and everything she collected land in your workflow. The caller ends up as a contact in your accounting software, the summary as an email in the office — nobody types up notes in the evening. You can narrow this down to specific Abläufe.
4. **When a form comes in:** Someone submits a HalloPetra form and the workflow starts, with the entries, the contact and the call it belongs to.
5. **Back into HalloPetra:** Create or update a contact, put a task on the team's list — so what came out of the call is where the business already looks.

## Installation

1. In n8n, go to **Settings → Community Nodes → Install** and enter `@hallopetra/n8n-nodes-hallopetra`.
2. In the HalloPetra app, create an API key for the integration (format `hp_ck_…`).
3. In n8n, create a **Petra API** credential and paste the key. The default base URL is `https://api.hallopetra.de/v1`. Use **Test** to confirm the connection.
4. Add a Petra trigger to a workflow, select the credential and publish the workflow — webhook registration happens automatically.

## Nodes

### Petra Incoming Call Trigger

Starts the workflow when a call reaches Petra, before she answers. When the workflow is published, the node registers a `call.incoming` webhook through the HalloPetra API — visible in your HalloPetra dashboard under the workflow's name — and removes it again when the workflow is unpublished.

The delivery looks like this:

```json
{
  "webhook_id": "wh_…",
  "event": "call.incoming",
  "data": {
    "call_id": "call_…",
    "calling_phone_number": "+491701234567",
    "inbound_phone_number": "+4930123456",
    "start_time": "2026-08-07T10:15:00.000Z",
    "contact": { "id": "…", "anrede": "Herr", "vorname": "Max", "nachname": "Mustermann",
                 "firma": null, "telefonnummer": "+491701234567", "email": "max@example.com" },
    "fields": { "kontakt": { "customer_number": "K-4711" } }
  }
}
```

`contact` is `null` when the caller is unknown — that is the normal case for a first-time caller, not an error.

Incoming deliveries are verified with an HMAC signature (see [API contract](#api-contract)). If you prefer to configure the webhook URL manually in the HalloPetra app, set **Registration** to *Manual* — the node then skips both the API call and the signature check.

**Respond** controls how the answer is produced: through a *Reply to Petra* node (default), with the output of the last executed node, or immediately without waiting for the workflow.

> **You have 2.5 seconds.** Petra waits at most 2500 ms for the response — there is no setting to extend this, because a caller is on the line. Keep the workflow to a single lookup and nothing else. n8n's own execution start-up latency counts towards that budget, so a queue-mode instance under load leaves noticeably less room than a warm one.
>
> **Nothing is ever lost if you miss it.** If the workflow is too slow, fails, or finds nothing, Petra simply greets the caller normally and carries on without the extra data. The call is never dropped and the caller never waits. The worst case is a generic greeting instead of a personal one — which is exactly what happens for every first-time caller anyway.

> **Self-hosted:** Your n8n instance must know its public URL (`WEBHOOK_URL` environment variable, especially behind a reverse proxy). Otherwise n8n registers an unreachable address with HalloPetra. On n8n Cloud this works out of the box.

### Petra In-Call Trigger

Starts the workflow while Petra is on the call, when she needs something she cannot answer herself. She reaches for it the way she would ask a colleague — you answer, and she keeps talking.

Publishing the workflow registers a `call.tool` webhook — and that registration **is** the tool. Everything Petra needs to use it is configured right here in the node:

- **Tool Name** is what she calls the workflow by. It appears as a step in the Ablauf editor, so write it the way an operator would name the task: "Auftragsstatus nachschlagen".
- **When Petra Should Use It** is what she reads to decide whether to reach for it. Write it as an instruction to her, in the language she speaks with your callers.
- **Abläufe** is where the tool gets attached. Petra can only use it while she is running one of them, so pick at least one — a tool with no Ablauf has no place to appear and is rejected.
- **Parameters** declares what she asks the caller for first. Each entry needs a key; the description is what she reads to fill the value, so phrase it as an instruction too ("Die Bestellnummer, nach der der Anrufer fragt. Frage nach, wenn sie nicht genannt wurde."). The answers arrive under `body.parameter`, keyed by your key.

Changing any of it re-registers the tool when you publish, because none of it can be patched afterwards.

The delivery nests everything under `body`:

```json
{
  "body": {
    "webhook_id": "wh_…",
    "call": {
      "calling_phone_number": "+491701234567",
      "inbound_phone_number": "+4930123456",
      "start_time": "2026-08-07T10:15:00.000Z",
      "call_id": "call_…",
      "duration": 42,
      "contact_id": "…",
      "messages": [{ "role": "user", "content": "Wie ist der Stand meines Auftrags?" }],
      "previous_webhook_calls": []
    },
    "parameter": { "auftragsnummer": "A-4711" },
    "fields": { "kontakt": { "customer_number": "K-4711" } }
  }
}
```

`parameter` holds what Petra asked the caller — one entry per parameter you declared. `messages` is the conversation so far, without the system prompt.

> **You have 10 seconds.** More room than before the greeting, but the caller is still on the line and hears the pause. Finish with a *Reply to Petra* node so Petra knows what to say next.

### Reply to Petra

Sends the synchronous response back to HalloPetra. **Respond To** picks which trigger this workflow started from, because the two phases expect different answers. Only these two are answered at all — the call-finished and form triggers are fire-and-forget.

Answering the **Incoming Call** trigger:

```json
{
  "fields": {
    "kontakt": { "customer_number": "K-4711" },
    "prozess": { "anliegen": "Heizung tropft" }
  },
  "instructions": "Customer has an open invoice — do not raise it, note the request and pass it to accounting."
}
```

Answering the **In-Call** trigger adds what Petra says next:

```json
{
  "message": { "content": "Your order ships on Thursday.", "message_type": "SAY" },
  "fields": { "kontakt": { "customer_number": "K-4711" } },
  "instructions": "Premium customer — offer the express appointment."
}
```

- **Message** with type *Say* is spoken to the caller. *Silent* adds the text as context for Petra without an announcement — useful when the workflow only found background information.
- **Instructions** is how Petra should handle this call, in plain language. It goes into her prompt, it is not spoken.
- **Persist Fields (Kontakt / Prozess)** behaves differently from everything else here: those values do not go into the conversation. They tell HalloPetra to store them permanently — *Kontakt* for lasting facts about the caller, *Prozess* for what this particular request was about. Keys are canonicalised to snake_case, and unknown ones are created on the fly.

Expressions work in every field. **All sections are optional:** anything left empty is omitted from the response entirely. This is a terminal node without outputs — it marks the end of the synchronous part. To run additional steps after responding (logging, for instance), branch off *before* this node; the response is sent the moment the node runs.

### Petra Call Finished Trigger

Starts the workflow after a call has ended and Petra has written it up. The node registers a `call.finished` webhook when the workflow is published.

**Fires** decides how much you get: *After every call*, or *Only after selected Abläufe*. The Abläufe are loaded from your account; a call that ran any one of them starts the workflow. A scoped registration also shows up on each of those Abläufe in the HalloPetra app under "Nach dem Anruf", so an operator can see what is attached where. Disabled Abläufe stay selectable — the webhook simply starts firing once one is switched back on.

```json
{
  "webhook_id": "wh_…",
  "event": "call.finished",
  "data": {
    "id": "call_…", "duration": 184, "phone": "+491701234567",
    "topic": "Heizung ausgefallen",
    "summary": "Herr Mustermann meldet einen Totalausfall seiner Gasheizung.",
    "messages": [{ "role": "user", "content": "…", "secondsFromStart": 4.2 }],
    "collected_data": { "issue_information": "Fehlercode F28" },
    "contact_data": { "id": "…", "name": "Max Mustermann", "phone": "+491701234567" },
    "email_send_to": null, "forwarded_to": null, "main_task_id": "…",
    "fields": { "kontakt": {}, "prozess": {}, "projekt": {} }
  }
}
```

`duration` is in seconds, `collected_data` is what Petra noted during the call, and `main_task_id` names the Ablauf that ran.

> **Delivered once, never retried, nothing waits for an answer.** Do not add a *Reply to Petra* node — nothing reads the response. To write results back, use the contact and task nodes. Since there is no redelivery, a workflow that throws loses that delivery: catch errors inside the workflow if the data matters.

### Petra Form Submission Trigger

Starts the workflow when someone submits a HalloPetra form — filled in during a call or through a public form link. Registers a `form.submitted` webhook, and like the trigger above it can fire for every form or only for selected ones. Inactive forms stay selectable; the webhook starts firing once one is switched back on.

```json
{
  "webhook_id": "wh_…",
  "event": "form.submitted",
  "data": {
    "form": { "id": "…", "title": "Rückrufbitte", "slug": "rueckrufbitte" },
    "submission": { "submitted_at": "2026-08-07T10:15:00.000Z",
                    "data": { "anliegen": "Bitte um Rückruf" } },
    "contact": { "id": "…", "name": "Max Mustermann", "phone": "+491701234567", "email": "…" },
    "call": { "id": "call_…", "topic": "…", "summary": "…", "date": "…" }
  }
}
```

`submission.data` holds the entries keyed by field; file and signature entries carry a time-limited download URL. `contact` and `call` are `null` when the form was filled outside a call. This delivery is fire-and-forget as well.

### Create Petra Contact · Update Petra Contact · Create Petra Task

The other direction: what came out of the call goes back into HalloPetra, where the business already looks.

**Create Petra Contact** adds someone to the contact directory, so Petra knows them by name the next time they call. The node returns the new contact including its ID.

**Name** is the one required field, and worth a word on why: the HalloPetra app lists and searches contacts by it. The API does not build it from first and last name, and it does not complain when it is missing — a contact created without one is stored, answers with an ID, and never shows up in the app. The node therefore refuses to create one, including when an expression happens to resolve to nothing. First and last name are stored in addition, not instead.

**Update Petra Contact** writes what you learned to an existing contact. Only the fields you fill in change. It needs the **Contact ID**, and every trigger carries it once the caller is known — each in its own place:

| Trigger | Expression |
| --- | --- |
| Petra Incoming Call Trigger | `{{ $json.data.contact.id }}` |
| Petra In-Call Trigger | `{{ $json.body.call.contact_id }}` |
| Petra Call Finished Trigger | `{{ $json.data.contact_data.id }}` |
| Petra Form Submission Trigger | `{{ $json.data.contact.id }}` |

Before the greeting the caller may still be unknown and the value empty — that is the case for *Create Petra Contact*, not for a lookup.

**Create Petra Task** puts an Aufgabe on the team's list. Only **Title** is required. **Assign To** is *Team* by default (nobody in particular — the whole team sees it), or one specific member, or Petra herself. Under additional fields: content as Markdown, a due date with an optional iCalendar recurrence rule, the contact and Projekt it belongs to, and an origin shown in the dashboard.

**Field Data** on both contact nodes stores custom fields on the contact. Keys are canonicalised to snake_case (`Kundennummer` becomes `customer_number`), and keys HalloPetra has never seen are created automatically with a type inferred from the value.

All three respect **Continue on Fail**: a failing item produces an item with an `error` key instead of stopping the batch.

## Example workflows

**Petra knows who is calling.** One lookup, then the answer — nothing in between:

```
Petra Incoming Call Trigger
  → HTTP Request (query your CRM with {{ $json.data.calling_phone_number }})
  → Reply to Petra (Respond To: Incoming Call — Kontakt fields from the CRM,
                    Instructions: "Regular customer, heating last serviced in March")
```

> **Phone number formats bite here.** The number arrives as your phone system delivers it — usually `+49…`, but that is not guaranteed. If your CRM stores `0170…`, the two will not match. Normalise one side before comparing, or store both spellings.

**Petra asks mid-call, and gets an answer:**

```
Petra In-Call Trigger (Tool Name: "Auftragsstatus nachschlagen",
                       attached to the "Bestellannahme" Ablauf,
                       Parameter "auftragsnummer")
  → HTTP Request (query your ERP with {{ $json.body.parameter.auftragsnummer }})
  → Reply to Petra (Respond To: During a Call — Message: "Your order ships on Thursday")
```

**What came out of the call ends up where the business looks:**

```
Petra In-Call Trigger (Tool Name: "Anliegen aufnehmen")
  → Update Petra Contact ({{ $json.body.call.contact_id }}, e-mail from the call)
  → Create Petra Task (title from the request, assigned to the team)
  → Reply to Petra (Message: "I have noted that, a colleague will call you back")
```

**After hanging up, the right thing happens by itself:**

```
Petra Call Finished Trigger (only after "Notdienst-Anfrage aufnehmen")
  → HTTP Request (open a ticket with {{ $json.data.summary }})
  → Create Petra Task (follow-up, assigned to the team)
```

**A form comes in and lands where the team works:**

```
Petra Form Submission Trigger (every form)
  → Update Petra Contact ({{ $json.data.contact.id }}, e-mail from the submission)
  → Create Petra Task ("Formular: {{ $json.data.form.title }}")
```

## API contract

Base URL `https://api.hallopetra.de/v1`. Every request sends `Authorization: Bearer <API key>` and the user agent `n8n-nodes-hallopetra/<version>`.

| Endpoint | Purpose |
| --- | --- |
| `POST /webhooks` | `{ url, event, name?, description?, headers?, ablauf_ids?, formular_ids?, parameters? }` → `201 { webhook: { id, url, event, name, active, createdAt }, secret }`. `event` is one of `call.incoming`, `call.tool`, `call.finished`, `form.submitted`; anything else is a 400. The shape depends on it: `call.tool` requires `name` and `ablauf_ids` and accepts `parameters` (1–20 entries of `{ key, label?, description? }`, keys unique); `call.finished` takes an optional `ablauf_ids`; `form.submitted` an optional `formular_ids`. Every id array holds 1–20 known ids — omit it entirely for a company-wide registration, an empty array is a 400. The request is strict: an unknown key is a 400. |
| `GET /webhooks?url=&event=` | `{ items, totalCount }` — `url` is an exact-match filter, so a node can find its own registration by its endpoint. Also used to validate the credential. |
| `GET /webhooks/{id}` | The webhook itself (no wrapper object), or 404 once it is gone |
| `GET /webhooks/{id}/secret` | `{ secret }` — the signing secret stays retrievable, so a receiver can be repaired without re-registering |
| `PATCH /webhooks/{id}` | Change `url`, `name`, `description`, `active` or `headers`. Event, scoping and tool parameters are not patchable — changing any of them means re-registering. |
| `DELETE /webhooks/{id}` | `{ deleted: true, id }` |
| `POST /webhooks/{id}/test` | Sends a representative signed delivery and reports the outcome as `{ ok, status?, body?, error? }` — useful to confirm that an n8n instance is reachable from HalloPetra |
| `GET /ablaeufe` | `{ ablaeufe: [{ id, title, status: "enabled"\|"disabled" }] }` — the picker behind the in-call trigger's and the call-finished trigger's Ablauf selection |
| `GET /formulare` | `{ formulare: [{ id, title, status: "enabled"\|"disabled" }] }` — the picker behind the form trigger's selection |
| `POST /contacts` | `{ name?, salutation?, firstName?, lastName?, phone?, email?, address?, contactGroupIds?, fields? }` → `201` with the contact including its `id` |
| `PATCH /contacts/{id}` | Same fields, at least one required. `fields` merges key by key; everything else is replaced. |
| `POST /tasks` | `{ title, content?, dueAt?, recurrenceRule?, assignment?, contactId?, projektId?, origin? }` → `201` with the task |

Errors come back as `{ error: { code, message, requestId } }`, where `code` is one of `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`. Quote the `requestId` in support requests. The rate limit is 300 requests per minute per API key.

**Signature of incoming webhook calls:** `X-HalloPetra-Signature: t=<unixSeconds>,v1=<hex>` — HMAC-SHA256 over `"<t>.<rawBody>"` using the webhook's secret, with a ±300 s tolerance (Stripe-style scheme). Every trigger verifies this automatically whenever the webhook was registered through the API. If the secret is ever missing locally, the trigger re-fetches it from `GET /webhooks/{id}/secret` when the workflow is activated, rather than falling back to unverified deliveries.

**Deliveries are never retried.** For the two synchronous events that is by design — the call moves on. For the asynchronous ones it means a failing workflow loses that delivery, so catch errors inside the workflow.

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
npm run build
TGZ=$(npm pack --silent --pack-destination /tmp)     # build the tarball
node test/mock-petra-api.js &                        # mock API on port 7788

DATA=$(mktemp -d) && chmod -R a+rwX "$DATA"
mkdir -p "$DATA/nodes" && (cd "$DATA/nodes" && npm init -y >/dev/null && npm install "/tmp/$TGZ")
docker run -d --name n8n-petra -p 5678:5678 -v "$DATA:/home/node/.n8n" \
  -e "WEBHOOK_URL=http://localhost:5678/" -e N8N_SECURE_COOKIE=false n8nio/n8n:latest

node test/e2e-test.js run                            # the whole test, ~30 s
```

The run sets up the owner account and the credential, builds one workflow per trigger, publishes them, and then checks that all four registered themselves with the right event and scoping. Each gets a signed delivery: the two synchronous ones must answer in the right format, the two asynchronous ones must acknowledge without a body and create a task from the payload. It closes with the two lifecycle paths that are easy to get wrong — changing the Ablauf selection has to re-register, unpublishing has to deregister.

The mock expects the API key `test-key` and is reachable from inside the container at `http://host.docker.internal:7788` (the test script pre-configures the credential accordingly). `WEBHOOK_URL=http://localhost:5678/` makes n8n register a URL the mock can reach from the host — no tunnel needed for a local run. For a run against the real API, `test/n8n-docker.sh` sets a public URL instead.

The run is idempotent: it resets the workflows it finds in `test/e2e-state.json` and identifies its own contacts and tasks rather than counting them, so it can be repeated without restarting n8n or the mock.

## Contributing

Architecture decisions, repository layout, the release process and the verification checklist live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE.md)
