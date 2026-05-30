import assert from "node:assert/strict";
import test from "node:test";

import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";

import { db } from "../lib/db";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";
import { pullCollaborationSteps, submitCollaborationSteps } from "../lib/collaboration";
import { serializeDocumentContent } from "../lib/content";
import {
  createAiEditSelectionPlugin,
  getAiEditSelectionRange,
  removeAiEditSelection,
  upsertAiEditSelection,
} from "../components/document-workspace/ai-edit-selections";
import { buildAiEditRemountTransaction } from "../components/document-workspace/ai-edit-remount";
import { createSerialQueue } from "../components/document-workspace/serial-queue";

// ─────────────────────────────────────────────────────────────────────────────
// A randomized, seeded, multi-actor simulation over the REAL collaboration
// pipeline (submitCollaborationSteps / pullCollaborationSteps), the REAL
// ai-edit-selection plugin, and the REAL apply serialization queue.
//
// Why this exists: every bug found by hand (concurrent AI-edit content loss,
// atom-selection marker loss, base-repo merge wedge) lived at the *intersection*
// of these subsystems under messy interleaving — something the fixed-scenario unit
// tests never produced. This generates messy interleavings on purpose and checks
// invariants that must hold no matter the order of events:
//
//   1. Convergence  — once everyone syncs, all clients + the server agree byte-for-byte.
//   2. Persistence  — replaying the durable step log from v0 reproduces the saved doc.
//   3. No lost work — every AI edit that was applied is still present after syncing.
//   4. Anchors live — a pending AI selection never vanishes (no "Replacement skipped"),
//                      even across an editor rebuild (reload/remount).
//
// A failure prints the seed and the full event trace so it is exactly reproducible:
//   SIM_SEED=12345 npx tsx --test tests/collab-simulation.test.ts
//   SIM_TRACES=500 npm test            (crank up coverage locally)
// ─────────────────────────────────────────────────────────────────────────────

const schema = createDocumentEditorSchema();

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = {
  next: () => number;
  int: (n: number) => number;
  pick: <T>(items: T[]) => T;
  bool: (p?: number) => boolean;
};

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    bool: (p = 0.5) => next() < p,
  };
}

const INITIAL_TEXT = "Sentence zero.";

function initialDocJson() {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: INITIAL_TEXT }] }] };
}

async function createDoc() {
  const user = await db.user.create({
    data: { email: `sim-${crypto.randomUUID()}@example.com`, name: "Sim", passwordHash: "test" },
  });
  const document = await db.document.create({
    data: { title: "Sim doc", content: serializeDocumentContent(initialDocJson()), ownerId: user.id },
  });
  return { userId: user.id, documentId: document.id };
}

async function cleanupDoc(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.documentVersion.deleteMany({ where: { documentId } }).catch(() => undefined);
  await db.document.deleteMany({ where: { id: documentId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

type Server = {
  submit: (clientId: string, version: number, steps: unknown[]) => ReturnType<typeof submitCollaborationSteps>;
  pull: (version: number) => ReturnType<typeof pullCollaborationSteps>;
};

function makeServer(documentId: string): Server {
  return {
    async submit(clientId, version, steps) {
      const doc = await db.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { content: true, title: true, updatedAt: true },
      });
      return submitCollaborationSteps({
        documentId,
        rawContent: doc.content,
        currentTitle: doc.title,
        currentUpdatedAt: doc.updatedAt,
        version,
        steps,
        clientId,
        versionMeta: { forceVersion: false },
      });
    },
    async pull(version) {
      const doc = await db.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { content: true, updatedAt: true },
      });
      return pullCollaborationSteps({ documentId, rawContent: doc.content, currentUpdatedAt: doc.updatedAt, version });
    },
  };
}

type PendingRun = { id: string; selectionId: string; marker: string; sentinel: string };

class Client {
  state: EditorState;
  readonly queue = createSerialQueue();
  readonly pending: PendingRun[] = [];

  constructor(readonly id: string) {
    this.state = Client.fresh(0, id, initialDocJson());
  }

  static fresh(version: number, clientId: string, json: unknown) {
    return EditorState.create({
      doc: schema.nodeFromJSON(json as never),
      plugins: [collab({ version, clientID: clientId }), createAiEditSelectionPlugin()],
    });
  }

