/**
 * Manual contact-name overrides.
 *
 * Loads `<dataDir>/contact_overrides.json` as a `{ jid: displayName }` map.
 * Hot-reloaded via `fs.watch` so edits take effect without a container restart.
 *
 * The override takes priority over both the saved `name` and the WhatsApp
 * `notify` (push name) when formatting MCP responses. Useful for the @lid /
 * @s.whatsapp.net split where Baileys cannot link the two halves of the same
 * contact and the user's address-book name is on a different row than the
 * @lid that actually appears in messages.
 */

import fs from "node:fs";
import path from "node:path";

let overrides: Record<string, string> = {};
let watcher: fs.FSWatcher | null = null;
let overridePath: string | null = null;

function readFromDisk(file: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Coerce all values to non-empty strings, drop the rest.
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.trim().length > 0) {
          clean[k] = v.trim();
        }
      }
      return clean;
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[overrides] Failed to read ${file}: ${err.message}`);
    }
  }
  return {};
}

export function initContactOverrides(dataDir: string): void {
  overridePath = path.join(dataDir, "contact_overrides.json");
  overrides = readFromDisk(overridePath);
  const count = Object.keys(overrides).length;
  if (count > 0) {
    console.log(`[overrides] Loaded ${count} contact name override(s) from ${overridePath}`);
  }

  // Hot reload — debounced because editors fire multiple events per save.
  let reloadTimer: NodeJS.Timeout | null = null;
  try {
    watcher = fs.watch(dataDir, (_event, filename) => {
      if (!filename || filename !== "contact_overrides.json") return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        const next = readFromDisk(overridePath!);
        const before = Object.keys(overrides).length;
        overrides = next;
        const after = Object.keys(overrides).length;
        console.log(`[overrides] Reloaded: ${before} → ${after} entries`);
      }, 250);
    });
  } catch (err: any) {
    console.warn(`[overrides] fs.watch failed (hot reload disabled): ${err.message}`);
  }
}

export function closeContactOverrides(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }
}

/**
 * Look up an override for a JID. Returns the override string if present,
 * otherwise null.
 */
export function getOverride(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return overrides[jid] ?? null;
}

/** Snapshot for diagnostics. */
export function listOverrides(): Record<string, string> {
  return { ...overrides };
}
