import {
  groupAgentEvents,
  parseToolMessage,
  toolDisplayName,
  toolResultFailed
} from "@/components/document-workspace/timeline-model";
import type { AiRunEventView } from "@/components/document-workspace/types";
import { TIMELINE_EVENT_WHERE } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { loadDocumentEnv } from "@/lib/document-env";
import { getUserCredential } from "@/lib/user-credentials";

// Run outline: a handful of high-level sections over a run's timeline ("Set up
// the environment", "Debug the failing eval", …), written by a cheap model
// from a one-line-per-event digest. The agent view shows them as markers next
// to the timeline.
//
// Generated on demand (someone with agent access opens the run), stored in
// AiRunOutline, extended while the run is live and frozen once it has ended.
// The model call uses ACCOUNT credentials only — document env, then the
// viewer, then the document owner — never a host key (see "No host
// credentials, ever" in CLAUDE.md). With none, there is no outline and the
// client falls back to its rule-based one.

export type RunOutlineSection = { startEventId: string; title: string };

export type RunOutlineView = {
  /** `pending`: a generation is in flight; ask again shortly. */
  status: "ready" | "pending" | "unavailable";
  sections: RunOutlineSection[];
  model: string | null;
  reason?: string;
};

export type OutlineDigestItem = { eventId: string; line: string };

/** Digest lines per model call. */
export const OUTLINE_CHUNK_ITEMS = 220;
/** Model calls per generation pass; a longer run is finished by later passes. */
const OUTLINE_MAX_CALLS_PER_PASS = 8;
/** Below this there is nothing to summarize: the messages are the outline. */
export const OUTLINE_MIN_ITEMS = 10;
/** A live run is re-annotated once it has this many new events … */
const OUTLINE_REFRESH_EVENTS = 25;
/** … and its outline is at least this old. */
const OUTLINE_REFRESH_MS = 60_000;
const OUTLINE_FAILURE_RETRY_MS = 5 * 60_000;
const OUTLINE_EVENT_CAP = 8000;
const OUTLINE_CALL_TIMEOUT_MS = 60_000;
const TITLE_MAX = 80;

const PLAN_TOOLS = new Set(["TodoWrite", "TaskUpdate", "TaskList", "TaskGet"]);

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolLine(callMessage: string): string | null {
  const parsed = parseToolMessage(callMessage);
  if (!parsed) return oneLine(callMessage, 140);
  if (PLAN_TOOLS.has(parsed.name)) return null;
  const args = parsed.args ?? {};
  const pick = ["command", "file_path", "pattern", "query", "url", "subject", "description", "prompt", "skill"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return `${toolDisplayName(parsed.name)}: ${oneLine(pick ?? parsed.body, 160)}`;
}

/**
 * One line per thing that happened, in timeline order: the prompt, agent
 * commentary, each tool call (flagged when it failed), errors. System notes
 * and lifecycle steps are plumbing and left out.
 */
export function buildOutlineDigest(events: AiRunEventView[]): OutlineDigestItem[] {
  const items: OutlineDigestItem[] = [];
  for (const item of groupAgentEvents(events)) {
    if (item.kind === "message") {
      const label = item.role === "user" ? "USER" : item.role === "error" ? "ERROR" : "AGENT";
      items.push({ eventId: item.event.id, line: `${label}: ${oneLine(item.event.message, item.role === "user" ? 400 : 280)}` });
    } else if (item.kind === "tool") {
      const line = toolLine(item.call.message);
      if (line) items.push({ eventId: item.call.id, line: toolResultFailed(item.result) ? `${line} [FAILED]` : line });
    }
  }
  return items;
}

const OUTLINE_SYSTEM_PROMPT = `You annotate the work log of an AI agent so a person can navigate it.

The log is a numbered list of events: USER messages, AGENT commentary, tool calls (shell commands, file edits, …) and errors. Split it into consecutive sections, one per phase of the work, and title each.

Rules:
- High level. A section is a phase such as "Set up the environment", "Write the evaluation script", "Debug the failing run", "Analyse results", "Write the report". Most sections span 8 to 40 events. Prefer few sections; never one per event.
- Titles are 3 to 8 words, sentence case, no trailing period. Say what was done or found, specific to this log (name the thing: the file, the bug, the experiment). Never name tools ("Bash", "Read") and never write generic titles like "Running commands".
- Sections are contiguous and in order. "start" is the number of the first event of the section. The first section starts at the first event shown.
- A follow-up USER message starts a new section.

Reply with JSON only, no prose and no code fence:
{"sections":[{"start":<number>,"title":"<title>"}]}`;

export function buildOutlinePrompt(
  items: OutlineDigestItem[],
  from: number,
  to: number,
  priorTitles: string[]
): { system: string; user: string } {
  const lines = items.slice(from, to).map((item, index) => `${from + index + 1}. ${item.line}`);
  const context =
    priorTitles.length > 0
      ? `Earlier sections of this log, already titled (do not repeat them):\n${priorTitles
          .slice(-12)
          .map((title) => `- ${title}`)
          .join("\n")}\n\n`
      : "";
  const more = to < items.length ? "\n\n(The log continues after this excerpt.)" : "";
  return {
    system: OUTLINE_SYSTEM_PROMPT,
    user: `${context}Events ${from + 1} to ${to}:\n${lines.join("\n")}${more}`
  };
}

/**
 * Sections from a model reply, as 0-based item indices inside [from, to).
 * Tolerates a code fence or prose around the JSON; drops out-of-range and
 * non-increasing starts; the first section always starts at `from`.
 */
export function parseOutlineResponse(text: string, from: number, to: number): Array<{ index: number; title: string }> {
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open === -1 || close <= open) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return [];
  }
  const raw = (parsed as { sections?: unknown })?.sections;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ index: number; title: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const start = Number((entry as { start?: unknown }).start);
    const titleRaw = (entry as { title?: unknown }).title;
    if (!Number.isInteger(start) || typeof titleRaw !== "string") continue;
    const title = oneLine(titleRaw, TITLE_MAX).replace(/[.\s]+$/, "");
    const index = start - 1;
    if (!title || index < from || index >= to) continue;
    if (out.length > 0 && index <= out[out.length - 1].index) continue;
    out.push({ index, title });
  }
  if (out.length > 0) out[0].index = from;
  return out;
}