  get version() {
    return getVersion(this.state);
  }

  apply(tr: EditorState["tr"]) {
    this.state = this.state.apply(tr);
  }

  // Faithful flush: push pending steps; a 409 returns the missing remote steps,
  // which we apply to rebase, then retry — exactly what the live client does.
  async flush(server: Server) {
    for (let guard = 0; guard < 200; guard += 1) {
      const sendable = sendableSteps(this.state);
      if (!sendable || sendable.steps.length === 0) return;
      const res = await server.submit(this.id, sendable.version, sendable.steps.map((s) => s.toJSON()));
      const steps = res.steps.map((s) => Step.fromJSON(schema, s));
      this.state = this.state.apply(receiveTransaction(this.state, steps, res.clientIds, { mapSelectionBackward: true }));
      if (res.accepted) return;
    }
    throw new Error(`client ${this.id} failed to converge while flushing`);
  }

  async pull(server: Server) {
    const res = await server.pull(this.version);
    if (res.steps.length === 0) return;
    const steps = res.steps.map((s) => Step.fromJSON(schema, s));
    this.state = this.state.apply(receiveTransaction(this.state, steps, res.clientIds, { mapSelectionBackward: true }));
  }
}

// ── event vocabulary ──────────────────────────────────────────────────────────

function firstParagraphRange(state: EditorState): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "paragraph" && node.content.size > 0) {
      found = { from: pos + 1, to: pos + 1 + node.content.size };
    }
    return undefined;
  });
  return found;
}


function doType(client: Client, rng: Rng) {
  const para = firstParagraphRange(client.state);
  const at = para ? para.from + rng.int(para.to - para.from) : 1;
  const text = ["a", "b", "c", "d", " ", "x"][rng.int(6)] + ["1", "2", "3", "z", ""][rng.int(5)];
  client.apply(client.state.tr.insertText(text, Math.min(at, client.state.doc.content.size - 1 || 1)));
}

function doInsertImage(client: Client, n: number) {
  const img = schema.nodes.repoImage.create({
    src: `/api/documents/x/repo-files?path=assets%2Fp${n}.svg`,
    alt: `plot ${n}`,
    caption: `plot ${n}`,
    path: `assets/p${n}.svg`,
  });
  client.apply(client.state.tr.insert(client.state.doc.content.size, img));
}

function findTextRange(state: EditorState, needle: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return undefined;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) found = { from: pos + idx, to: pos + idx + needle.length };
    return undefined;
  });
  return found;
}

function doStartAi(client: Client, runCounter: number) {
  // Anchor each AI edit on a UNIQUE sentinel token in its OWN appended paragraph.
  // Keeping sentinels/markers out of the first paragraph (where random typing
  // happens) means typing can't split a marker, so "marker present" is an exact
  // check; uniqueness means distinct edits never contend for the same inline mark.
  const selectionId = `sel-${client.id}-${runCounter}`;
  const marker = `«${client.id}${runCounter}»`;
  const sentinel = `‹${client.id}${runCounter}›`;
  const para = schema.nodes.paragraph.create(null, schema.text(sentinel));
  client.apply(client.state.tr.insert(client.state.doc.content.size, para));
  const range = findTextRange(client.state, sentinel);
  if (!range) return;
  client.apply(upsertAiEditSelection(client.state, { id: selectionId, from: range.from, to: range.to, progress: "x" }));
  client.pending.push({ id: `run-${client.id}-${runCounter}`, selectionId, marker, sentinel });
}

