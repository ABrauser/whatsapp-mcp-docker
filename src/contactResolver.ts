/**
 * Word-overlap contact name resolver.
 *
 * Some contacts present a push name that differs from the user's saved
 * address-book name (e.g. push="Mary Grace Bauer", saved="Mary Bauer"). The
 * SQL view `contacts_resolved` only does exact-string matches and falls back
 * to the push name in this case. This module adds a JS-level word-overlap
 * lookup so that "Mary Grace Bauer" → "Mary Bauer" resolves *only* when there
 * is exactly one matching saved contact.
 *
 * The lookup is read-only and never used on write paths — a wrong fuzzy match
 * here only displays the wrong label; it cannot misroute a sent message.
 */
import type { DatabaseSync } from "node:sqlite";

interface SavedContact {
  jid: string;
  name: string;
  tokens: string[];
}

let cache: SavedContact[] | null = null;

/**
 * Tokenize a name: lowercase, split on whitespace, drop empties.
 * Order is preserved so callers can compare with `every`.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Drop the cache so the next call rebuilds from the current DB state. */
export function invalidateContactResolverCache(): void {
  cache = null;
}

function loadCache(db: DatabaseSync): SavedContact[] {
  if (cache) return cache;
  try {
    const rows = db
      .prepare(
        `SELECT jid, name FROM contacts WHERE jid LIKE '%@s.whatsapp.net' AND name IS NOT NULL AND TRIM(name) != ''`,
      )
      .all() as { jid: string; name: string }[];
    cache = rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      tokens: tokenize(r.name),
    }));
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * Find the user-saved contact name that best matches a push name via
 * word-overlap. Strict rules to avoid false positives:
 *   1. Saved name has at least 2 tokens (avoid matching solo "Sami" against
 *      every "Sami X").
 *   2. Every token of the saved name appears in the push name's token set.
 *   3. Exactly one such saved contact exists. Multiple matches → no result.
 *
 * Returns the saved name + JID, or null. Used only by the display formatter.
 *
 * @param pushName the WhatsApp push name to resolve.
 * @param db the database handle to load saved contacts from.
 */
export function resolveByPushName(
  pushName: string | null | undefined,
  db: DatabaseSync,
): { jid: string; name: string } | null {
  if (!pushName) return null;
  const pushTokens = tokenize(pushName);
  if (pushTokens.length === 0) return null;

  const saved = loadCache(db);
  const pushSet = new Set(pushTokens);

  const matches: SavedContact[] = [];
  for (const sc of saved) {
    if (sc.tokens.length < 2) continue;
    // Saved name's tokens must be a subset of push name's tokens.
    if (sc.tokens.every((t) => pushSet.has(t))) {
      matches.push(sc);
      if (matches.length > 1) return null; // ambiguous — bail early
    }
  }

  return matches.length === 1 ? { jid: matches[0].jid, name: matches[0].name } : null;
}
