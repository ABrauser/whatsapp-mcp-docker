# WhatsApp MCP — Open Tasks & Tech Debt

Stand: 2026-05-10. Lebt im Repo, damit der Kontext nicht mit dem Chat verloren geht.

## 🔴 Pending: User-Validation

Diese Fixes sind committed + deployed, aber der User testet noch ob sie das eigentliche Symptom lösen:

- [ ] **Auto-Linking @lid ↔ @s.whatsapp.net via `pushName`** (`cc5c26b`)
  - Erfolgskriterium: Tammy (`210444891463794@lid`) wird in MCP-Output als "Tammy" angezeigt, **ohne** dass `contact_overrides.json` angelegt wurde.
  - Voraussetzung: Tammy hat seit Container-Start mindestens eine Message geschickt (oder History-Sync hatte ihre alten Messages).
  - Falls nicht: Fallback via `contact_overrides.json` testen.

- [ ] **Phone-Backfill aus JID** (`b11ec95`)
  - Erfolgskriterium: Beim Startup-Log erscheint `[Migrate] Backfilled phone_number on N contacts.` mit N > 0.
  - Folge-Effekt: Mehr `@lid`-Chats sollten sich zu ihren `@s.whatsapp.net`-Gegenstücken auflösen.

- [ ] **DB-Discrepancy `chats=1, messages=3488`**
  - Wenn nach Restart immer noch nur 1 Chat in `chats`-Tabelle steht: Bug in Migration. Diagnose-Queries siehe Chat-Verlauf.
  - Vermutung: Race zwischen User-SQL-Query und 5s-delayed `groupFetchAllParticipating()`.

## 🟡 Tech Debt — Production-Grade

Reihenfolge nach Wert:

### 1. Schema-Versioning + nummerierte Migrationen (~1h)

**Problem:** `initializeDatabase()` führt alle Migrations bei jedem Start aus. Idempotent, aber:
- Wenn eine Migration fehlerhaft wird, läuft sie endlos in Schleife.
- Keine klare Trennung zwischen "initial schema" und "migration X applied later".

**Lösung:**
- Tabelle `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)`.
- Pro Migration eine Funktion mit Versionsnummer.
- Run-once-Logik: nur ausführen wenn `version` noch nicht in der Tabelle.
- Alternative: leichtgewichtige Lib wie `node-better-sqlite3-migrations` oder eigene Mini-Implementierung.

**Files:** `src/database.ts` — `initializeDatabase()` aufsplitten.

### 2. Test-Suite — `node --test` (~2-3h)

**Problem:** Null automatische Tests. Refactors werden in Production "validiert".

**Mindest-Coverage:**
- `src/database.ts`:
  - `resolveJidPhoneOnly()` — null/undefined/non-LID/LID-mit-phone/LID-ohne-phone
  - `resolveJidSync()` — phone wins, fuzzy fallback, no-match
  - `storeContact()` mit/ohne phone_number → korrekter Backfill
  - `storeMessage()` updates `last_message_time` korrekt
  - `getRecentMessages()` mit since/until/chat_jid
- `src/mcp.ts`:
  - `formatDbMessageForJson()` — Override > sender_name > JID-prefix > "Unknown"
  - `formatDbChatForJson()` — Override > name > JID-prefix
  - `is_from_me` setzt sender_display="Me" auch wenn sender JID gesetzt ist
- `src/contactOverrides.ts`:
  - Load von valid/invalid/missing JSON
  - Hot-Reload via fs.watch (mit Mock-Timer)

**Setup:**
- In-Memory SQLite via `:memory:` für DB-Tests.
- `node --test --experimental-strip-types` (Node 24+).
- CI-Step in `.github/workflows/docker-build.yml` zwischen `typecheck` und `build-and-push`.

### 3. DRY: `contacts_resolved` View (~30min)

**Problem:** Die `COALESCE(c.name, ct.name, CASE WHEN @lid THEN ... END, ct.notify, ct.phone_number)`-Logik ist **dreifach** dupliziert in:
- `src/database.ts` — `getChats()`
- `src/database.ts` — `getChat()`
- `src/database.ts` — `searchDbForContacts()`

**Lösung:** SQLite-View bei DB-Init:
```sql
CREATE VIEW IF NOT EXISTS chats_resolved AS
SELECT
  c.jid,
  c.last_message_time,
  COALESCE(
    c.name,
    ct.name,
    CASE WHEN c.jid LIKE '%@lid' AND ct.notify IS NOT NULL THEN
      (SELECT ct2.name FROM contacts ct2
       WHERE ct2.jid LIKE '%@s.whatsapp.net'
       AND ct2.notify = ct.notify AND ct2.name IS NOT NULL LIMIT 1)
    END,
    ct.notify,
    ct.phone_number
  ) as resolved_name
FROM chats c
LEFT JOIN contacts ct ON c.jid = ct.jid;
```
Dann nur noch `SELECT resolved_name FROM chats_resolved WHERE jid = ?` in den drei Funktionen.