// --- model ---------------------------------------------------------------

export type OutlineModel = {
  api: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Shown to the viewer and stored: "<provider>:<model>". */
  label: string;
};

function hostReachable(url: string): string {
  // The server process cannot resolve host.docker.internal on native Linux.
  return url.replace("://host.docker.internal", "://127.0.0.1").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Cheap models this viewer's account can pay for, best first. Credentials:
 * document env, then the viewer's connected key, then the document owner's —
 * the same order an agent run started by this viewer would use.
 */
export async function resolveOutlineModels(documentId: string, userId: string | null): Promise<OutlineModel[]> {
  const [docEnv, doc] = await Promise.all([
    loadDocumentEnv(documentId),
    db.document.findUnique({ where: { id: documentId }, select: { ownerId: true } })
  ]);
  const account = async (provider: "anthropic" | "litellm" | "openrouter" | "openai") => {
    const own = userId ? await getUserCredential(userId, provider) : null;
    if (own) return own;
    return doc?.ownerId && doc.ownerId !== userId ? getUserCredential(doc.ownerId, provider) : null;
  };
  const env = process.env;
  const models: OutlineModel[] = [];

  const anthropicKey = docEnv.ANTHROPIC_API_KEY?.trim() || null;
  const anthropicAccount = anthropicKey ? null : await account("anthropic");
  // Subscription (OAuth) tokens are for the agent harness, not for raw API calls.
  const anthropic = anthropicKey ?? (anthropicAccount?.kind === "api_key" ? anthropicAccount.value : null);
  if (anthropic) {
    const model = env.RUN_OUTLINE_ANTHROPIC_MODEL?.trim() || "claude-haiku-5-5";
    models.push({ api: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: anthropic, model, label: `anthropic:${model}` });
  }

  const litellm = docEnv.LITELLM_API_KEY?.trim() || (await account("litellm"))?.value || null;
  const litellmBase = docEnv.LITELLM_BASE_URL?.trim() || env.LITELLM_BASE_URL?.trim();
  if (litellm && litellmBase) {
    const model = env.RUN_OUTLINE_LITELLM_MODEL?.trim() || "anthropic/claude-haiku-5-5";
    models.push({ api: "openai", baseUrl: hostReachable(litellmBase), apiKey: litellm, model, label: `litellm:${model}` });
  }

  const openrouter = docEnv.OPENROUTER_API_KEY?.trim() || (await account("openrouter"))?.value || null;
  if (openrouter) {
    const model = env.RUN_OUTLINE_OPENROUTER_MODEL?.trim() || "anthropic/claude-haiku-4.5";
    models.push({ api: "openai", baseUrl: "https://openrouter.ai/api", apiKey: openrouter, model, label: `openrouter:${model}` });
  }

  const openai = docEnv.OPENAI_API_KEY?.trim() || (await account("openai"))?.value || null;
  if (openai) {
    const model = env.RUN_OUTLINE_OPENAI_MODEL?.trim() || "gpt-4o-mini";
    models.push({ api: "openai", baseUrl: "https://api.openai.com", apiKey: openai, model, label: `openai:${model}` });
  }

  // The deployment's own local model: free, but often offline.
  const localBase = env.LOCAL_MODEL_BASE_URL?.trim();
  const localName = env.LOCAL_MODEL_NAME?.trim();
  if (localBase && localName) {
    models.push({ api: "openai", baseUrl: hostReachable(localBase), apiKey: null, model: localName, label: `local:${localName}` });
  }
  return models;
}

export async function callOutlineModel(model: OutlineModel, prompt: { system: string; user: string }): Promise<string> {
  const signal = AbortSignal.timeout(OUTLINE_CALL_TIMEOUT_MS);
  if (model.api === "anthropic") {
    const response = await fetch(`${model.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(model.apiKey ? { "x-api-key": model.apiKey } : {})
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: 3000,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }]
      })
    });
    if (!response.ok) throw new Error(`${model.label} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    return (body.content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
  }
  const response = await fetch(`${model.baseUrl}/v1/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: model.model,
      max_tokens: 3000,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    })
  });
  if (!response.ok) throw new Error(`${model.label} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

// --- generation ----------------------------------------------------------

export type OutlineAnnotation = {
  sections: RunOutlineSection[];
  /** Number of digest items the sections cover (a prefix of the digest). */
  covered: number;
  model: string | null;
  calls: number;
};

/**
 * Annotate a digest, continuing from `previous` when it still matches: the
 * earlier sections are kept and only the last one (which may have grown) and
 * everything after it go to the model. Long logs are read in chunks; the last
 * section of a chunk is redone together with the next one, since the chunk
 * boundary probably cut it.
 */
export async function annotateDigest(
  items: OutlineDigestItem[],
  previous: RunOutlineSection[],
  models: OutlineModel[],
  call: typeof callOutlineModel = callOutlineModel
): Promise<OutlineAnnotation> {
  const indexOf = new Map(items.map((item, index) => [item.eventId, index]));
  let kept: Array<{ index: number; title: string }> = [];
  const previousIndexed = previous.map((section) => ({ index: indexOf.get(section.startEventId), title: section.title }));
  if (previousIndexed.length > 0 && previousIndexed.every((section) => section.index !== undefined)) {
    kept = (previousIndexed as Array<{ index: number; title: string }>).sort((a, b) => a.index - b.index);
  }
  // The last known section is provisional: it is re-read with what came after.
  let from = kept.length > 0 ? kept.pop()!.index : 0;
  let working: OutlineModel | null = null;
  let calls = 0;
  let covered = from;
  let lastError: unknown = null;

  while (from < items.length && calls < OUTLINE_MAX_CALLS_PER_PASS) {
    const to = Math.min(items.length, from + OUTLINE_CHUNK_ITEMS);
    const prompt = buildOutlinePrompt(items, from, to, kept.map((section) => section.title));
    let sections: Array<{ index: number; title: string }> = [];
    const candidates: OutlineModel[] = working ? [working] : models;
    for (const candidate of candidates) {
      try {
        calls++;
        sections = parseOutlineResponse(await call(candidate, prompt), from, to);
        if (sections.length === 0) throw new Error(`${candidate.label} returned no usable sections`);
        working = candidate;
        break;
      } catch (error) {
        lastError = error;
        console.warn("[run-outline] model call failed", { model: candidate.label, error: String(error).slice(0, 300) });
      }
    }
    if (sections.length === 0) break;
    covered = to;
    if (to >= items.length) {
      kept.push(...sections);
      break;
    }
    const last = sections[sections.length - 1];
    if (last.index > from) {
      kept.push(...sections.slice(0, -1));
      from = last.index;
    } else {
      // One section fills the whole chunk: keep it and move on.
      kept.push(...sections);
      from = to;
    }
  }
  if (!working) {
    throw lastError instanceof Error ? lastError : new Error("No model available for the run outline.");
  }
  // Items past `covered` belong to the last section until a later pass reads them.
  return {
    sections: kept.map((section) => ({ startEventId: items[section.index].eventId, title: section.title })),
    covered,
    model: working.label,
    calls
  };
}

type OutlineJobState = {
  inFlight: Map<string, Promise<void>>;
  failures: Map<string, { at: number; reason: string }>;
};

const OUTLINE_GLOBAL_KEY = Symbol.for("gdocs.runOutlineJobs");

// globalThis: route handlers and instrumentation live in different module contexts.
function jobs(): OutlineJobState {
  const holder = globalThis as unknown as Record<symbol, OutlineJobState | undefined>;
  holder[OUTLINE_GLOBAL_KEY] ??= { inFlight: new Map(), failures: new Map() };
  return holder[OUTLINE_GLOBAL_KEY]!;
}

function parseSections(raw: string | null | undefined): RunOutlineSection[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (section): section is RunOutlineSection =>
        Boolean(section) && typeof section.startEventId === "string" && typeof section.title === "string"
    );
  } catch {
    return [];
  }
}

function isTerminal(status: string): boolean {
  return status !== "RUNNING" && status !== "PENDING";
}

/** One generation pass: read the timeline, annotate what is new, store. */
export async function generateRunOutline(
  runId: string,
  documentId: string,
  userId: string | null,
  call: typeof callOutlineModel = callOutlineModel
): Promise<void> {
  const [run, stored] = await Promise.all([
    db.aiRun.findUnique({ where: { id: runId }, select: { status: true } }),
    db.aiRunOutline.findUnique({ where: { aiRunId: runId } })
  ]);
  if (!run) return;
  const terminal = isTerminal(run.status);
  const rows = await db.aiRunEvent.findMany({
    where: { aiRunId: runId, ...TIMELINE_EVENT_WHERE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: OUTLINE_EVENT_CAP,
    select: { id: true, role: true, message: true, createdAt: true }
  });
  const events = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) as AiRunEventView[];
  const items = buildOutlineDigest(events);
  const save = (data: { sections: RunOutlineSection[]; covered: number; model: string | null }) => {
    const fields = {
      sections: JSON.stringify(data.sections),
      coveredEventId: data.covered > 0 ? items[data.covered - 1].eventId : null,
      eventCount: rows.length,
      final: terminal && data.covered >= items.length,
      model: data.model
    };
    return db.aiRunOutline.upsert({ where: { aiRunId: runId }, create: { aiRunId: runId, ...fields }, update: fields });
  };
  if (items.length < OUTLINE_MIN_ITEMS) {
    // Too short to need sections; remember that for an ended run.
    if (terminal) await save({ sections: [], covered: items.length, model: null });
    return;
  }
  const models = await resolveOutlineModels(documentId, userId);
  if (models.length === 0) {
    throw new OutlineUnavailableError("no-credential");
  }
  const annotation = await annotateDigest(items, parseSections(stored?.sections), models, call);
  await save(annotation);
  console.log("[run-outline] generated", {
    runId,
    model: annotation.model,
    sections: annotation.sections.length,
    items: items.length,
    covered: annotation.covered,
    calls: annotation.calls
  });
}

export class OutlineUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * The outline to show for a run, starting or refreshing its generation in the
 * background when it is missing or stale and the viewer may spend model calls
 * (`canGenerate`: signed in with agent access). Never waits for the model.
 */
export async function getRunOutline(input: {
  runId: string;
  documentId: string;
  userId: string | null;
  canGenerate: boolean;
}): Promise<RunOutlineView | null> {
  const { runId, documentId, userId, canGenerate } = input;
  const [run, stored] = await Promise.all([
    db.aiRun.findFirst({ where: { id: runId, documentId }, select: { status: true } }),
    db.aiRunOutline.findUnique({ where: { aiRunId: runId } })
  ]);
  if (!run) return null;
  const sections = parseSections(stored?.sections);
  const ready: RunOutlineView = { status: "ready", sections, model: stored?.model ?? null };
  if (stored?.final) return ready;

  const state = jobs();
  if (state.inFlight.has(runId)) return { ...ready, status: "pending" };

  const terminal = isTerminal(run.status);
  let stale = !stored || terminal;
  if (!stale && stored) {
    const count = await db.aiRunEvent.count({ where: { aiRunId: runId, ...TIMELINE_EVENT_WHERE } });
    stale =
      count - stored.eventCount >= OUTLINE_REFRESH_EVENTS && Date.now() - stored.updatedAt.getTime() >= OUTLINE_REFRESH_MS;
  }
  if (!stale) return ready;
  if (!canGenerate) return stored ? ready : { status: "unavailable", sections: [], model: null, reason: "not-generated" };
  const failure = state.failures.get(runId);
  if (failure && Date.now() - failure.at < OUTLINE_FAILURE_RETRY_MS) {
    return stored ? ready : { status: "unavailable", sections: [], model: null, reason: failure.reason };
  }

  const job = generateRunOutline(runId, documentId, userId)
    .then(() => {
      state.failures.delete(runId);
    })
    .catch((error) => {
      const reason = error instanceof OutlineUnavailableError ? error.reason : "model-error";
      state.failures.set(runId, { at: Date.now(), reason });
      if (reason === "model-error") {
        console.warn("[run-outline] generation failed", { runId, error: String(error).slice(0, 300) });
      }
    })
    .finally(() => {
      state.inFlight.delete(runId);
    });
  state.inFlight.set(runId, job);
  return { ...ready, status: "pending" };
}

/** Test seam: wait for the background generation of a run, if any. */
export function runOutlineJob(runId: string): Promise<void> | undefined {
  return jobs().inFlight.get(runId);
}
