// Per-conversation Claude Agent SDK session persistence — the seam that gives
// follow-up runs REAL session resume (the model sees all its prior messages
// and tool calls) instead of the plain-text transcript replay.
//
// How it works: the SDK persists every session as a JSONL transcript under
// $CLAUDE_CONFIG_DIR/projects/<escaped-cwd>/<sessionId>.jsonl, and
// query({ options: { resume: sessionId } }) replays it — searching ALL project
// dirs under the config dir, so a per-run worktree cwd is not a problem.
//
//  - Container runner: each conversation gets a host dir under
//    .research-workspaces/<documentId>/sessions/<conversationKey>/, bind-mounted
//    into the container as CLAUDE_CONFIG_DIR. Transcripts survive the container
//    for free (its HOME is tmpfs and dies otherwise).
//  - In-process runner: the same per-conversation dir is passed to agent-core
//    as the CLI's config root. It must NEVER be the host's ~/.claude: the CLI
//    treats a host session found there as a credential fallback, which leaks
//    the operator's account and breaks brokered runs (see
//    resolveAgentConfigDir in agent-core/agent-env.ts).
//  - Self-hosted runner: out of scope — its disk is external; those runs fall
//    back to the transcript replay.
//
// Shell/bash state is NOT part of a session transcript: a resumed run gets a
// fresh worktree recreated from the conversation's branch, exactly the reset
// semantics we want. The conversation key is the ROOT run id of the follow-up
// chain, shared by the agents-tab UI and Slack threads alike.

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { db } from "@/lib/db";
import { agentHarnessForModel } from "@/agent-core/agent-config";

const WORKSPACE_ROOT = path.join(process.cwd(), ".research-workspaces");

// Session transcripts contain tool results (same trust level as worktrees and
// AiRunEvents) — they should not live forever. Dirs untouched for this long
// are garbage-collected; the conversation then falls back to transcript replay.
const SESSION_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sanitizeKey(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "conversation";
}

export function getConversationSessionDir(documentId: string, conversationKey: string) {
  return path.join(WORKSPACE_ROOT, sanitizeKey(documentId), "sessions", sanitizeKey(conversationKey));
}

/**
 * Walk the parentRunId chain to the TRUE root of a conversation (unlike
 * buildConversationHistory, which caps its walk at the replay turn limit —
 * using its rootRunId would silently re-key long conversations). Bounded and
 * cycle-safe; runs from other documents terminate the walk.
 */
export async function resolveConversationRootId(
  documentId: string,
  previousRunId: string | null
): Promise<string | null> {
  let cursorId = previousRunId;
  let rootId: string | null = null;
  const visited = new Set<string>();
  while (cursorId && !visited.has(cursorId) && visited.size < 500) {
    visited.add(cursorId);
    const run: { id: string; parentRunId: string | null; documentId: string } | null =
      await db.aiRun.findUnique({
        where: { id: cursorId },
        select: { id: true, parentRunId: true, documentId: true }
      });
    if (!run || run.documentId !== documentId) break;
    rootId = run.id;
    cursorId = run.parentRunId;
  }
  return rootId;
}

/**
 * Most recent sdkSessionId in the follow-up chain starting at previousRunId.
 * The immediately previous run may predate this feature (or have died before
 * SDK init), so walk upward until a session id is found.
 */
export async function findResumableSessionId(
  documentId: string,
  previousRunId: string | null
): Promise<string | null> {
  let cursorId = previousRunId;
  const visited = new Set<string>();
  while (cursorId && !visited.has(cursorId) && visited.size < 500) {
    visited.add(cursorId);
    const run: {
      parentRunId: string | null;
      documentId: string;
      sdkSessionId: string | null;
    } | null = await db.aiRun.findUnique({
      where: { id: cursorId },
      select: { parentRunId: true, documentId: true, sdkSessionId: true }
    });
    if (!run || run.documentId !== documentId) return null;
    if (run.sdkSessionId) return run.sdkSessionId;
    cursorId = run.parentRunId;
  }
  return null;
}

/** Default config dir the in-process runner's SDK subprocess writes to. */
export function defaultClaudeConfigDir(env: Record<string, string | undefined> = process.env) {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

export function defaultCodexConfigDir(env: Record<string, string | undefined> = process.env) {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/** Codex owns its native rollout layout; only check that an opaque thread id
 * still has a non-empty native session file. Never deserialize it into app DB
 * rows or reconstruct it from the UI event timeline. */
export async function codexSessionExists(configDir: string, sessionId: string): Promise<boolean> {
  const sessionsDir = path.join(configDir, "sessions");
  async function scan(dir: string): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await scan(child)) return true;
      } else if (entry.name.includes(sessionId)) {
        const stat = await fs.stat(child).catch(() => null);
        if (stat?.isFile() && stat.size > 0) return true;
      }
    }
    return false;
  }
  return scan(sessionsDir);
}

/**
 * Whether `configDir` holds a transcript for `sessionId` — i.e. resume can
 * work. Mirrors the SDK's own lookup: `<configDir>/projects/<any project
 * dir>/<sessionId>.jsonl`, non-empty file.
 */