## 🟢 Nice-to-Have

### 4. Separate `push_name`-Spalte (~30min)

`notify` (aus contacts.upsert) und `pushName` (aus messages.upsert) sind aktuell in der gleichen Spalte. Semantisch identisch, technisch nicht 100% sauber.

- Migration: `ALTER TABLE contacts ADD COLUMN push_name TEXT`.
- Auto-Link-Logik in `whatsapp.ts` schreibt in `push_name` statt `notify`.
- Resolver-COALESCE: `name → notify → push_name → phone_number`.

### 5. Log-Rotation via `pino-roll`

`/app/data/wa-logs.txt` und `mcp-logs.txt` wachsen unbegrenzt. Docker-Logging-Driver mildert das ab, aber sauber wäre:
```ts
import { multistream } from "pino";
import roll from "pino-roll";

pino(opts, await roll({
  file: `${dataDir}/wa-logs`,
  size: "10m",
  frequency: "daily",
  limit: { count: 7 },
}));
```

### 6. Konsistentes Logging

Manche Stellen `console.error/log`, andere `pinoLogger.error/info`. Auf pino vereinheitlichen.

### 7. `storeMessage` Resolver-Cache

`storeMessagesBatch` hat einen per-Batch Resolver-Cache, `storeMessage` (single) nicht. Bei Bursts in `messages.upsert` läuft der Resolver pro Message neu. Mini-Optimierung — kann ein modul-globaler LRU mit ~100 Einträgen werden, der bei Schreibvorgang invalidiert wird.

### 8. Lazy Group-Fetch auf Abruf via MCP-Tool

Aktuell triggert `list_chats` einen Lazy-Group-Fetch wenn unbenannte Gruppen erkannt werden. Sauberer: separates MCP-Tool `refresh_groups` plus Auto-Trigger.

### 9. Init-Query-Timeout (Baileys)

Im wa-logs.txt taucht gelegentlich `unexpected error in 'init queries' / Timed Out (408)` auf. Ist ein Baileys-Internal, nicht direkt fixbar. Mögliche Mitigation: Reconnect-Logik bei diesem spezifischen Error eskalieren statt nur zu warten.

### 10. README — Beispiele für `list_recent_messages`

Aktuell nur in der Tools-Tabelle erwähnt. Quick-Use-Cases ergänzen:
- "Was hat sich heute getan?" → `hours=24`
- "Letzte Stunde in Familien-Gruppe" → `hours=1, chat_jid=...@g.us`
- "Aktivität gestern Abend" → `since=YYYY-MM-DDT19:00:00, until=YYYY-MM-DDT23:59:59`

## 🛡️ Security TODO

- [ ] **TLS via Reverse Proxy** dokumentieren mit konkretem Caddy-/Traefik-Snippet.
- [ ] **Rate-Limiting auf `/sse`** — aktuell kann ein böser Bearer-Token-Holder ungebremst spammen. Express-Rate-Limit-Middleware ergänzen.
- [ ] **Audit-Log** für `send_message` — jede gesendete Nachricht im Server-Log mit Tool-Caller-Info, damit nachvollziehbar wer was geschickt hat.

## 📋 Aktueller Code-Stand

**Letzter Commit:** `cc5c26b` — feat(contacts): auto-link @lid to @s.whatsapp.net via captured pushName

**Image:** `ghcr.io/abrauser/whatsapp-mcp-docker:latest` (multi-arch amd64+arm64)

**Tools (8):**
1. `search_contacts` — Kontakte suchen
2. `list_messages` — Messages eines Chats (mit `since`/`until`)
3. `list_recent_messages` — Cross-Chat Time-Window (NEU)
4. `list_chats` — Chats auflisten (sortiert)
5. `get_chat` — Chat-Details
6. `get_message_context` — Messages um eine Message herum
7. `send_message` — Nachricht senden
8. `search_messages` — FTS5 Volltext-Suche

**Auth:** Bearer-Token via `MCP_AUTH_TOKEN`. Diagnostische 401-Logs (truncated token hint).

**Transport:** Streamable HTTP (POST `/sse`). Gemini CLI: `httpUrl`. Andere Clients: `url`.

**Daten-Volumes:**
- `/app/data` (DB, Logs, `contact_overrides.json`)
- `/app/auth_info` (WhatsApp Pairing)
