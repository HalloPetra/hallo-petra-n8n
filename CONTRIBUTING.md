# Contributing & maintenance

Developer-facing companion to the [README](README.md), which documents the package for its users. This file covers how the package is built, why it looks the way it does, and how it is released. English throughout, because n8n requires all documentation of a verified node to be in English.

This package is the n8n counterpart to `hallo-petra-make` (Make.com custom app) and `zapier-petra`. All three speak the HalloPetra API v1 (`/v1/…`, bearer auth with `hp_ck_…` keys).

## Wording

HalloPetra is **the digital office worker** ("digitale Bürokraft"), never an AI agent, AI assistant or bot — not in the README, not in node descriptions, not in field help. In German-facing material the term is "KI-Bürokraft"; in English, "digital office worker". Petra is referred to by name, the way a colleague would be. `hallo-petra-make/src/readme.md` is the reference for tone: what the user gets, in plain language, before how it works.

## Components across the three integrations

| n8n (this package) | Make (`hallo-petra-make`) | Zapier (`zapier-petra`) |
| --- | --- | --- |
| Credential **Petra API** | Connection **HalloPetra** (`petra`) | Auth with `apiKey` + `baseUrl` |
| **HalloPetra Trigger**, Event *Call Incoming* — registers on publish, deregisters on unpublish | Webhook `petra-hook` + **"Vor einem Anruf"** (`watch-hooks`) — registers when the user creates the webhook in the dialog | REST hook `subscribe`/`unsubscribe` |
| **HalloPetra Trigger**, Event *Call Tool* — registers `call.tool`, which *defines* the tool | **"Während eines Anrufs"** (`watch-call-hooks`) | — |
| **HalloPetra** node, Call → Reply — structured response, one selector for both synchronous phases | Responder **"Antwort an Petra"** (`respond`) — same `respondTo` selector | not portable to Zapier |
| **HalloPetra Trigger**, Event *Call Finished* — registers `call.finished`, optionally scoped to call flows | **"Nach einem Anruf"** | — |
| **HalloPetra Trigger**, Event *Form Submitted* — registers `form.submitted`, optionally scoped to forms | — | — |
| **HalloPetra** node, Contact → Create / Update | **"Kontakt anlegen"**, **"Kontakt aktualisieren"** | — |
| Call flow and form pickers (`GET /call-flows`, `GET /forms`) | RPCs `getWebhookTypes` / `getEventTypes` | `event_type_list` trigger |
| — | Universal module **"Eigener API-Aufruf"** (`make-api-call`) — required by Make's review checklist | — |

Signature verification is the notable difference: n8n exposes the raw request body, so this package actually verifies `X-HalloPetra-Signature`. Make cannot (no raw-body access) and relies on the unguessable webhook URL instead.

## Architecture decisions

**Own reply operation instead of n8n's "Respond to Webhook".** The built-in node throws from version 1.1 onwards unless one of its hardcoded trigger types (Webhook, Form, Chat, Wait) is among its parents — community triggers are not accepted. The underlying mechanism (`responseMode: 'responseNode'` plus `sendResponse()`) is generic, so the HalloPetra node's Call → Reply operation implements it directly.

**Everything is a webhook; there is no polling.** An earlier version had a polling trigger on an event feed, plus a retry node that asked the API to redeliver — the feed endpoint no longer exists, and with it the whole apparatus went: the cursor in workflow static data, the Fibonacci backoff, the failure report. This removed the package's only piece of client-side state and its only component that could not work in queue mode. The trade is real and belongs in the docs: HalloPetra does not retry a delivery, so a workflow that throws on an asynchronous event loses it. That is a deliberate best-effort design, not an oversight.

**Icons are raster images embedded in SVG.** The HalloPetra logo is a 3D illustration with no vector original, but the n8n linter rejects PNG icons (`node-class-description-icon-not-svg`) and a passing linter is required for verification. The icons are therefore 320 px WebP images base64-embedded in an SVG wrapper (~26 kB each). 320 px covers the worst case: n8n renders icons at up to 40 px, the canvas zooms 2×, and displays add another 2–3×. The linter also rejects identical light and dark files, so the dark variant adds a light rounded backdrop — which genuinely helps, since the blonde hair and blue jacket would otherwise blend into a dark UI.

**Replying is terminal.** With Resource *Call* the node's `outputs` expression resolves to `[]`: once it runs, the HTTP response is gone. Work that should happen afterwards belongs on a branch taken *before* it. The contact operations resolve to a normal main output.

**One trigger with an event dropdown, one action node with resource/operation.** Until 2.x each event and each action was its own node — seven in total. n8n's verification caps a package at one regular node plus one trigger, so 3.0.0 merges them: the trigger carries an `event` dropdown whose choice gates the event-specific fields via `displayOptions`, and the action node follows the Notion/HubSpot resource/operation pattern. The events still differ substantially, which is why the field sets are disjoint rather than shared:

| | `call.incoming` | `call.tool` | `call.finished` | `form.submitted` |
| --- | --- | --- | --- | --- |
| Envelope | flat, under `data` | nested under `body` | flat, under `data` | flat, under `data` |
| Response | `fields` + `instructions` | adds `message` | none | none |
| Budget | 2.5 s hard | 10 s | — | — |
| Scoping | — | `callFlowIds`, required | `callFlowIds`, optional | `formIds`, optional |
| Registration | label only | *defines the tool* | label only | label only |

