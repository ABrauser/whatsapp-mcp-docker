import fs from "node:fs";
import path from "node:path";

/**
 * Ensure `dir` exists and is writable by the current process, including every
 * directory entry selected by `mustWrite`. The entry check catches a
 * `chown` without `-R` (directory owned by us, files inside still root's).
 *
 * Returns the first offending path with the fs error code, or null if
 * everything is writable.
 */
export function findUnwritable(
  dir: string,
  mustWrite: (name: string) => boolean,
): { path: string; code: string } | null {
  let current = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    for (const entry of fs.readdirSync(dir).filter(mustWrite)) {
      current = path.join(dir, entry);
      fs.accessSync(current, fs.constants.W_OK);
    }
    return null;
  } catch (err: any) {
    return { path: current, code: err.code ?? String(err.message) };
  }
}

/**
 * Files the app itself writes into the data dir: the SQLite db with its side
 * files, and the pino-roll logs (`wa-logs.txt.<date>.<n>`, or the plain
 * `*-logs.txt` fallback). Anything else there — e.g. a root-edited
 * contact_overrides.json or a manual `whatsapp.db.bak` — is never written and
 * must not block startup.
 */
export function isAppDataFile(name: string): boolean {
  return /^whatsapp\.db(-wal|-shm|-journal)?$/.test(name) || /^(wa|mcp)-logs\.txt/.test(name);
}
