import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Step } from "@tiptap/pm/transform";

import { defaultDocumentContent, parseDocumentContent, serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { createDocumentEditorSchema } from "@/lib/document-editor-schema";
import { maybeCreateVersionSnapshot } from "@/lib/document-data";

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

const schema = createDocumentEditorSchema();
const PRESENCE_TTL_MS = 30_000;
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

async function insertDurableSteps(documentId: string, records: StepRecord[]) {
  await ensureCollaborationStepTable();
  for (const record of records) {
    await db.$executeRawUnsafe(
      "INSERT INTO CollaborationStep (documentId, version, step, clientId) VALUES (?, ?, ?, ?)",
      documentId,
      record.version,
      JSON.stringify(record.step),
      String(record.clientId)
    );
  }
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

    subscriber.send(event, payload);
  });
}

export async function submitCollaborationSteps(input: {
  documentId: string;
  rawContent: string;
  currentTitle: string;
  currentUpdatedAt?: Date | string | null;
  version: number;
  steps: unknown[];
  clientId: string;
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

    if (input.version !== durableVersion) {
      const missingRecords = await getDurableStepsSince(input.documentId, input.version);
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
      const step = Step.fromJSON(schema, stepJson);
      const result = step.apply(nextDoc);
      if (result.failed || !result.doc) {
        throw new Error(result.failed ?? "Unable to apply collaboration step.");
      }

      nextDoc = result.doc;
      records.push({
        version: durableVersion + records.length,
        step: step.toJSON(),
        clientId: input.clientId
      });
    }

    const nextContent = serializeDocumentContent(nextDoc.toJSON());
    await maybeCreateVersionSnapshot({
      documentId: input.documentId,
      currentTitle: persistedDocument.title,
      currentContent: previousContent,
      nextTitle: persistedDocument.title,
      nextContent
    });

    const updated = await db.document.update({
      where: { id: input.documentId },
      data: {
        content: nextContent
      },
      select: {
        updatedAt: true
      }
    });

    await insertDurableSteps(input.documentId, records);

    room.doc = nextDoc;
    room.version = durableVersion + records.length;
    room.updatedAt = updated.updatedAt.toISOString();
    room.steps.push(...records);

    const payload = buildStepPayload(records, durableVersion, room.version, room.updatedAt);

    broadcast(room, "steps", payload, input.clientId);

    return {
      accepted: true,
      ...payload
    };
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