export async function sessionTranscriptExists(configDir: string, sessionId: string): Promise<boolean> {
  const projectsDir = path.join(configDir, "projects");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = await fs.stat(path.join(projectsDir, entry.name, `${sessionId}.jsonl`));
      if (stat.isFile() && stat.size > 0) return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

export type SessionResumePlan = {
  /** Stable key of this conversation (root run id). */
  conversationKey: string;
  /** Host dir bind-mounted as the container's CLAUDE_CONFIG_DIR (created). */
  sessionDir: string;
  /** Session to resume — null means fall back to the transcript replay. */
  resumeSessionId: string | null;
  /**
   * Set when the chain HAS a recorded SDK session but it cannot be resumed
   * (transcript GC'd, deleted, or never written). The run then continues on the
   * lossy transcript replay — a real context downgrade, so callers must SAY SO
   * in the run timeline instead of degrading silently. Null when there was no
   * session to resume in the first place (fresh conversation, pre-feature
   * chain, self-hosted runner), which is not a downgrade of anything.
   */
  resumeUnavailableSessionId: string | null;
};

/**
 * Decide how a conversation run continues: resolve the conversation's stable
 * key + session dir, and — when the chain has a recorded SDK session whose
 * transcript is actually still on disk — the session id to resume. A missing
 * or empty transcript (GC'd dir, pre-feature run, crashed before first write)
 * degrades to the transcript replay rather than failing the run, and reports
 * that downgrade via `resumeUnavailableSessionId` so it can be surfaced.
 */
export async function planSessionResume(input: {
  documentId: string;
  aiRunId: string;
  previousRunId: string | null;
  /** "container" | "inprocess" — decides where transcripts are looked up. */
  runnerMode: string;
  agentModel?: string | null;
  hostConfigDir?: string;
}): Promise<SessionResumePlan> {
  const rootRunId = await resolveConversationRootId(input.documentId, input.previousRunId);
  const conversationKey = rootRunId ?? input.aiRunId;
  const sessionDir = getConversationSessionDir(input.documentId, conversationKey);
  await fs.mkdir(sessionDir, { recursive: true });

  let resumeSessionId: string | null = null;
  let resumeUnavailableSessionId: string | null = null;
  if (input.previousRunId) {
    const candidate = await findResumableSessionId(input.documentId, input.previousRunId);
    if (candidate) {
      const harness = agentHarnessForModel(input.agentModel);
      // Container AND in-process runs both write transcripts into the
      // conversation's own session dir now (agent-core pins CLAUDE_CONFIG_DIR /
      // CODEX_HOME to it), so the host's default config dir is only consulted
      // when a caller explicitly points at one (tests, legacy inspection).
      const configDir =
        input.runnerMode === "container" || input.runnerMode === "inprocess"
          ? input.hostConfigDir ?? sessionDir
          : input.hostConfigDir ?? (harness === "codex" ? defaultCodexConfigDir() : defaultClaudeConfigDir());
      const exists = harness === "codex"
        ? await codexSessionExists(configDir, candidate)
        : await sessionTranscriptExists(configDir, candidate);
      if (exists) {
        resumeSessionId = candidate;
      } else {
        resumeUnavailableSessionId = candidate;
      }
    }
  }
  return { conversationKey, sessionDir, resumeSessionId, resumeUnavailableSessionId };
}

export async function recordRunSessionId(aiRunId: string, sessionId: string) {
  await db.aiRun
    .update({ where: { id: aiRunId }, data: { sdkSessionId: sessionId } })
    .catch(() => null);
}

// Two runs of the same conversation must never write the same session file
// concurrently (interleaved JSONL corrupts the transcript). Same promise-chain
// mutex pattern as withWorkspaceLock; Slack already queues per-thread and the
// UI disables follow-ups mid-run, so this only guards races.
const conversationLocks = new Map<string, Promise<void>>();

export async function withConversationLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => gate,
    () => gate
  );
  conversationLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (conversationLocks.get(key) === queued) {
      conversationLocks.delete(key);
    }
  }
}

/**
 * Delete conversation session dirs that have not been touched in maxAgeMs.
 * Recency is judged by the newest mtime anywhere in the dir (transcripts are
 * appended on every run). Missing roots are a no-op.
 */
export async function gcStaleSessionDirs(maxAgeMs = SESSION_DIR_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  let docDirs: string[] = [];
  try {
    docDirs = (await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const docDir of docDirs) {
    const sessionsRoot = path.join(WORKSPACE_ROOT, docDir, "sessions");
    let sessionDirs: string[] = [];
    try {
      sessionDirs = (await fs.readdir(sessionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of sessionDirs) {
      const dir = path.join(sessionsRoot, name);
      if ((await newestMtime(dir)) >= cutoff) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => null);
      removed += 1;
    }
  }
  return { removed };
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  try {
    newest = (await fs.stat(dir)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // unreadable — leave it alone
  }
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(child));
    } else {
      try {
        newest = Math.max(newest, (await fs.stat(child)).mtimeMs);
      } catch {
        // ignore
      }
    }
  }
  return newest;
}