// Models applyAiEditRun end-to-end: resolve the anchor (→ marker lost if gone),
// insert the result IN PLACE right after the anchored sentinel, drop the anchor,
// then do the setContent remount (full-doc replace) + reseed exactly as the live
// apply path does. A burst applies a client's runs through its serial queue.
function applyOne(
  client: Client,
  run: PendingRun,
  markerLost: string[],
  mispositioned: string[],
  applied: Set<string>
) {
  return client.queue.run(async () => {
    const range = getAiEditSelectionRange(client.state, run.selectionId);
    if (!range) {
      markerLost.push(run.id);
      client.apply(removeAiEditSelection(client.state, run.selectionId));
      return;
    }
    await Promise.resolve(); // genuine interleave at the queue boundary

    // A correctly-anchored selection resolves inside a text block. If it instead
    // resolved to a block boundary / the doc end, the remount collapsed it — the
    // reported "result appears at the bottom" bug.
    const at = Math.min(range.to, client.state.doc.content.size);
    const $at = client.state.doc.resolve(at);
    if ($at.parent.isTextblock && at > $at.start()) {
      client.apply(client.state.tr.insertText(run.marker, at));
    } else {
      mispositioned.push(run.id);
      const para = schema.nodes.paragraph.create(null, schema.text(run.marker));
      client.apply(client.state.tr.insert(client.state.doc.content.size, para));
    }
    client.apply(removeAiEditSelection(client.state, run.selectionId));

    // The post-insert node-view remount, using the REAL transaction the live apply
    // path dispatches. If that ever regresses to a destructive full-document
    // replace, this surfaces as divergence / lost work / mispositioning below.
    const remount = buildAiEditRemountTransaction(client.state);
    if (remount) client.apply(remount);
    applied.add(run.marker);
  });
}

async function doApplyBurst(
  client: Client,
  markerLost: string[],
  mispositioned: string[],
  applied: Set<string>
) {
  const runs = client.pending.splice(0, client.pending.length);
  if (runs.length === 0) return;
  await Promise.all(runs.map((run) => applyOne(client, run, markerLost, mispositioned, applied)));
}

function doRebuild(client: Client, server: Server) {
  // A reload/remount: must push local work first (a real reload of unsynced edits
  // loses them — out of scope), then rebuild from current content with an empty
  // ai-edit plugin. Pending AI anchors must survive via the document itself.
  return client.flush(server).then(() => {
    client.state = Client.fresh(client.version, client.id, client.state.doc.toJSON());
  });
}

async function drain(
  clients: Client[],
  server: Server,
  markerLost: string[],
  mispositioned: string[],
  applied: Set<string>
) {
  // Finish any in-flight AI applies, then push/pull to a fixed point.
  for (const c of clients) await doApplyBurst(c, markerLost, mispositioned, applied);
  for (let round = 0; round < 60; round += 1) {
    let changed = false;
    for (const c of clients) {
      if (sendableSteps(c.state)) {
        await c.flush(server);
        changed = true;
      }
    }
    const before = clients.map((c) => c.version);
    for (const c of clients) await c.pull(server);
    const after = clients.map((c) => c.version);
    const settled = !changed && after.every((v) => v === after[0]) && !clients.some((c) => sendableSteps(c.state));
    if (settled && before.join() === after.join()) return;
  }
  throw new Error("clients did not reach a fixed point");
}

async function replayStepLog(server: Server): Promise<unknown> {
  const all = await server.pull(0); // all durable steps from the very beginning
  let doc = schema.nodeFromJSON(initialDocJson());
  for (const sj of all.steps) {
    const step = Step.fromJSON(schema, sj);
    const res = step.apply(doc);
    if (res.failed || !res.doc) throw new Error(`step log replay failed: ${res.failed}`);
    doc = res.doc;
  }
  return doc.toJSON();
}

type Event = string;

