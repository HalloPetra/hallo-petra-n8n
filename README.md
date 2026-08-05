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

Sendet die synchrone Antwort an HalloPetra — strukturiert in genau dem Format, das der Petra-Agent erwartet:

```json
{
	"contact": {
		"contact_data_name": "Max Mustermann",
		"contact_data_email": "max@mustermann.de",
		"contact_data_phone": "+491234567890",
		"contact_data_address": "Musterstraße 1, 12345 Musterstadt"
	},
	"other_data": { "data_1": "Wert 1" },
	"content": "Daten als String oder JSON"
}
```

Im Node füllt man die Kontaktfelder, beliebige Key-Value-Paare („Other Data") und den Content (None/Text/JSON) — Expressions funktionieren in allen Feldern. **Alle Abschnitte sind optional:** Was nicht befüllt ist, taucht in der Response gar nicht auf (kein leeres Objekt, kein leerer String). **End-Node ohne Ausgänge:** Hier endet der synchrone Teil des Workflows. Wer nach der Antwort noch weiterarbeiten will (z. B. Logging), zweigt vor dem Finish-Node in einen parallelen Ast ab — die Antwort geht raus, sobald der Finish-Node läuft.

### Petra Events Trigger (Polling)

Pollt den HalloPetra-Event-Feed (minimal jede Minute) und startet den Workflow mit einem Batch neuer Events. Jedes Item enthält unter `_petra` Metadaten (`eventId`, `attempt`), die der Retry-Node nutzt.

**Semantik: Default = erledigt.** Ein Event gilt als verarbeitet, sobald es zugestellt wurde — außer ein **Petra Retry on Next Poll**-Node fordert die erneute Zustellung an. Der einzige Client-Zustand ist der Feed-Cursor (Workflow Static Data, geschrieben ausschließlich vom Poller).

### Petra Retry on Next Poll

Gehört in den **Fehlerpfad** des Workflows (Error-Output eines Nodes bzw. „Continue (using error output)") und ist ein **End-Node ohne Ausgänge**. Ruft `POST /events/{id}/redeliver` auf — das Event erscheint daraufhin **erneut im Feed** (hinter dem Cursor, mit hochgezähltem `attempt`) und wird beim nächsten Poll wieder zugestellt.

- **Fibonacci-Backoff:** Die Wartezeit bis zur erneuten Zustellung wächst mit jedem Fehlversuch: `Backoff Base` (Default 60 s) × 1, 2, 3, 5, 8, … Der Node gibt sie als `delaySeconds` an die API weiter; HalloPetra macht das Event erst danach wieder im Feed sichtbar.
- **Failure-Report:** Ab „Max Attempts" (Default 5) wird nicht mehr redelivered — der Node meldet den endgültigen Fehlschlag per `POST /events/{id}/failed` an HalloPetra (abschaltbar), damit er dem Betrieb in der App angezeigt werden kann. Danach ist das Event für die Extension erledigt; ein manueller Neuversuch ist eine reine Server-Aktion (Event wieder in den Feed einreihen).

> **Warum Redeliver statt lokalem Retry-Speicher?** n8n teilt Workflow Static Data nicht live zwischen dem Trigger (läuft gecacht im Main-Prozess) und den Workflow-Executions — eine vom Retry-Node gesetzte Markierung würde der Poller nie sehen (im E2E-Test verifiziert). Der Redeliver-Weg funktioniert dagegen auch im Queue-Mode und macht den Poller zum einzigen Schreiber des Cursors.

**Regeln für zuverlässige Retries:**

- Fehler müssen **im selben Workflow** über Error-Outputs abgefangen werden, damit der Retry-Node überhaupt läuft. Crasht eine Execution unabgefangen, wird das Event **nicht** erneut zugestellt (Best-Effort-Design).
- Die Zustellung ist **at-least-once** — Workflows sollten idempotent sein.
- Der Feed-Cursor liegt in n8ns Workflow Static Data. Diese wird **nur bei aktiven (produktiven) Workflows** persistiert; im Editor-Testmodus liefert der Trigger deshalb die letzten Events, ohne den Cursor zu verändern.

## Einrichtung

1. Package installieren (n8n → Settings → Community Nodes → `n8n-nodes-petra`).
2. In der HalloPetra-App einen API-Key für die Integration erstellen.
3. In n8n ein **Petra API**-Credential anlegen und den API-Key eintragen.
4. Trigger-Node in einen Workflow ziehen, Credential auswählen, Workflow aktivieren — die Webhook-Registrierung passiert automatisch.

## Erwarteter API-Kontrakt (Spezifikation für das HalloPetra-Backend)

Alle Requests: `Authorization: Bearer <API-Key>`, User-Agent `n8n-nodes-petra/<version>`.

| Endpunkt | Zweck |
| --- | --- |
| `GET /events/types` | Verfügbare Feed-Event-Typen: `{ types: [{ slug, label, description? }] }` — wird auch als Auth-Check für den Credential-Test benutzt (existiert bereits, Make-Integration nutzt ihn) |
| `GET /webhooks/types` | Verfügbare synchrone Hook-Typen, gleiches Format |
| `POST /webhooks` | Webhook registrieren: Body `{ event, url }` → `{ id, secret }`; mit `secret` signiert HalloPetra eingehende Calls (HMAC-SHA256 des Raw-Body, Header `X-Petra-Signature`, hex) |
| `GET /webhooks/{id}` | Registrierung prüfen → `{ id, event, url }` |
| `DELETE /webhooks/{id}` | Webhook deregistrieren |
| `GET /events?after=<cursor>&limit=<n>&types=<a,b>` | Feed: `{ events: [{ id, type, occurredAt, attempt, payload }], nextCursor }` — Cursor monoton und stabil, Reihenfolge garantiert, `attempt` startet bei 1 |
| `POST /events/{id}/redeliver` | Body `{ attempt, delaySeconds }`: Event nach `delaySeconds` erneut in den Feed einreihen (neue Sequenznummer erst bei Sichtbarkeit vergeben, damit der Cursor monoton bleibt) — Grundlage der Retry-Mechanik mit Backoff |
| `POST /events/{id}/failed` | Body `{ attempts, reason? }`: Event ist endgültig gescheitert (Max Attempts erreicht) — dem Betrieb in der HalloPetra-App anzeigen |

Beim synchronen Aufruf sollte HalloPetra mit Timeout und definiertem Fallback arbeiten — die Antwortzeit hängt von der n8n-Instanz des Kunden ab.

## Entwicklung

```bash
npm install --legacy-peer-deps   # Dependencies installieren
npm run dev                      # Startet lokal ein n8n mit diesem Package verlinkt (Hot Reload)
npm run build                    # Kompiliert nach dist/
npm run lint                     # Linting mit den n8n-Community-Node-Regeln
```

`npm run dev` startet eine lokale n8n-Instanz (standardmäßig unter http://localhost:5678), in der die Nodes aus diesem Package direkt verfügbar sind und bei Änderungen neu geladen werden.

### E2E-Test mit Docker (OrbStack)

Unter `test/` liegt ein E2E-Setup, das das Package als echtes Community-Package in einem n8n-Docker-Container testet:

```bash
npm run build && npm pack --pack-destination /tmp        # Tarball bauen
node test/mock-petra-api.js &                            # Mock-Petra-API auf Port 7788

# n8n-Container: Package installieren, dann starten
DATA=$(mktemp -d) && chmod 777 "$DATA"
docker run --rm -v "$DATA:/home/node/.n8n" -v /tmp/n8n-nodes-petra-0.1.0.tgz:/tmp/petra.tgz \
  --entrypoint sh n8nio/n8n:latest -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install /tmp/petra.tgz"
docker run -d --name n8n-petra -p 5678:5678 -v "$DATA:/home/node/.n8n" \
  -e N8N_SECURE_COOKIE=false n8nio/n8n:latest

node test/e2e-test.js phase1   # Owner-Setup, Credential, Sync-Webhook-Roundtrip inkl. Signaturprüfung
node test/e2e-test.js phase2   # Events-Workflow mit Fehlerpfad + Retry-Node aktivieren
sleep 150
node test/e2e-test.js phase3   # Retry-Zustellung, Cursor-Fortschritt und Executions prüfen
```

Die Mock-API erwartet den API-Key `test-key`; aus dem Container heraus ist sie über `http://host.docker.internal:7788` erreichbar (im Credential vorkonfiguriert durch das Testskript).

## Neuen Node hinzufügen

1. Ordner unter `nodes/<NodeName>/` anlegen mit `<NodeName>.node.ts`.
2. Den Node in `package.json` unter `n8n.nodes` registrieren (Pfad zur kompilierten `.js`-Datei in `dist/`).
3. Credentials kommen analog nach `credentials/` und werden unter `n8n.credentials` registriert.

Doku: [Creating nodes](https://docs.n8n.io/integrations/creating-nodes/)