Only the two synchronous events are answered, so only they show the response parameters and appear in the reply operation's `respondTo` selector — the same choice the Make app makes in its responder. For the two asynchronous events the trigger's `responseMode`/`responseData` expressions resolve to `onReceived`/`noData`: without an explicit `responseData`, n8n defaults it to `firstEntryJson` and writes that literal string as the response body.

**Scoping is a registration property, not a filter.** `callFlowIds` and `formIds` go into `POST /webhooks`, so HalloPetra only delivers what the workflow asked for — no wasted executions, and the registration shows up on each call flow in the operator's dashboard. Neither is patchable, so `checkPetraWebhook` compares the selection order-insensitively and re-registers on any change. An empty selection means company-wide and the field is omitted entirely; the API rejects an empty array.

**Registering `call.tool` creates the tool, so that event carries the tool's definition.** For the other three events `name` and `description` are a dashboard label and the trigger derives them from the workflow. For `call.tool` they are what Petra calls the workflow by and what she reads to decide when to use it, `callFlowIds` is required because a tool needs somewhere to appear, and `parameters` declares the arguments she collects from the caller. Everything but the URL is immutable server-side, so the whole definition takes part in the drift comparison. The API would answer a missing name or an empty call flow selection with a plain 400, so the trigger checks both up front and names the field — except in manual mode, where none of it is sent and demanding it would be nonsense.

**Shared code lives in `nodes/shared/`.** `WebhookFunctions.ts` holds the whole subscription lifecycle plus HMAC checking — identical for all four events, only the registration body differs (a `switch` in the trigger's `registration()`). `TriggerProperties.ts` holds the registration and response-mode parameters, kept out of the node file because the wording is part of the contract with the user.

## Repository structure

```
credentials/PetraApi.credentials.ts     # API key + host (the nodes add /v1), credential test against /v1/webhooks
nodes/shared/GenericFunctions.ts        # petraApiRequest (auth, user agent, error wrapping), call flow/form pickers
nodes/shared/WebhookFunctions.ts        # subscription lifecycle + HMAC verification, shared by all four events
nodes/shared/TriggerProperties.ts       # the trigger parameters kept out of the node file (registration, response mode)
nodes/shared/ContactFields.ts           # the contact attributes both contact operations offer, and the body builder
nodes/PetraTrigger/                     # HalloPetra Trigger: all four events behind one event dropdown
nodes/Petra/                            # HalloPetra action node: call.reply, contact.create, contact.update
test/mock-petra-api.js                  # mock of the HalloPetra API (webhooks, call flows, forms, contacts)
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

- At most one regular node plus one trigger per package — met since 3.0.0, which merged the seven nodes of 2.x into `Petra` (resource/operation) and `PetraTrigger` (event dropdown) after n8n flagged the count in review.

## Open points

- **`content` is missing from the reply operation, and someone wanted it.** The spec describes the `call.incoming` response as `contact` / `other_data` / `content` / `fields` and never mentions `instructions`; the implemented contract (`fields` + `instructions`, plus `message` for `call.tool`) was confirmed against the backend on 11 August 2026 and demonstrably works. But a real workflow was found trying to smuggle a `content` key into `instructions` by escaping out of the JSON, which means the field is wanted for appending free text to Petra's prompt. Whether `instructions` and `content` do the same thing on the `call.incoming` path is unconfirmed. Add `content` when that is answered — do not remove `instructions` on the strength of the prose alone.
- **A failed registration takes the endpoint down with it.** n8n rolls back the whole activation when a `create` hook throws, so an unreachable API means the trigger's HTTP endpoint disappears too — even though HalloPetra still holds a valid registration and keeps delivering to it. Happened in practice on 12 August 2026 (wrong base URL) and looks, from the outside, exactly like "the webhook no longer exists". A `checkExists` that treats a connection or server error as "assume the stored registration is still good" would keep the endpoint alive; a genuine 404 should still fail loudly.
- **Nothing cleans up orphaned registrations.** `checkPetraWebhook` forgets the stored webhook id whenever verifying it fails for any reason, and `deletePetraWebhook` drops it even when the `DELETE` did not go through. Both leave a registration behind that HalloPetra keeps delivering to, so a call arrives twice and the workflow runs twice — observed in the wild. `test/webhook-doctor.js` finds and removes them by hand. The durable fix is to look the endpoint up by URL (`GET /v1/webhooks?url=…`) before registering and clear out what is already there; that cannot hit a hand-made registration, because the URL carries a workflow-specific UUID.
- On the LiveKit path a `call.tool` delivery can arrive unsigned, because the webhook is resolved through a view that omits the secret. `receivePetraWebhook` verifies only when a secret is known locally, so this degrades to an unverified delivery rather than a 401 — but a webhook registered through the API does return a secret, so the trigger will start rejecting those deliveries once it has one. Worth confirming against the real API.
- Removing the polling trigger and the retry node is a breaking change for anyone who used them. They are gone rather than deprecated because `/v1/events` no longer exists, so a deprecated version would only fail more slowly.
- The Make app lives in `hallo-petra-make` (actively developed, already on `/v1/webhooks`); the older `make-petra` checkout still holds the pre-rename contract and is not the source of truth.
- Submission to the n8n Creator Portal is still open — everything it requires technically is in place, and 1.0.0 is the version to submit. Only the repository owner can file it: https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes
