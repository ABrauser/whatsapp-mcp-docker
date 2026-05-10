# WhatsApp MCP — Status & Open Tasks

Stand: 2026-05-10. Lebt im Repo, damit der Kontext nicht mit dem Chat verloren geht.

## ✅ Production-Ready Hardening — abgeschlossen (siehe Commit-Verlauf)

- **Schema-Versioning** — `src/migrations.ts` mit `schema_migrations`-Tabelle. Jede Migration läuft genau einmal in eigener Transaktion. Aktuelle Versionen 1–3.
- **`sender_push_name`** auf `messages` — Always-Capture aus `msg.pushName`. Behebt "Unknown" für Sticker / Media-Messages ohne `key.participant`.
- **`contacts_resolved` SQL-View** — DRY: alle Read-Queries (`getChats`, `getChat`, `getMessages`, `getRecentMessages`, `getMessagesAround`, `searchMessages`, `searchDbForContacts`) joinen jetzt einen einzigen View statt drei duplizierte CASE-WHEN-Blöcke zu pflegen.
- **Fuzzy Match (Wort-Overlap)** — `src/contactResolver.ts`. "Mary Grace Bauer" → "Mary Bauer" wenn genau ein eindeutiger Match in den `@s.whatsapp.net`-Kontakten existiert. Min. 2 Tokens beim Saved-Name als False-Positive-Guard. Cache wird beim Contact-Write invalidated.
- **Test Suite** — 22 Tests in `test/` (`node --test`): Resolver, Migrations, Overrides. Alle grün.
- **CI** — `typecheck` und `test` Jobs gaten den Docker-Build (`needs: [typecheck, test]`).
- **Log Rotation** — `pino-roll`: 10 MB Chunks, daily Rotation, 7-Tage-Retention. Fallback auf `pino.destination` bei FS-Fehler.
- **Rate Limiting** — `express-rate-limit` auf `/sse`, default 120 req/min/IP, anpassbar via `MCP_RATE_LIMIT_PER_MIN`.
- **Audit Log** — strukturiertes `audit: "send_message"` und `audit: "send_message_success"` Event auf jedem Send mit Empfänger, Länge und 80-char Preview.

## 🟢 Nice-to-Have (offen, ohne Druck)

- **Separate `push_name`-Spalte auf `contacts`** — aktuell wird sowohl Baileys' `notify` als auch der msg-`pushName` in der `notify`-Spalte abgelegt. Funktional korrekt, datenmodelltechnisch aber überladen. Eigene Spalte wäre sauberer.
- **Konsistentes Logging** — manche Stellen `console.log/error`, andere `pinoLogger.*`. Auf pino vereinheitlichen, am besten mit Child-Loggern pro Subsystem.
- **`storeMessage` Resolver-Cache** — `storeMessagesBatch` hat einen per-Batch-Cache, `storeMessage` (single) nicht. Bei Bursts via `messages.upsert` läuft der Resolver pro Message neu (Latency-impact <1ms, eher Kosmetik).
- **TLS / Reverse-Proxy** — Caddy/Traefik-Snippet im README ergänzen.
- **`refresh_groups` MCP-Tool** — explizites Tool um Gruppennamen-Sync auszulösen, statt nur Lazy-Trigger via `list_chats`.
- **Init-Query-Timeout (Baileys-Internal)** — gelegentlicher 408-Fehler beim Connect. Mitigation: bei diesem konkreten Error explizit reconnect + Backoff erhöhen.
- **README** — Beispiele für `list_recent_messages` mit konkreten Use-Cases (heute / letzte Stunde / gestern Abend).

## 📋 Aktueller Code-Stand

**Tools (8):**

1. `search_contacts` — Kontakte suchen
2. `list_messages` — Messages eines Chats (mit `since`/`until`)
3. `list_recent_messages` — Cross-Chat Time-Window
4. `list_chats` — Chats auflisten (sortiert)
5. `get_chat` — Chat-Details
6. `get_message_context` — Messages um eine Message herum
7. `send_message` — Nachricht senden (mit Audit-Log)
8. `search_messages` — FTS5 Volltext-Suche

**Auth:** Bearer-Token via `MCP_AUTH_TOKEN`. Tolerant gegenüber Scheme-Casing und Whitespace. Diagnostische 401-Logs (truncated token hint).

**Rate Limit:** 120 req/min/IP auf `/sse`, anpassbar via `MCP_RATE_LIMIT_PER_MIN`.

**Transport:** Streamable HTTP (POST `/sse`). Gemini CLI: `httpUrl`. Andere Clients: `url`.

**Daten-Volumes:**

- `/app/data` — DB, rotierte Logs, `contact_overrides.json`
- `/app/auth_info` — WhatsApp Pairing

**Contact-Name Resolution (Reihenfolge):**

1. Manual Override aus `contact_overrides.json`
2. Saved Address-Book Name (DB `name`-Spalte / `contacts_resolved` View)
3. Fuzzy Wort-Overlap (push name → eindeutiger saved name)
4. Push Name (msg.pushName, in `sender_push_name`)
5. JID-Prefix
6. "Unknown"

## 🛡️ Security Checklist

- [x] Bearer-Token mit case-insensitive Schema, Trim, redacted Logs
- [x] Rate-Limit auf `/sse`
- [x] Audit-Log auf `send_message`
- [x] Health-Check 503 bei WhatsApp-Disconnect
- [x] Per-Request McpServer (kein Listener-Leak)
- [x] Log-Rotation (Disk-Voll-Schutz)
- [ ] TLS/Reverse-Proxy-Doku
- [ ] Sender-IP-basiertes Rate-Limit-Tuning für vertrauenswürdige LANs

## 🧪 Tests laufen lassen

```bash
npm test
```

Erwartete Ausgabe: 22 pass, 0 fail.

## 📦 Image bauen

```bash
docker build -t whatsapp-mcp-docker:dev .
```

CI macht das automatisch bei jedem Push auf `main`. Image landet auf `ghcr.io/<owner>/whatsapp-mcp-docker:latest`.
