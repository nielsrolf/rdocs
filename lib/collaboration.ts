import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceStep, Step } from "@tiptap/pm/transform";

import { defaultDocumentContent, parseDocumentContent, serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { createDocumentEditorSchema } from "@/lib/document-editor-schema";
import { maybeCreateVersionSnapshot } from "@/lib/document-data";
import { computeCommittedContent } from "@/lib/suggestion-content";

export type CollaborationStepPayload = {
  steps: unknown[];
  clientIds: Array<string | number>;
  fromVersion: number;
  version: number;
  updatedAt: string | null;
};

export type CollaborationPresence = {
  clientId: string;
  userId: string | null;
  userName: string;
  color: string;
  selection: {
    anchor: number;
    head: number;
    from: number;
    to: number;
    version: number;
    context?: {
      from: { before: string; after: string };
      to: { before: string; after: string };
      head: { before: string; after: string };
    } | null;
  } | null;
  typing: boolean;
  lastSeen: number;
};

type StepRecord = {
  version: number;
  step: unknown;
  clientId: string | number;
};

type DurableStepRow = {
  version: number | bigint;
  step: string;
  clientId: string;
};

type DurableVersionRow = {
  version: number | bigint | null;
};

type RoomSubscriber = {
  clientId: string;
  send: (event: string, payload: unknown) => void;
};

type CollaborationRoom = {
  documentId: string;
  doc: ProseMirrorNode;
  version: number;
  steps: StepRecord[];
  subscribers: Set<RoomSubscriber>;
  presence: Map<string, CollaborationPresence>;
  updatedAt: string | null;
};

type GlobalCollaborationState = {
  rooms: Map<string, CollaborationRoom>;
  queues: Map<string, Promise<void>>;
};

// Thrown when an incoming step cannot be applied to the current document
// (e.g. a corrupt step or a client/server schema mismatch). This is distinct
// from a version conflict: a conflict is recoverable by rebasing, but an
// un-appliable step will fail identically on every retry, so the API surfaces
// it as 422 rather than 409 to stop the client from retrying forever.
export class StepApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepApplyError";
  }
}

// Thrown when a comment-access ("suggestion only") push would change the
// committed view of the document — i.e. it does more than add/edit/withdraw
// tracked-change suggestions. Mapped to a 403 by the collaboration route.
export class SuggestionOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestionOnlyError";
  }
}

const schema = createDocumentEditorSchema();
const PRESENCE_TTL_MS = 30_000;
// Cap the in-memory step buffer so a long-lived hot room can't grow unbounded.
// The durable CollaborationStep table remains the long-term source of truth;
// pulls for older versions fall back to it.
const MAX_ROOM_STEPS = 2000;
let collaborationStepTableReady: Promise<void> | null = null;

function getGlobalState(): GlobalCollaborationState {
  const globalKey = "__gdocsAiCollaboration";
  const globalWithRooms = globalThis as typeof globalThis & {
    [globalKey]?: GlobalCollaborationState;
  };

  if (!globalWithRooms[globalKey]) {
    globalWithRooms[globalKey] = {
      rooms: new Map(),
      queues: new Map()
    };
  }

  return globalWithRooms[globalKey];
}

function parseStoredDoc(rawContent: string) {
  try {
    return schema.nodeFromJSON(parseDocumentContent(rawContent));
  } catch {
    return schema.nodeFromJSON(defaultDocumentContent);
  }
}

export function getCollaborationRoom(documentId: string, rawContent: string, updatedAt?: Date | string | null) {
  const state = getGlobalState();
  const existing = state.rooms.get(documentId);
  if (existing) {
    return existing;
  }

  const room: CollaborationRoom = {
    documentId,
    doc: parseStoredDoc(rawContent),
    version: 0,
    steps: [],
    subscribers: new Set(),
    presence: new Map(),
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null
  };
  state.rooms.set(documentId, room);
  return room;
}

