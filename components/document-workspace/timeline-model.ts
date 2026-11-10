import { lifecycleStepLabel, SUBMIT_STEP_LABEL } from "@/agent-core/lifecycle-messages";

import type { AiRunEventView } from "./types";

// The pure model of the agent timeline: parsing tool events, pairing calls
// with their results, grouping. No React — the server imports this to build
// the digest the outline annotator reads (lib/run-outline.ts).

export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown> | null;
  body: string;
  /** The stored input was cut at the event cap; `args` holds what survived. */
  clipped: boolean;
};

// String arguments worth recovering from a call whose JSON was clipped.
const RECOVERABLE_ARG_KEYS = [
  "command",
  "description",
  "file_path",
  "path",
  "pattern",
  "glob",
  "query",
  "url",
  "prompt",
  "subject",
  "skill",
  "old_string",
  "new_string",
  "content",
  "text",
  "message"
];

/**
 * A tool input longer than the event cap (a heredoc that writes a script, a
 * big Write) is stored clipped mid-JSON and does not parse. Recover its string
 * fields so the row still shows — and expands to — the command that ran.
 */
function recoverClippedArgs(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const key of RECOVERABLE_ARG_KEYS) {
    const value = extractJsonStringField(body, key);
    if (value !== null) args[key] = value;
  }
  return Object.keys(args).length > 0 ? args : null;
}

export function parseToolMessage(message: string): ParsedToolCall | null {
  const trimmed = message.trim();
  const usingMatch = trimmed.match(/^Using\s+([A-Za-z][A-Za-z0-9_]*)\.?$/);
  if (usingMatch) {
    return { name: usingMatch[1], args: null, body: "", clipped: false };
  }
  const colonIdx = trimmed.indexOf(": ");
  if (colonIdx < 1 || colonIdx > 60) {
    return null;
  }
  const name = trimmed.slice(0, colonIdx).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return null;
  }
  const body = trimmed.slice(colonIdx + 2).trim();
  let args: Record<string, unknown> | null = null;
  let clipped = false;
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = recoverClippedArgs(body);
      clipped = args !== null;
    }
  }
  return { name, args, body, clipped };
}

export function isUsingProgressMessage(message: string): boolean {
  return /^Using\s+[A-Za-z][A-Za-z0-9_]*\.?\s*$/.test(message.trim());
}

/**
 * Human-oriented tool label. MCP tools arrive as `mcp__server__tool_name`;
 * render them as `server: tool name` so "mcp__gdocs__post_slack_message"
 * reads as "gdocs: post slack message".
 */
export function toolDisplayName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] || "mcp";
    const tool = parts.slice(2).join("__").replace(/_/g, " ") || "tool";
    return `${server}: ${tool}`;
  }
  return name;
}


/**
 * Pull the human-readable payload out of a content-block tool result:
 * `[{"tool_use_id":…,"type":"tool_result","content":"…"}]`. This is the shape
 * emitted for tool calls that arrive on the content-block path (subagents, and
 * the Task* tool family) — as opposed to the object-shaped `tool_use_result`.
 * Returns null when the message is not that shape.
 */
export function unwrapToolResultText(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("[")) return null;
  const stringOf = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value
        .map((inner) =>
          inner && typeof inner === "object" && typeof (inner as { text?: unknown }).text === "string"
            ? (inner as { text: string }).text
            : null
        )
        .filter((part): part is string => Boolean(part));
      return parts.length ? parts.join("\n") : null;
    }
    return null;
  };
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const parts = parsed
      .map((block) => {
        if (!block || typeof block !== "object") return null;
        const record = block as Record<string, unknown>;
        return stringOf(record.text) ?? stringOf(record.content);
      })
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : null;
  } catch {
    // Clipped at the event cap mid-JSON — recover what was stored.
    return extractJsonStringField(trimmed, "content") ?? extractJsonStringField(trimmed, "text");
  }
}