async function runTrace(seed: number, eventCount: number): Promise<void> {
  const rng = makeRng(seed);
  const { userId, documentId } = await createDoc();
  const server = makeServer(documentId);
  const actorNames = ["alice", "bob", "carol"].slice(0, 2 + rng.int(2));
  const clients = actorNames.map((name) => new Client(name));
  const trace: Event[] = [`seed=${seed} actors=${actorNames.join(",")}`];
  const markerLost: string[] = [];
  const mispositioned: string[] = [];
  const applied = new Set<string>();
  let runCounter = 0;
  let imageCounter = 0;

  const fail = (reason: string, extra = "") => {
    const msg =
      `SIMULATION FAILED (reproduce with SIM_SEED=${seed}): ${reason}\n` +
      `${extra}\nTrace:\n  ${trace.join("\n  ")}`;
    throw new Error(msg);
  };

  try {
    for (let i = 0; i < eventCount; i += 1) {
      const c = rng.pick(clients);
      const roll = rng.next();
      if (roll < 0.34) {
        doType(c, rng);
        trace.push(`${c.id}: type`);
      } else if (roll < 0.45) {
        doInsertImage(c, (imageCounter += 1));
        trace.push(`${c.id}: insertImage p${imageCounter}`);
      } else if (roll < 0.58) {
        doStartAi(c, (runCounter += 1));
        trace.push(`${c.id}: startAi sel-${c.id}-${runCounter}`);
      } else if (roll < 0.72) {
        const n = c.pending.length;
        await doApplyBurst(c, markerLost, mispositioned, applied);
        trace.push(`${c.id}: applyBurst x${n}`);
      } else if (roll < 0.82) {
        await c.flush(server);
        trace.push(`${c.id}: flush`);
      } else if (roll < 0.92) {
        await c.pull(server);
        trace.push(`${c.id}: pull`);
      } else {
        await doRebuild(c, server);
        trace.push(`${c.id}: rebuild`);
      }

      // INVARIANT 4 (anchor liveness): every still-pending AI selection must resolve
      // to a range right now — losing it is the "Replacement skipped" bug.
      for (const client of clients) {
        for (const run of client.pending) {
          if (!getAiEditSelectionRange(client.state, run.selectionId)) {
            fail(`pending AI anchor ${run.selectionId} was lost mid-trace (after ${trace[trace.length - 1]})`);
          }
        }
      }
    }

    await drain(clients, server, markerLost, mispositioned, applied);

    // INVARIANT 4 (again): no apply ever reported a lost anchor.
    if (markerLost.length > 0) fail(`AI applies lost their anchor: ${markerLost.join(", ")}`);

    // INVARIANT 5 (correct position): an AI result must land at its anchor, never at
    // the document end because a prior run's setContent remount collapsed the anchor.
    if (mispositioned.length > 0) {
      fail(`AI results landed at the document bottom instead of at their anchor: ${mispositioned.join(", ")}`);
    }

    // INVARIANT 1 (convergence): all clients agree with each other and the server.
    const serverContent = await db.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { content: true },
    });
    const serverJson = JSON.stringify(JSON.parse(serverContent.content));
    for (const client of clients) {
      const clientJson = JSON.stringify(client.state.doc.toJSON());
      if (clientJson !== serverJson) {
        fail(
          `client ${client.id} diverged from the server`,
          `client:\n${clientJson}\nserver:\n${serverJson}`
        );
      }
    }

    // INVARIANT 2 (persistence): the durable step log replays to the saved doc.
    const replayed = JSON.stringify(await replayStepLog(server));
    if (replayed !== serverJson) {
      fail("durable step log does not replay to the persisted document", `replay:\n${replayed}\nserver:\n${serverJson}`);
    }

    // INVARIANT 3 (no lost work): every applied AI marker survived to the final doc.
    const finalText = schema.nodeFromJSON(JSON.parse(serverContent.content)).textContent;
    for (const marker of applied) {
      if (!finalText.includes(marker)) {
        fail(`applied AI edit ${marker} was silently lost`, `final text:\n${finalText}`);
      }
    }
  } finally {
    await cleanupDoc(userId, documentId);
  }
}

// ── the test ────────────────────────────────────────────────────────────────

const TRACES = Number.parseInt(process.env.SIM_TRACES || "30", 10);
const EVENTS = Number.parseInt(process.env.SIM_EVENTS || "40", 10);
const FIXED_SEED = process.env.SIM_SEED ? Number.parseInt(process.env.SIM_SEED, 10) : null;

// Stale-push 409s are an expected, handled part of the protocol; silence the
// server's warn-level log so the trace output stays readable.
async function withQuietWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

if (FIXED_SEED !== null) {
  test(`collab simulation (seed ${FIXED_SEED})`, async () => {
    await withQuietWarnings(() => runTrace(FIXED_SEED, EVENTS));
  });
} else {
  test(`collab simulation (${TRACES} random traces × ${EVENTS} events)`, async () => {
    await withQuietWarnings(async () => {
      for (let i = 0; i < TRACES; i += 1) {
        // Deterministic per-iteration seed so a failure is reproducible via SIM_SEED.
        await runTrace(0x9e3779b9 ^ (i * 2654435761), EVENTS);
      }
    });
  });
}
