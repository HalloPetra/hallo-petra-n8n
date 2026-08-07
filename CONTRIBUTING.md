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
| **Petra In-Call Trigger** — registers `call.during` with the tool name and description | **"Während eines Anrufs"** (`watch-call-hooks`) | — |
| **Reply to Petra** — structured response node, one selector for both phases | Responder **"Antwort an Petra"** (`respond`) — same `respondTo` selector | not portable to Zapier |
| **Petra Activity Trigger** — polling with cursor in workflow static data | **"Auf Petra reagieren"** (`watch-events`) — cursor persisted by Make (`data.lastID`) | `performList` with cursor walking |
| **Petra Retry on Next Poll** — redelivery through the API with Fibonacci backoff | platform retry ("Store incomplete executions" + retry error handler) | Zapier replay |
| **Create / Update Petra Contact**, **Create Petra Task** | **"Kontakt anlegen"**, **"Kontakt aktualisieren"**, **"Aufgabe erstellen"** | — |
| Event type dropdown on the activity trigger | RPCs `getWebhookTypes` / `getEventTypes` | `event_type_list` trigger |
| — | Universal module **"Eigener API-Aufruf"** (`make-api-call`) — required by Make's review checklist | — |

Signature verification is the notable difference: n8n exposes the raw request body, so this package actually verifies `X-HalloPetra-Signature`. Make cannot (no raw-body access) and relies on the unguessable webhook URL instead.

## Architecture decisions

**Own Finish node instead of n8n's "Respond to Webhook".** The built-in node throws from version 1.1 onwards unless one of its hardcoded trigger types (Webhook, Form, Chat, Wait) is among its parents — community triggers are not accepted. The underlying mechanism (`responseMode: 'responseNode'` plus `sendResponse()`) is generic, so `PetraFinish` implements it directly.

**Redelivery through the API instead of local retry state.** The first design kept a retry set in `getWorkflowStaticData('global')`, written by the retry node and read by the poller. End-to-end testing proved this cannot work: a polling trigger runs in n8n's main process with a cached copy of the static data and never sees writes made by workflow executions. Retries therefore go through `POST /events/{id}/redeliver`; the cursor stays the single piece of client state, written only by the poller. This also survives queue mode.

**Icons are raster images embedded in SVG.** The HalloPetra logo is a 3D illustration with no vector original, but the n8n linter rejects PNG icons (`node-class-description-icon-not-svg`) and a passing linter is required for verification. The icons are therefore 320 px WebP images base64-embedded in an SVG wrapper (~26 kB each). 320 px covers the worst case: n8n renders icons at up to 40 px, the canvas zooms 2×, and displays add another 2–3×. The linter also rejects identical light and dark files, so the dark variant adds a light rounded backdrop — which genuinely helps, since the blonde hair and blue jacket would otherwise blend into a dark UI.

**Terminal nodes.** `PetraFinish` and `PetraEventRetry` have no outputs. Each marks the end of its path — the HTTP response has been sent, or the event has been handed back to HalloPetra. Work that should happen afterwards belongs on a branch taken *before* these nodes.

**A separate node for the in-call tool, not a second mode of the incoming-call trigger.** `call.during` differs from `call.incoming` in every way that matters to a user: the delivery is nested under `body` instead of flat under `data`, it carries the conversation so far and the parameters Petra collected, the response adds a spoken `message`, the time budget is 10 s instead of 2.5 s, and registration requires a tool name and description that have no counterpart before the greeting. Folding that into one node would give a single building block two personalities. `PetraFinish` *is* shared, through a `respondTo` selector — the same choice the Make app makes in its responder, and the reason both triggers are named in its parent check.

**One trigger node per integration point, no type dropdown.** Both webhook triggers register a fixed `type`. A dropdown loading the registrable types would list two values that need entirely different nodes anyway, and the value it produced would be a parameter no user could meaningfully change. `loadFeedEventTypes` therefore only serves the activity trigger, where the feed genuinely offers a choice.

**The webhook lifecycle lives in `nodes/shared/WebhookFunctions.ts`.** Registration, verification, deregistration and HMAC checking are identical for both triggers; only the registration body differs. Each node keeps its literal `webhookMethods` structure (the linter reads it) and delegates the bodies.

## Repository structure

```
credentials/PetraApi.credentials.ts     # API key + base URL, credential test against /v1/events/types
nodes/shared/GenericFunctions.ts        # petraApiRequest (auth, user agent, error wrapping), feed type loading
nodes/shared/WebhookFunctions.ts        # subscription lifecycle + HMAC verification, shared by both triggers
nodes/shared/ContactFields.ts           # the contact attributes both contact nodes offer, and the body builder
nodes/PetraTrigger/                     # call.incoming: before Petra answers
nodes/PetraInCallTrigger/               # call.during: a tool Petra reaches for mid-conversation
nodes/PetraFinish/                      # synchronous response for either phase
nodes/PetraEventsTrigger/               # polling trigger, cursor in workflow static data
nodes/PetraEventRetry/                  # redelivery with Fibonacci backoff + failure report
nodes/PetraContactCreate/               # POST /contacts
nodes/PetraContactUpdate/               # PATCH /contacts/{id}
nodes/PetraTaskCreate/                  # POST /tasks
test/mock-petra-api.js                  # mock of the HalloPetra API (webhooks, feed, contacts, tasks)
test/e2e-test.js                        # three-phase end-to-end test against n8n in Docker
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
- **One feed trigger and its retry node.** `PetraEventsTrigger` polls, `PetraEventRetry` hands an event back; the retry node exists because n8n cannot hold retry state across the poller boundary (see the redelivery decision above).
- **Three action nodes.** Create contact, update contact, create task — the plain CRUD half of the same API, cut the way the Make app cuts it so users of both integrations look for the same thing.

## Open points

- **The `type` contract must ship before 0.3.0 is released.** From 0.3.0 the triggers send `type` on `POST /v1/webhooks`, and the create schema is strict — an API that still expects `event` rejects every registration with a 400, and one that already expects `type` rejects the old `event`. There is no version of this package that works against both. Verified end to end against `test/mock-petra-api.js`; the check against the real API is outstanding until the backend change is deployed.
- `POST /events/{id}/redeliver` and `POST /events/{id}/failed` are specified in the README but not implemented in the public API — confirmed absent from the `/v1/events` router. Until they ship, the retry node fails against production. The API offers `GET /v1/events?ids=…` as a consumer-side alternative, but that requires the consumer to hold the retry set, which n8n cannot do (see the redelivery decision above).
- On the LiveKit path a `call.during` delivery can arrive unsigned, because the webhook is resolved through a view that omits the secret. `receivePetraWebhook` verifies only when a secret is known locally, so this degrades to an unverified delivery rather than a 401 — but a `call.during` webhook registered through the API does return a secret, so the trigger will start rejecting those deliveries once it has one. Worth confirming against the real API when the backend change lands.
- The Make app lives in `hallo-petra-make` (actively developed, already on `/v1/webhooks`); the older `make-petra` checkout still holds the pre-rename contract and is not the source of truth.
- Submission to the n8n Creator Portal is still open — everything it requires technically is in place.