/**
 * Decode the JSON string value of `key` inside `text`, tolerating text that is
 * NOT valid JSON because the event was clipped at the storage cap mid-string.
 * Returns everything decoded up to the truncation point. This is what lets
 * historical runs (whose tool_use_result payloads were stored as possibly
 * truncated JSON) still render file views, diffs and terminal output.
 */
export function extractJsonStringField(text: string, key: string): string | null {
  const keyIdx = text.indexOf(`"${key}"`);
  if (keyIdx === -1) return null;
  let i = text.indexOf(":", keyIdx + key.length + 2);
  if (i === -1) return null;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '"') return null;
  i++;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return out;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      } else out += next;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Ran off the end: the stored event was clipped inside this string.
  return out || null;
}


export type GroupedAgentEvent =
  | { kind: "message"; role: "user" | "agent" | "error"; event: AiRunEventView; key: string }
  /** Consecutive system notes (worktree path, credential policy, …) — one collapsed row. */
  | { kind: "notes"; events: AiRunEventView[]; event: AiRunEventView; key: string }
  | { kind: "step"; label: string; event: AiRunEventView; key: string }
  | { kind: "tool"; call: AiRunEventView; result: AiRunEventView | null; key: string };

export type ToolItem = Extract<GroupedAgentEvent, { kind: "tool" }>;

