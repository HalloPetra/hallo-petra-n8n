# Contributing & maintenance

Developer-facing companion to the [README](README.md), which documents the package for its users. This file covers how the package is built, why it looks the way it does, and how it is released. English throughout, because n8n requires all documentation of a verified node to be in English.

This package is the n8n counterpart to `hallo-petra-make` (Make.com custom app) and `zapier-petra`. All three speak the HalloPetra API v1 (`/v1/…`, bearer auth with `hp_ck_…` keys).

## Wording

HalloPetra is **the digital office worker** ("digitale Bürokraft"), never an AI agent, AI assistant or bot — not in the README, not in node descriptions, not in field help. In German-facing material the term is "KI-Bürokraft"; in English, "digital office worker". Petra is referred to by name, the way a colleague would be. `hallo-petra-make/src/readme.md` is the reference for tone: what the user gets, in plain language, before how it works.

## Components across the three integrations

| n8n (this package) | Make (`hallo-petra-make`) | Zapier (`zapier-petra`) |
| --- | --- | --- |
| Credential **Petra API** | Connection **HalloPetra** (`petra`) | Auth with `apiKey` + `baseUrl` |
| **Petra Incoming Call Trigger** — registers on publish, deregisters on unpublish | Webhook `petra-hook` + **"Vor einem Anruf"** (`watch-hooks`) — registers when the user creates the webhook in the dialog | REST hook `subscribe`/`unsubscribe` |
| **Petra In-Call Trigger** — registers `call.tool` | **"Während eines Anrufs"** (`watch-call-hooks`) | — |
| **Reply to Petra** — structured response node, one selector for both synchronous phases | Responder **"Antwort an Petra"** (`respond`) — same `respondTo` selector | not portable to Zapier |
| **Petra Call Finished Trigger** — registers `call.finished`, optionally scoped to Abläufe | **"Nach einem Anruf"** | — |
| **Petra Form Submission Trigger** — registers `form_submission`, optionally scoped to forms | — | — |
| **Create / Update Petra Contact**, **Create Petra Task** | **"Kontakt anlegen"**, **"Kontakt aktualisieren"**, **"Aufgabe erstellen"** | — |
| Ablauf and form pickers (`GET /ablaeufe`, `GET /forms`) | RPCs `getWebhookTypes` / `getEventTypes` | `event_type_list` trigger |
| — | Universal module **"Eigener API-Aufruf"** (`make-api-call`) — required by Make's review checklist | — |

Signature verification is the notable difference: n8n exposes the raw request body, so this package actually verifies `X-HalloPetra-Signature`. Make cannot (no raw-body access) and relies on the unguessable webhook URL instead.

## Architecture decisions

**Own Finish node instead of n8n's "Respond to Webhook".** The built-in node throws from version 1.1 onwards unless one of its hardcoded trigger types (Webhook, Form, Chat, Wait) is among its parents — community triggers are not accepted. The underlying mechanism (`responseMode: 'responseNode'` plus `sendResponse()`) is generic, so `PetraFinish` implements it directly.

**Everything is a webhook; there is no polling.** An earlier version had a polling trigger on an event feed, plus a retry node that asked the API to redeliver — the feed endpoint no longer exists, and with it the whole apparatus went: the cursor in workflow static data, the Fibonacci backoff, the failure report. This removed the package's only piece of client-side state and its only component that could not work in queue mode. The trade is real and belongs in the docs: HalloPetra does not retry a delivery, so a workflow that throws on an asynchronous event loses it. That is a deliberate best-effort design, not an oversight.

**Icons are raster images embedded in SVG.** The HalloPetra logo is a 3D illustration with no vector original, but the n8n linter rejects PNG icons (`node-class-description-icon-not-svg`) and a passing linter is required for verification. The icons are therefore 320 px WebP images base64-embedded in an SVG wrapper (~26 kB each). 320 px covers the worst case: n8n renders icons at up to 40 px, the canvas zooms 2×, and displays add another 2–3×. The linter also rejects identical light and dark files, so the dark variant adds a light rounded backdrop — which genuinely helps, since the blonde hair and blue jacket would otherwise blend into a dark UI.

**`PetraFinish` is a terminal node.** It has no outputs: once it runs, the HTTP response is gone. Work that should happen afterwards belongs on a branch taken *before* it.

**One trigger node per event, no event dropdown.** The four triggers each register a fixed `event`. A dropdown would list four values that need entirely different nodes anyway — different envelopes, different response contracts, different scoping — and the value it produced would be a parameter no user could meaningfully change. The differences are worth spelling out, because they are the reason the split is not arbitrary:

| | `call.incoming` | `call.tool` | `call.finished` | `form_submission` |
| --- | --- | --- | --- | --- |
| Envelope | flat, under `data` | nested under `body` | flat, under `data` | flat, top level |
| Response | `fields` + `instructions` | adds `message` | none | none |
| Budget | 2.5 s hard | 10 s | — | — |
| Scoping | — | — | `ablauf_ids` | `form_ids` |

Only the two synchronous events are answered, so only they offer the response parameters and appear in `PetraFinish`'s `respondTo` selector — the same choice the Make app makes in its responder, and the reason both are named in its parent check. The two asynchronous ones pin `responseMode: 'onReceived'` with `responseData: 'noData'`: without an explicit `responseData`, n8n defaults it to `firstEntryJson` and writes that literal string as the response body.

**Scoping is a registration property, not a filter.** `ablauf_ids` and `form_ids` go into `POST /webhooks`, so HalloPetra only delivers what the workflow asked for — no wasted executions, and the registration shows up on each Ablauf in the operator's dashboard. Neither is patchable, so `checkPetraWebhook` compares the selection order-insensitively and re-registers on any change. An empty selection means company-wide and the field is omitted entirely; the API rejects an empty array.

**Shared code lives in `nodes/shared/`.** `WebhookFunctions.ts` holds the whole subscription lifecycle plus HMAC checking — identical for all four triggers, only the registration body differs. `TriggerProperties.ts` holds the parameters they share, because the wording is part of the contract with the user and four copies drift. Each node keeps its literal `webhookMethods` structure, which the linter reads.

## Repository structure

```
credentials/PetraApi.credentials.ts     # API key + base URL, credential test against /v1/webhooks
nodes/shared/GenericFunctions.ts        # petraApiRequest (auth, user agent, error wrapping), Ablauf/form pickers
nodes/shared/WebhookFunctions.ts        # subscription lifecycle + HMAC verification, shared by all four triggers
nodes/shared/TriggerProperties.ts       # the parameters the triggers share (registration, response mode)
nodes/shared/ContactFields.ts           # the contact attributes both contact nodes offer, and the body builder
nodes/PetraTrigger/                     # call.incoming: before Petra answers
nodes/PetraInCallTrigger/               # call.tool: a tool Petra reaches for mid-conversation
nodes/PetraCallFinishedTrigger/         # call.finished: after the call, scopable to Abläufe
nodes/PetraFormTrigger/                 # form_submission: a submitted form, scopable to forms
nodes/PetraFinish/                      # synchronous response for either call phase
nodes/PetraContactCreate/               # POST /contacts
nodes/PetraContactUpdate/               # PATCH /contacts/{id}
nodes/PetraTaskCreate/                  # POST /tasks
test/mock-petra-api.js                  # mock of the HalloPetra API (webhooks, Abläufe, forms, contacts, tasks)
test/e2e-test.js                        # end-to-end test against n8n in Docker, one run
.github/workflows/publish.yml           # npm publish with provenance, triggered by version tags
.github/workflows/ci.yml                # lint + build on push and PR
```

Each node directory also holds its `*.node.json` codex metadata and the two icon files.

## Local development

See the README's development section for the commands and the Docker-based end-to-end test. Two things worth knowing:

- The mock API in `test/` is the executable specification of the API contract — when the backend contract changes, change the mock in the same commit.
- `test/e2e-state.json` (gitignored) carries the state between the three test phases: credentials, workflow ids and the session cookie.

## Release

Releases are cut locally and published by GitHub Actions:

