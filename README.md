# n8n-nodes-petra

Community-Node-Package für n8n, das [HalloPetra](https://hallopetra.de) mit n8n-Workflows verbindet. Basierend auf dem offiziellen [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter).

Das Package deckt zwei Anwendungsfälle ab:

1. **Synchroner Webhook (z. B. Pre-Call):** HalloPetra ruft vor einem Anruf einen in n8n registrierten Webhook auf und wartet synchron auf die Antwort des Workflows.
2. **Event-Feed:** Workflows reagieren auf HalloPetra-Ereignisse (z. B. „Anruf beendet"), die über einen gepollten HTTP-Feed zugestellt werden — inklusive Retry-Mechanik für fehlgeschlagene Verarbeitungen.

## Nodes

### Petra Webhook Trigger (synchron)

Registriert beim Aktivieren des Workflows automatisch einen Webhook über die HalloPetra-API (und deregistriert ihn beim Deaktivieren). Im Node wählt man den Hook-Typ (z. B. `pre_call`). Eingehende Aufrufe werden per HMAC-SHA256-Signatur (`X-Petra-Signature`) verifiziert.

**Antwortmodus:** Standardmäßig antwortet der Workflow über einen **Petra Finish**-Node („Respond: Using Petra Finish Node"). Alternativ kann sofort („Immediately") oder mit dem Output des letzten Nodes („When Last Node Finishes") geantwortet werden.

> **Wichtig (self-hosted):** Die n8n-Instanz muss ihre öffentliche URL kennen (`WEBHOOK_URL`-Umgebungsvariable, v. a. hinter einem Reverse-Proxy), sonst wird eine nicht erreichbare URL bei HalloPetra registriert. Auf n8n Cloud ist nichts zu tun.

### Petra Finish

Sendet die synchrone HTTP-Antwort an HalloPetra zurück — mit dem ersten Input-Item, allen Items oder einem eigenen JSON-Body. Der Workflow darf danach weiterlaufen (z. B. für Logging), die Antwort ist dann aber bereits raus.

### Petra Events Trigger (Polling)

Pollt den HalloPetra-Event-Feed (minimal jede Minute) und startet den Workflow mit einem Batch neuer Events. Jedes Item enthält unter `_petra` Metadaten (`eventId`, `attempt`), die der Retry-Node nutzt.

**Semantik: Default = erledigt.** Ein Event gilt als verarbeitet, sobald es zugestellt wurde — außer ein **Petra Event Retry**-Node markiert es als fehlgeschlagen. Nur markierte Events werden beim nächsten Poll erneut zugestellt (zusammen mit dem neuen Batch).

### Petra Event Retry

Gehört in den **Fehlerpfad** des Workflows (Error-Output eines Nodes bzw. „Continue (using error output)"). Markiert das Event für die erneute Zustellung; ab „Max Attempts" (Default 5) wandert das Item stattdessen in den Output „Given Up" (dahinter lässt sich Dead-Letter-Handling bauen).

**Regeln für zuverlässige Retries:**

- Fehler müssen **im selben Workflow** über Error-Outputs abgefangen werden. Die Retry-Markierung wird nur gespeichert, wenn die Execution erfolgreich endet — n8n-Error-Workflows (separate Workflows) können sie nicht setzen.
- Crasht eine Execution unabgefangen, wird das Event **nicht** erneut zugestellt (Best-Effort-Design).
- Die Zustellung ist **at-least-once**: Bei überlappenden Executions sind Duplikate möglich — Workflows sollten idempotent sein.
- Cursor- und Retry-Zustand liegen in n8ns Workflow Static Data. Diese wird **nur bei aktiven (produktiven) Workflows** persistiert; im Editor-Testmodus verhält sich der Trigger deshalb anders (er liefert die letzten Events, ohne Zustand zu verändern).

## Einrichtung

1. Package installieren (n8n → Settings → Community Nodes → `n8n-nodes-petra`).
2. In der HalloPetra-App einen API-Key für die Integration erstellen.
3. In n8n ein **Petra API**-Credential anlegen und den API-Key eintragen.
4. Trigger-Node in einen Workflow ziehen, Credential auswählen, Workflow aktivieren — die Webhook-Registrierung passiert automatisch.

## Erwarteter API-Kontrakt (Spezifikation für das HalloPetra-Backend)

Alle Requests: `Authorization: Bearer <API-Key>`, User-Agent `n8n-nodes-petra/<version>`.

| Endpunkt | Zweck |
| --- | --- |
| `GET /me` | Auth-Check für den Credential-Test |
| `GET /webhook-types` | Verfügbare synchrone Hook-Typen: `{ types: [{ slug, label, description? }] }` |
| `GET /event-types` | Verfügbare Feed-Event-Typen, gleiches Format |
| `POST /webhooks` | Webhook registrieren: Body `{ event, url }` → `{ id, secret }`; mit `secret` signiert HalloPetra eingehende Calls (HMAC-SHA256 des Raw-Body, Header `X-Petra-Signature`, hex) |
| `GET /webhooks/{id}` | Registrierung prüfen → `{ id, event, url }` |
| `DELETE /webhooks/{id}` | Webhook deregistrieren |
| `GET /events?after=<cursor>&limit=<n>&types=<a,b>` | Feed: `{ events: [{ id, type, occurredAt, payload }], nextCursor }` — Cursor monoton und stabil, Reihenfolge garantiert |
| `GET /events?ids=<id1>,<id2>` | Events per ID nachladen (für Retries); die Extension chunkt auf max. 50 IDs pro Request |

Beim synchronen Aufruf sollte HalloPetra mit Timeout und definiertem Fallback arbeiten — die Antwortzeit hängt von der n8n-Instanz des Kunden ab.

## Entwicklung

```bash
npm install --legacy-peer-deps   # Dependencies installieren
npm run dev                      # Startet lokal ein n8n mit diesem Package verlinkt (Hot Reload)
npm run build                    # Kompiliert nach dist/
npm run lint                     # Linting mit den n8n-Community-Node-Regeln
```

`npm run dev` startet eine lokale n8n-Instanz (standardmäßig unter http://localhost:5678), in der die Nodes aus diesem Package direkt verfügbar sind und bei Änderungen neu geladen werden.

## Neuen Node hinzufügen

1. Ordner unter `nodes/<NodeName>/` anlegen mit `<NodeName>.node.ts`.
2. Den Node in `package.json` unter `n8n.nodes` registrieren (Pfad zur kompilierten `.js`-Datei in `dist/`).
3. Credentials kommen analog nach `credentials/` und werden unter `n8n.credentials` registriert.

Doku: [Creating nodes](https://docs.n8n.io/integrations/creating-nodes/)