function normalizeForEcho(text: string): string {
  return text.replace(/…$/, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The SDK's `task_started` frame echoes the command (or description) of a
 * call that is still running as a `system` event — pure duplication. */
function isEchoOfOpenCall(message: string, open: ToolItem[]): boolean {
  const echo = normalizeForEcho(message);
  if (!echo) return false;
  return open.some((item) => {
    const args = parseToolMessage(item.call.message)?.args;
    if (!args) return false;
    return [args.command, args.description, args.prompt].some(
      (value) => typeof value === "string" && normalizeForEcho(value).startsWith(echo.slice(0, 60))
    );
  });
}

export function groupAgentEvents(events: AiRunEventView[]): GroupedAgentEvent[] {
  const out: GroupedAgentEvent[] = [];
  // Calls still waiting for their result, oldest first. A result is NOT always
  // the next event: a long call is followed by "Using X." heartbeats and a
  // background-task echo first, and parallel calls are emitted as call, call,
  // result, result. Results therefore attach to the oldest open call.
  let open: ToolItem[] = [];
  let prevRaw: AiRunEventView | null = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    // Exact consecutive duplicates (e.g. a submit retried after validation)
    // add nothing but noise.
    if (prevRaw && prevRaw.role === ev.role && prevRaw.message === ev.message) {
      continue;
    }
    prevRaw = ev;
    if (ev.role === "tool") {
      if (isUsingProgressMessage(ev.message)) {
        // Heartbeat of a call that is already on screen.
        const name = parseToolMessage(ev.message)?.name;
        if (open.some((item) => parseToolMessage(item.call.message)?.name === name)) continue;
        // "Using Read." is a low-value progress signal — keep only when a richer
        // "Read: {...}" event isn't right next to it.
        const neighborHasDetails = [events[i - 1], events[i + 1]].some((neighbor) => {
          if (!neighbor || neighbor.role !== "tool") return false;
          if (isUsingProgressMessage(neighbor.message)) return false;
          return true;
        });
        if (neighborHasDetails) continue;
      }
      const item: ToolItem = { kind: "tool", call: ev, result: null, key: ev.id };
      out.push(item);
      open.push(item);
      continue;
    }
    if (ev.role === "tool_result") {
      // Orphan tool_results (no open call) have no context — skip.
      const target = open.shift();
      if (target) target.result = ev;
      continue;
    }
    if (!ev.message.trim()) continue;
    if (ev.role === "system") {
      if (isEchoOfOpenCall(ev.message, open)) continue;
      const step = lifecycleStepLabel(ev.message);
      if (step) {
        out.push({ kind: "step", label: step, event: ev, key: ev.id });
        continue;
      }
      const last = out[out.length - 1];
      if (last?.kind === "notes") {
        last.events.push(ev);
      } else {
        out.push({ kind: "notes", events: [ev], event: ev, key: ev.id });
      }
      continue;
    }
    // A new turn of prose means every earlier call has returned; a call still
    // open here never got a result (cancelled, lost frame) and must not steal
    // a later one.
    open = [];
    const role: "user" | "agent" | "error" = ev.role === "user" || ev.role === "error" ? ev.role : "agent";
    out.push({ kind: "message", role, event: ev, key: ev.id });
  }
  return out;
}

/** A tool result that reports failure (non-zero exit, tool error). */
export function toolResultFailed(result: AiRunEventView | null): boolean {
  if (!result) return false;
  const text = (unwrapToolResultText(result.message) ?? result.message).trimStart();
  return /^(Error\b|<tool_use_error>)/.test(text) || /"is_error"\s*:\s*true/.test(result.message.slice(0, 400));
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Wall-clock time of a call, when it took long enough to be worth showing. */
export function toolDuration(call: AiRunEventView, result: AiRunEventView | null): string | null {
  if (!result) return null;
  const ms = new Date(result.createdAt).getTime() - new Date(call.createdAt).getTime();
  return ms >= 5000 ? formatDuration(ms) : null;
}

/**
 * The agent's final reply is recorded as a plain `agent` event after the
 * submit lifecycle steps — indistinguishable from interim commentary without
 * this: the last agent message after the last "Submitting final response"
 * step (and after the last user message) is the submitted reply. Returns the
 * grouped index to badge, or -1 (e.g. while the run is still streaming).
 */
export function findFinalReplyIndex(grouped: GroupedAgentEvent[], isRunning: boolean): number {
  if (isRunning) return -1;
  let lastSubmit = -1;
  let lastUser = -1;
  let lastAgent = -1;
  for (let i = 0; i < grouped.length; i++) {
    const item = grouped[i];
    if (item.kind === "step" && item.label === SUBMIT_STEP_LABEL) lastSubmit = i;
    if (item.kind === "message" && item.role === "user") lastUser = i;
    if (item.kind === "message" && item.role === "agent") lastAgent = i;
  }
  if (lastSubmit === -1 || lastSubmit < lastUser) return -1;
  return lastAgent > lastSubmit ? lastAgent : -1;
}


/** What the timeline renders: grouped events with runs of tool calls folded. */
export type TimelineItem =
  | Exclude<GroupedAgentEvent, { kind: "tool" }>
  | ToolItem
  | { kind: "toolRun"; items: ToolItem[]; key: string };

/**
 * Fold every run of two or more consecutive tool calls into one item, so the
 * timeline reads as prose with "Ran 16 tool calls" between the messages. The
 * key is the first call's, so a run that is still growing keeps its identity
 * (and its open/closed state) across polls.
 */
export function foldToolRuns(grouped: GroupedAgentEvent[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push({ kind: "toolRun", items: run, key: `run:${run[0].key}` });
    run = [];
  };
  for (const item of grouped) {
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

export type ToolRunSummary = {
  count: number;
  failed: number;
  /** "Bash ×12, Write ×2, Read" — most used first. */
  breakdown: string;
  /** First call to last result, when known. */
  durationMs: number | null;
};

export function summarizeToolRun(items: ToolItem[]): ToolRunSummary {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const item of items) {
    const parsed = parseToolMessage(item.call.message);
    const name = parsed ? toolDisplayName(parsed.name) : "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (toolResultFailed(item.result)) failed++;
  }
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = names.slice(0, 4).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  if (names.length > 4) shown.push(`+${names.length - 4} more`);
  const first = items[0];
  let end = 0;
  for (const item of items) {
    if (item.result) end = Math.max(end, new Date(item.result.createdAt).getTime());
  }
  const durationMs = first && end ? end - new Date(first.call.createdAt).getTime() : null;
  return { count: items.length, failed, breakdown: shown.join(", "), durationMs };
}