```bash
npm run release      # lints, builds, prompts for the version bump, updates the changelog, commits, tags, pushes
```

Pushing the tag triggers `.github/workflows/publish.yml`, which publishes to npm **with a provenance attestation**. Since 1 May 2026 n8n only accepts verified nodes published this way — never publish from a local machine.

**Authentication is already set up and needs no maintenance:** the package uses npm trusted publishing (OIDC). No token exists in the repository, and none should be added — a present `NPM_TOKEN` would make npm prefer token auth over OIDC and fail against the account's 2FA requirement.

The trust relationship was established with:

```bash
npm trust github --file publish.yml --allow-publish --repo HalloPetra/hallo-petra-n8n
```

Note for the record: version 0.1.0 had to be published manually from a local machine, because npm only allows configuring trusted publishing for a package that already exists (`npm trust` requires this too). It therefore carries no provenance. Every release from 0.1.1 onwards is published by the workflow with provenance.

## Verification checklist

Requirements n8n applies to verified community nodes, and where this package stands:

- MIT licence, no runtime dependencies, TypeScript, generated from the `n8n-node` scaffolding — met
- No access to environment variables or the file system — met
- Node interface and all documentation in English — met
- Published from GitHub Actions with provenance from a public repository — met since 0.1.1 (SLSA provenance v1)
- `npx @n8n/scan-community-package @hallopetra/n8n-nodes-hallopetra` passes — met, all security checks green
- `repository` in `package.json` matches the GitHub repository, case-sensitively — met

One known risk: the guidelines say a package should integrate exactly one third-party service, with a trigger node allowed alongside the main node. This package ships eight nodes. They all serve HalloPetra, and they fall into three groups worth naming explicitly in the submission:

- **Two synchronous triggers and their shared responder.** `PetraTrigger` and `PetraInCallTrigger` cover the two moments HalloPetra calls out and waits, and `PetraFinish` is the only way to answer either — a synchronous webhook is useless without a way to respond. The three are functionally one unit.
- **Two asynchronous triggers.** `PetraCallFinishedTrigger` and `PetraFormTrigger` are the fire-and-forget half: one event each, no response, an optional scope. They are separate nodes because their payloads and their scoping sources have nothing in common.
- **Three action nodes.** Create contact, update contact, create task — the plain CRUD half of the same API, cut the way the Make app cuts it so users of both integrations look for the same thing.

## Open points

- **Half the event vocabulary is not deployed yet, so 0.4.0 must not be released before it is.** The OpenAPI document of `hp-api-pr-1971` registers only `call.incoming` and `call.finished`; `call.tool` and `form_submission` are being built in parallel and are rejected with a 400 until they ship. The create schema is strict, so there is no build that works against both states. Everything here is verified end to end against `test/mock-petra-api.js`; the check against the real API is outstanding.
- **`form_ids` and `GET /v1/forms` are an assumption, not a documented contract.** The form event carries a form id, and the scoping was specified as "analogous to the Abläufe", so this package sends `form_ids` on registration and loads the picker from `GET /v1/forms`, expecting `{ forms: [{ id, title, slug }] }`. `loadForms` also accepts an `items` wrapper or a bare array, but the field name on `POST /v1/webhooks` has to match exactly — confirm it against the backend before release.
- On the LiveKit path a `call.tool` delivery can arrive unsigned, because the webhook is resolved through a view that omits the secret. `receivePetraWebhook` verifies only when a secret is known locally, so this degrades to an unverified delivery rather than a 401 — but a webhook registered through the API does return a secret, so the trigger will start rejecting those deliveries once it has one. Worth confirming against the real API.
- Removing the polling trigger and the retry node is a breaking change for anyone who used them. They are gone rather than deprecated because `/v1/events` no longer exists, so a deprecated version would only fail more slowly.
- The Make app lives in `hallo-petra-make` (actively developed, already on `/v1/webhooks`); the older `make-petra` checkout still holds the pre-rename contract and is not the source of truth.
- Submission to the n8n Creator Portal is still open — everything it requires technically is in place.