async function ensureCollaborationStepTable() {
  if (!collaborationStepTableReady) {
    collaborationStepTableReady = (async () => {
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS CollaborationStep (
          documentId TEXT NOT NULL,
          version INTEGER NOT NULL,
          step TEXT NOT NULL,
          clientId TEXT NOT NULL,
          createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (documentId, version)
        )
      `);
      await db.$executeRawUnsafe(
        "CREATE INDEX IF NOT EXISTS CollaborationStep_documentId_version_idx ON CollaborationStep(documentId, version)"
      );
    })();
  }

  await collaborationStepTableReady;
}

function normalizeVersion(value: number | bigint | null | undefined) {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function getDurableVersion(documentId: string) {
  await ensureCollaborationStepTable();
  const rows = await db.$queryRawUnsafe<DurableVersionRow[]>(
    "SELECT COALESCE(MAX(version) + 1, 0) AS version FROM CollaborationStep WHERE documentId = ?",
    documentId
  );

  return normalizeVersion(rows[0]?.version);
}

async function getDurableStepsSince(documentId: string, version: number): Promise<StepRecord[]> {
  await ensureCollaborationStepTable();
  const rows = await db.$queryRawUnsafe<DurableStepRow[]>(
    "SELECT version, step, clientId FROM CollaborationStep WHERE documentId = ? AND version >= ? ORDER BY version ASC",
    documentId,
    version
  );

  return rows.map((row) => ({
    version: normalizeVersion(row.version),
    step: JSON.parse(row.step) as unknown,
    clientId: row.clientId
  }));
}

// Insert step rows in a single multi-row statement. Accepts a Prisma client or
// an interactive-transaction client so the caller can keep the content update
// and the step inserts in one atomic commit.
type RawExecutor = Pick<typeof db, "$executeRawUnsafe">;

async function insertDurableSteps(
  executor: RawExecutor,
  documentId: string,
  records: StepRecord[]
) {
  if (records.length === 0) {
    return;
  }
  const placeholders = records.map(() => "(?, ?, ?, ?)").join(", ");
  const values = records.flatMap((record) => [
    documentId,
    record.version,
    JSON.stringify(record.step),
    String(record.clientId)
  ]);
  await executor.$executeRawUnsafe(
    `INSERT INTO CollaborationStep (documentId, version, step, clientId) VALUES ${placeholders}`,
    ...values
  );
}

export async function getCollaborationVersion(documentId: string, rawContent: string, updatedAt?: Date | string | null) {
  const room = getCollaborationRoom(documentId, rawContent, updatedAt);
  const version = await getDurableVersion(documentId);
  alignColdRoomVersion(room, version);
  return version;
}

async function withDocumentQueue<T>(documentId: string, task: () => Promise<T>) {
  const state = getGlobalState();
  const previous = state.queues.get(documentId) ?? Promise.resolve();
  let releaseQueue: () => void = () => undefined;
  const next = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  const queued = previous.then(
    () => next,
    () => next
  );
  state.queues.set(documentId, queued);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    releaseQueue();
    if (state.queues.get(documentId) === queued) {
      state.queues.delete(documentId);
    }
  }
}

function buildStepPayload(
  records: StepRecord[],
  fromVersion: number,
  version: number,
  updatedAt: string | null
): CollaborationStepPayload {
  return {
    steps: records.map((record) => record.step),
    clientIds: records.map((record) => record.clientId),
    fromVersion,
    version,
    updatedAt
  };
}

function alignColdRoomVersion(room: CollaborationRoom, version: number) {
  if (room.steps.length === 0 && version > room.version) {
    room.version = version;
  }
}

function syncRoomToPersistedDocument(
  room: CollaborationRoom,
  rawContent: string,
  updatedAt: Date | string | null | undefined,
  version: number
) {
  room.doc = parseStoredDoc(rawContent);
  room.version = version;
  room.updatedAt = updatedAt ? new Date(updatedAt).toISOString() : null;
}

function prunePresence(room: CollaborationRoom) {
  const now = Date.now();
  room.presence.forEach((presence, clientId) => {
    if (now - presence.lastSeen > PRESENCE_TTL_MS) {
      room.presence.delete(clientId);
    }
  });
}

function listPresence(room: CollaborationRoom) {
  prunePresence(room);
  return Array.from(room.presence.values());
}

function broadcast(room: CollaborationRoom, event: string, payload: unknown, excludeClientId?: string) {
  room.subscribers.forEach((subscriber) => {
    if (subscriber.clientId === excludeClientId) {
      return;
    }

    // Fault-isolate each subscriber: a dead/closed SSE connection whose enqueue
    // throws must not abort delivery to the other subscribers in the room. Drop
    // the failing subscriber instead. (Deleting from a Set mid-forEach is safe.)
    try {
      subscriber.send(event, payload);
    } catch {
      room.subscribers.delete(subscriber);
    }
  });
}

// Delete a room from the in-memory map when nobody is connected and no presence
// remains. The room is fully reconstructible from the DB (content + durable step
// log) on next access, so this is safe and prevents an unbounded leak of one
// room per distinct document ever opened.
function reapRoomIfIdle(documentId: string) {
  const state = getGlobalState();
  const room = state.rooms.get(documentId);
  if (!room) return;
  prunePresence(room);
  if (room.subscribers.size === 0 && room.presence.size === 0) {
    state.rooms.delete(documentId);
  }
}

// Sweep all rooms (for the periodic reaper started in instrumentation.ts, and
// for tests). Returns the number of rooms reaped.
export function reapIdleCollaborationRooms() {
  const state = getGlobalState();
  let reaped = 0;
  for (const documentId of Array.from(state.rooms.keys())) {
    const before = state.rooms.size;
    reapRoomIfIdle(documentId);
    if (state.rooms.size < before) reaped += 1;
  }
  return reaped;
}

// Optional metadata attached to the version snapshot produced by a step push.
// Used by the AI-edit apply path so the post-edit version records the agent's
// commit / sources / run id — previously this was done by a separate full-content
// PATCH, which wrote Document.content out-of-band and desynced the collab room.
export type CollaborationVersionMeta = {
  forceVersion?: boolean;
  sourceLinks?: string[];
  commitSha?: string | null;
  commitUrl?: string | null;
  aiRunId?: string | null;
};

export async function submitCollaborationSteps(input: {
  documentId: string;
  rawContent: string;
  currentTitle: string;
  currentUpdatedAt?: Date | string | null;
  version: number;
  steps: unknown[];
  clientId: string;
  versionMeta?: CollaborationVersionMeta;
  // When true (comment-access pusher), the push may only add/modify/withdraw
  // tracked-change suggestions — the committed view of the document must not
  // change. Enforced below; a violation throws SuggestionOnlyError (403).
  suggestionOnly?: boolean;
}) {
  return withDocumentQueue(input.documentId, async () => {
    const persistedDocument = await db.document.findUnique({
      where: { id: input.documentId },
      select: {
        content: true,
        title: true,
        updatedAt: true
      }
    });

    if (!persistedDocument) {
      throw new Error("Document not found.");
    }

    const room = getCollaborationRoom(
      input.documentId,
      persistedDocument.content,
      persistedDocument.updatedAt
    );
    const durableVersion = await getDurableVersion(input.documentId);
    alignColdRoomVersion(room, durableVersion);

    // Server-side rebase was attempted previously but is fundamentally
    // incompatible with prosemirror-collab's confirmation convention: the
    // plugin treats *leading* own-clientId steps in the response as
    // confirmations, while a chronologically correct rebase response puts
    // foreign steps first and own steps last. That ordering causes the client
    // to re-apply its local steps instead of confirming them, accumulating
    // duplicate edits and eventually corrupting doc structure. The client
    // must rebase locally — return 409 + missing steps and let it handle it.
    if (input.version !== durableVersion) {
      const missingRecords = await getDurableStepsSince(input.documentId, input.version);
      console.warn("[collab-push] stale push", {
        documentId: input.documentId,
        clientId: input.clientId,
        clientVersion: input.version,
        durableVersion,
        missingStepCount: missingRecords.length
      });
      return {
        accepted: false,
        ...buildStepPayload(
          missingRecords,
          input.version,
          durableVersion,
          persistedDocument.updatedAt.toISOString()
        )
      };
    }

    const baseDoc = parseStoredDoc(persistedDocument.content);
    let nextDoc = baseDoc;
    const records: StepRecord[] = [];
    const previousContent = serializeDocumentContent(baseDoc.toJSON());

    for (const stepJson of input.steps) {
      let step: Step;
      try {
        step = Step.fromJSON(schema, stepJson);
      } catch (error) {
        throw new StepApplyError(
          error instanceof Error ? `Malformed collaboration step: ${error.message}` : "Malformed collaboration step."
        );
      }
      const result = step.apply(nextDoc);
      if (result.failed || !result.doc) {
        throw new StepApplyError(result.failed ?? "Unable to apply collaboration step.");
      }

      nextDoc = result.doc;
      records.push({
        version: durableVersion + records.length,
        step: step.toJSON(),
        clientId: input.clientId
      });
    }

    const nextContent = serializeDocumentContent(nextDoc.toJSON());

    // Suggestion-only guard: a comment-access push must leave the committed view
    // (the document with every suggestion rejected) byte-identical. This is the
    // security boundary that lets commenters persist tracked changes via the same
    // step pipeline without being able to commit content.
    if (input.suggestionOnly) {
      const baseCommitted = JSON.stringify(computeCommittedContent(baseDoc.toJSON()));
      const nextCommitted = JSON.stringify(computeCommittedContent(nextDoc.toJSON()));
      if (baseCommitted !== nextCommitted) {
        throw new SuggestionOnlyError(
          "Comment access can only add suggestions, not change committed content."
        );
      }
    }

    // Snapshot the pre-edit content for version history before overwriting.
    // When the push carries AI-run metadata, attach it to the post-edit version
    // (and force a snapshot) so AI edits remain attributable in version history.
    await maybeCreateVersionSnapshot({
      documentId: input.documentId,
      currentTitle: persistedDocument.title,
      currentContent: previousContent,
      nextTitle: persistedDocument.title,
      nextContent,
      force: input.versionMeta?.forceVersion,
      sourceLinks: input.versionMeta?.sourceLinks,
      commitSha: input.versionMeta?.commitSha,
      commitUrl: input.versionMeta?.commitUrl,
      aiRunId: input.versionMeta?.aiRunId
    });

    // Persist the new content and the step rows in ONE transaction so the
    // durable step log can never diverge from Document.content (a partial
    // failure previously left content advanced but steps missing, permanently
    // desyncing every other client that replays from the step log).
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.document.update({
        where: { id: input.documentId },
        data: { content: nextContent },
        select: { updatedAt: true }
      });
      await insertDurableSteps(tx, input.documentId, records);
      return result;
    });

    // Only after the commit succeeds do we mutate the in-memory room and
    // broadcast — otherwise a rolled-back write would still reach other clients.
    room.doc = nextDoc;
    room.version = durableVersion + records.length;
    room.updatedAt = updated.updatedAt.toISOString();
    room.steps.push(...records);
    if (room.steps.length > MAX_ROOM_STEPS) {
      room.steps.splice(0, room.steps.length - MAX_ROOM_STEPS);
    }

    const payload = buildStepPayload(records, durableVersion, room.version, room.updatedAt);

    broadcast(room, "steps", payload, input.clientId);

    return {
      accepted: true,
      ...payload
    };
  });
}

// Count the OTHER clients connected to a room — a live SSE subscriber or a
// non-stale presence entry whose clientId differs from `exceptClientId`. Used
// to gate the sole-client force-push: if anyone else is here, refuse.
function otherConnectedClientIds(room: CollaborationRoom, exceptClientId: string): string[] {
  prunePresence(room);
  const others = new Set<string>();
  room.subscribers.forEach((subscriber) => {
    if (subscriber.clientId !== exceptClientId) others.add(subscriber.clientId);
  });
  room.presence.forEach((_presence, clientId) => {
    if (clientId !== exceptClientId) others.add(clientId);
  });
  return Array.from(others);
}

// Force-push: let the SOLE connected client overwrite the server document with
// its own state, the way `git push --force` overwrites a remote branch. This is
// the escape hatch for an unrecoverable divergence (the client's local doc no
// longer matches the server's confirmed version, so prosemirror-collab can't
// rebase its pending steps — see the client's applyCollaborationPayload catch).
//
// Guard: it is only permitted when no OTHER client is connected, so it can never
// silently clobber a concurrent collaborator's edits. With multiple clients, the
// caller keeps the normal conflict behavior ("Save failed").
//
// Effect: overwrite Document.content, archive the overwritten server state to
// version history (so the force-push is reversible), and reset the durable step
// log to empty (durableVersion → 0). The sole client then re-seeds from the new
// baseline at version 0.
export async function forcePushDocument(input: {
  documentId: string;
  rawContent: string;
  currentTitle: string;
  currentUpdatedAt?: Date | string | null;
  clientId: string;
  content: unknown;
}): Promise<
  | { forced: true; version: number; updatedAt: string | null }
  | { forced: false; reason: "other-clients"; connectedClientIds: string[] }
> {
  return withDocumentQueue(input.documentId, async () => {
    const persistedDocument = await db.document.findUnique({
      where: { id: input.documentId },
      select: { content: true, title: true, updatedAt: true }
    });

    if (!persistedDocument) {
      throw new Error("Document not found.");
    }

    const room = getCollaborationRoom(
      input.documentId,
      persistedDocument.content,
      persistedDocument.updatedAt
    );

    const others = otherConnectedClientIds(room, input.clientId);
    if (others.length > 0) {
      return { forced: false, reason: "other-clients", connectedClientIds: others };
    }

    // Validate the incoming content against the server schema before committing
    // — a corrupt force-push must not be able to brick the document.
    let nextDoc: ProseMirrorNode;
    try {
      nextDoc = schema.nodeFromJSON(input.content);
    } catch (error) {
      throw new StepApplyError(
        error instanceof Error ? `Invalid force-push content: ${error.message}` : "Invalid force-push content."
      );
    }

    const nextContent = serializeDocumentContent(nextDoc.toJSON());
    const previousContent = persistedDocument.content;

    // Archive the overwritten server state so the discarded edits stay
    // recoverable from version history.
    await maybeCreateVersionSnapshot({
      documentId: input.documentId,
      currentTitle: persistedDocument.title,
      currentContent: previousContent,
      nextTitle: persistedDocument.title,
      nextContent,
      force: true
    });

    // Overwrite content AND reset the durable step log in ONE transaction so the
    // log can never disagree with Document.content. Clearing the steps resets
    // durableVersion (MAX(version)+1) to 0.
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.document.update({
        where: { id: input.documentId },
        data: { content: nextContent },
        select: { updatedAt: true }
      });
      await tx.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", input.documentId);
      return result;
    });

    // Reset the in-memory room to the new authoritative baseline (version 0).
    room.doc = nextDoc;
    room.version = 0;
    room.steps = [];
    room.updatedAt = updated.updatedAt.toISOString();

    // Tell any straggler subscribers to re-seed from the server. There should be
    // none other than the requester (we checked), but a reset is authoritative
    // and harmless: clients reload to the new version-0 baseline.
    broadcast(room, "reset", { version: 0, updatedAt: room.updatedAt });

    return { forced: true, version: 0, updatedAt: room.updatedAt };
  });
}

// Commit a manually-resolved merge. This is the multi-client counterpart to the
// sole-client force-push: when a tab's local doc has diverged unrecoverably AND
// another client is connected (so a force-push is refused, since it would clobber
// the collaborator), the user resolves the conflict in the merge dialog and the
// resulting document is committed here.
//
// Unlike a force-push it is VERSION-CHECKED and applied as a normal successor of
// the current server version: the merge was resolved against `baseVersion`, so if
// the server has advanced since (another client committed in the meantime) we
// refuse with `stale` and the client re-merges against the fresh server doc. On
// success the merge lands as ONE whole-document replace step, broadcast to the
// other clients so they apply it through the normal collab path. (Their
// unconfirmed in-flight edits rebase over the whole-doc replace and may be
// dropped — acceptable for an authoritative human merge resolution.)
export async function mergeCommitDocument(input: {
  documentId: string;
  currentUpdatedAt?: Date | string | null;
  clientId: string;
  baseVersion: number;
  content: unknown;
}): Promise<
  | { committed: true; version: number; updatedAt: string | null }
  | { committed: false; reason: "stale"; version: number }
> {
  return withDocumentQueue(input.documentId, async () => {
    const persistedDocument = await db.document.findUnique({
      where: { id: input.documentId },
      select: { content: true, title: true, updatedAt: true }
    });

    if (!persistedDocument) {
      throw new Error("Document not found.");
    }

    const room = getCollaborationRoom(
      input.documentId,
      persistedDocument.content,
      persistedDocument.updatedAt
    );
    const durableVersion = await getDurableVersion(input.documentId);
    alignColdRoomVersion(room, durableVersion);

    if (input.baseVersion !== durableVersion) {
      return { committed: false, reason: "stale", version: durableVersion };
    }

    const baseDoc = parseStoredDoc(persistedDocument.content);

    // Validate the resolved content against the server schema before committing —
    // a corrupt merge must not be able to brick the document.
    let nextDoc: ProseMirrorNode;
    try {
      nextDoc = schema.nodeFromJSON(input.content);
    } catch (error) {
      throw new StepApplyError(
        error instanceof Error ? `Invalid merge content: ${error.message}` : "Invalid merge content."
      );
    }

    const step = new ReplaceStep(0, baseDoc.content.size, new Slice(nextDoc.content, 0, 0));
    const applied = step.apply(baseDoc);
    if (applied.failed || !applied.doc) {
      throw new StepApplyError(applied.failed ?? "Unable to apply merge step.");
    }

    const previousContent = serializeDocumentContent(baseDoc.toJSON());
    const nextContent = serializeDocumentContent(applied.doc.toJSON());

    // Archive the overwritten server state so a bad merge stays recoverable.
    await maybeCreateVersionSnapshot({
      documentId: input.documentId,
      currentTitle: persistedDocument.title,
      currentContent: previousContent,
      nextTitle: persistedDocument.title,
      nextContent,
      force: true
    });

    const record: StepRecord = {
      version: durableVersion,
      step: step.toJSON(),
      clientId: input.clientId
    };

    const updated = await db.$transaction(async (tx) => {
      const result = await tx.document.update({
        where: { id: input.documentId },
        data: { content: nextContent },
        select: { updatedAt: true }
      });
      await insertDurableSteps(tx, input.documentId, [record]);
      return result;
    });

    room.doc = applied.doc;
    room.version = durableVersion + 1;
    room.updatedAt = updated.updatedAt.toISOString();
    room.steps.push(record);
    if (room.steps.length > MAX_ROOM_STEPS) {
      room.steps.splice(0, room.steps.length - MAX_ROOM_STEPS);
    }

    const payload = buildStepPayload([record], durableVersion, room.version, room.updatedAt);
    broadcast(room, "steps", payload, input.clientId);

    return { committed: true, version: room.version, updatedAt: room.updatedAt };
  });
}

export async function pullCollaborationSteps(input: {
  documentId: string;
  rawContent: string;
  currentUpdatedAt?: Date | string | null;
  version: number;
}) {
  const room = getCollaborationRoom(input.documentId, input.rawContent, input.currentUpdatedAt);
  const durableVersion = await getDurableVersion(input.documentId);
  syncRoomToPersistedDocument(room, input.rawContent, input.currentUpdatedAt, durableVersion);
  const records = await getDurableStepsSince(input.documentId, input.version);
  return buildStepPayload(records, input.version, durableVersion, room.updatedAt);
}

// Lightweight fan-out for non-OT events (comment threads etc.) over the same
// SSE room. No-op if no room exists yet (no one connected). Excludes the
// originating client so the submitter doesn't get its own change echoed back
// (it already applied the change optimistically).
export function broadcastDocumentEvent(
  documentId: string,
  event: string,
  payload: unknown,
  originClientId?: string | null
) {
  const state = getGlobalState();
  const room = state.rooms.get(documentId);
  if (!room) return;
  broadcast(room, event, payload, originClientId ?? undefined);
}

export function subscribeToCollaboration(input: {
  documentId: string;
  rawContent: string;
  currentUpdatedAt?: Date | string | null;
  clientId: string;
  send: (event: string, payload: unknown) => void;
}) {
  const room = getCollaborationRoom(input.documentId, input.rawContent, input.currentUpdatedAt);
  const subscriber: RoomSubscriber = {
    clientId: input.clientId,
    send: input.send
  };

  room.subscribers.add(subscriber);
  input.send("ready", {
    version: room.version,
    presence: listPresence(room),
    updatedAt: room.updatedAt
  });

  return () => {
    room.subscribers.delete(subscriber);
    // Drop this client's presence so a hard disconnect doesn't leave a ghost
    // cursor lingering for the full presence TTL, then tell the rest of the room.
    if (room.presence.delete(subscriber.clientId)) {
      broadcast(room, "presence", { presence: listPresence(room) });
    }
    reapRoomIfIdle(input.documentId);
  };
}

export function updateCollaborationPresence(input: {
  documentId: string;
  rawContent: string;
  currentUpdatedAt?: Date | string | null;
  presence: CollaborationPresence;
}) {
  const room = getCollaborationRoom(input.documentId, input.rawContent, input.currentUpdatedAt);
  prunePresence(room);
  room.presence.set(input.presence.clientId, input.presence);
  const presence = listPresence(room);
  broadcast(room, "presence", { presence });
  return presence;
}

export function pullCollaborationPresence(input: {
  documentId: string;
  rawContent: string;
  currentUpdatedAt?: Date | string | null;
}) {
  const room = getCollaborationRoom(input.documentId, input.rawContent, input.currentUpdatedAt);
  return listPresence(room);
}

export function removeCollaborationPresence(input: {
  documentId: string;
  rawContent: string;
  currentUpdatedAt?: Date | string | null;
  clientId: string;
}) {
  const room = getCollaborationRoom(input.documentId, input.rawContent, input.currentUpdatedAt);
  room.presence.delete(input.clientId);
  const presence = listPresence(room);
  broadcast(room, "presence", { presence });
  return presence;
}
