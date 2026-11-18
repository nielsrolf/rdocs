// Masking of credentials in text that r-docs is about to STORE or show:
// run events (tool output), run errors, transcripts on disk.
//
// Why this exists: a tool result is whatever a command printed. Until 2026-11
// a `git push` printed the user's GitHub token (it was part of the remote URL)
// and 540 run events kept it. The token no longer enters the sandbox
// (lib/credential-broker), and this is the second line: whatever secret a run
// does hold, or an agent stumbles over, is masked before it is persisted.
//
// A masked value keeps its length and a short readable prefix; the rest is
// `*`. Same length means a file can be masked in place while another process
// still appends to it, and `*` is outside every shape, so masking is idempotent.

import fs from "node:fs/promises";
import path from "node:path";

import shapeFile from "./secret-shapes.json";

type Shape = { name: string; regex: RegExp; prefix: number };

const SHAPES: Shape[] = shapeFile.shapes.map((shape) => ({
  name: shape.name,
  regex: new RegExp(`${shapeFile.boundary}${shape.pattern}`, "g"),
  prefix: shape.prefix
}));
const PRIVATE_KEY = new RegExp(shapeFile.privateKey.pattern, "g");
export const PRIVATE_KEY_NAME = shapeFile.privateKey.name;

export type RedactionCounts = Record<string, number>;

function count(counts: RedactionCounts | undefined, name: string) {
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
}

function maskKeepingPrefix(value: string, prefix: number) {
  return value.slice(0, prefix) + "*".repeat(Math.max(0, value.length - prefix));
}

/**
 * Mask every known secret value and every well-known credential shape in
 * `text`. Length-preserving. `knownValues` are exact secrets of the run at
 * hand (see rememberRunSecrets); they are masked completely.
 */
export function redactSecrets(
  text: string,
  knownValues?: Iterable<string> | null,
  counts?: RedactionCounts
): string {
  let out = text;
  if (knownValues) {
    for (const value of knownValues) {
      if (value.length < 8 || !out.includes(value)) continue;
      out = out.split(value).join("*".repeat(value.length));
      count(counts, "secret of this run");
    }
  }
  for (const shape of SHAPES) {
    shape.regex.lastIndex = 0;
    out = out.replace(shape.regex, (match) => {
      count(counts, shape.name);
      return maskKeepingPrefix(match, shape.prefix);
    });
  }
  PRIVATE_KEY.lastIndex = 0;
  out = out.replace(PRIVATE_KEY, (_match, begin: string, body: string) => {
    // Keep whitespace and escaped newlines so the surrounding JSON stays valid.
    const masked = body.replace(/\\+[rn]|[A-Za-z0-9+/=]/g, (piece) => (piece.startsWith("\\") ? piece : "*"));
    if (masked !== body) count(counts, PRIVATE_KEY_NAME);
    return begin + masked;
  });
  return out;
}

// --- secrets a run is known to hold ------------------------------------------

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MAX_REMEMBERED_RUNS = 400;
const runSecrets = new Map<string, Set<string>>();

/**
 * Remember the secret values of a run's environment (by variable name), so
 * tool output that echoes one is masked even when it has no well-known shape.
 * In memory, per server process: a run adopted by another process after a
 * deploy falls back to shape masking only.
 */
export function rememberRunSecrets(aiRunId: string, env: Record<string, string | undefined>) {
  const values = runSecrets.get(aiRunId) ?? new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    if (/^https?:\/\/[^@\s]*$/.test(value) || /^(true|false|\d+)$/i.test(value)) continue;
    values.add(value);
  }
  if (values.size === 0) return;
  runSecrets.delete(aiRunId);
  runSecrets.set(aiRunId, values);
  while (runSecrets.size > MAX_REMEMBERED_RUNS) {
    const oldest = runSecrets.keys().next().value;
    if (oldest === undefined) break;
    runSecrets.delete(oldest);
  }
}

export function knownRunSecrets(aiRunId: string): Set<string> | undefined {
  return runSecrets.get(aiRunId);
}

// --- files ---------------------------------------------------------------------

const CHUNK = 8 << 20;
// Longer than any token and than a 16k-bit RSA key in PEM.
const OVERLAP = 64 << 10;

/**
 * Mask secrets in a file IN PLACE, without changing its size or replacing it,
 * so a process that still appends to it (a CLI writing its transcript) is not
 * disturbed. Returns how many places were masked.
 */
export async function redactFileInPlace(
  file: string,
  knownValues?: Iterable<string> | null,
  counts?: RedactionCounts
): Promise<number> {
  const known = knownValues ? [...knownValues] : null;
  const handle = await fs.open(file, "r+");
  let changed = 0;
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, CHUNK + OVERLAP));
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      // latin1: one byte is one character, so offsets and lengths carry over.
      const text = buffer.toString("latin1", 0, bytesRead);
      const masked = redactSecrets(text, known, counts);
      if (masked !== text) {
        let start = 0;
        while (start < text.length) {
          if (text[start] === masked[start]) {
            start += 1;
            continue;
          }
          let end = start;
          while (end < text.length && text[end] !== masked[end]) end += 1;
          await handle.write(Buffer.from(masked.slice(start, end), "latin1"), 0, end - start, position + start);
          changed += 1;
          start = end;
        }
      }
      if (position + bytesRead >= size) break;
      position += Math.max(1, bytesRead - OVERLAP);
    }
  } finally {
    await handle.close();
  }
  return changed;
}

/**
 * Mask secrets in every regular file under `dir` modified at or after `since`.
 * Best effort: unreadable entries are skipped. Symlinks are never followed.
 */
export async function redactDirectoryInPlace(
  dir: string,
  opts: { since?: Date; knownValues?: Iterable<string> | null; maxFiles?: number } = {}
): Promise<{ files: number; masked: number }> {
  const known = opts.knownValues ? [...opts.knownValues] : null;
  const result = { files: 0, masked: 0 };
  const pending = [dir];
  const limit = opts.maxFiles ?? 5000;
  while (pending.length > 0 && result.files < limit) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || (opts.since && stat.mtime < opts.since)) continue;
        result.files += 1;
        result.masked += await redactFileInPlace(full, known).catch(() => 0);
      }
    }
  }
  return result;
}
