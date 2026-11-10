import { truncate } from "@/lib/utils";

import {
  extractJsonStringField,
  findFinalReplyIndex,
  groupAgentEvents,
  parseToolMessage,
  toolDisplayName,
  toolDuration,
  toolResultFailed,
  type GroupedAgentEvent
} from "./timeline-model";
import type { AiRunEventView } from "./types";
import { basename } from "./utils";

/**
 * Trajectory outline: a navigable table of contents of what the agent did,
 * derived from the events alone (no model call). Messages are the headings —
 * the prompt, each piece of agent commentary, errors, the final reply — and
 * the tool work between them is listed underneath, one line per action, with
 * runs of look-alike actions (file reads, searches, repeated edits of one
 * file) folded into a single line.
 */
export type TrajectoryEntry = {
  key: string;
  /** `data-agent-event-id` of the timeline element this entry scrolls to. */
  anchorEventId: string;
  kind: "prompt" | "agent" | "reply" | "error" | "action";
  label: string;
  /** Right-aligned hint: a count for folded runs, a duration for slow calls. */
  hint?: string;
  failed?: boolean;
  running?: boolean;
  at: string | Date;
};

const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part && !/^```/.test(part));
  return line ?? "";
}

/** First line of prose, without Markdown decoration. */
function proseLine(text: string): string {
  return firstLine(text).replace(/^#+\s*/, "").replace(/\*\*|__|`/g, "");
}

/** What a shell command is for, in a few words. */
export function describeShellCommand(command: string): string {
  // A heredoc that writes a file is an edit in disguise.
  const heredoc = command.match(/(?:cat|tee)\s*(?:>|>>)?\s*([^\s<>|;&]+)\s*<<-?\s*['"]?\w+/);
  // Leading `cd dir &&` / `cd dir;` says where, not what.
  const body = command.replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "");
  if (heredoc && /^\s*(?:mkdir\s[^;&]*(?:&&|;)\s*)?(?:cat|tee)\b/.test(body)) {
    return `Write ${basename(heredoc[1])}`;
  }
  const lines = body.split("\n").map((part) => part.trim()).filter(Boolean);
  // An inline script (`python3 - <<EOF`, `python3 -c "`) says nothing on its
  // first line; show the interpreter and the first line of the script.
  const inline = lines[0]?.match(/^(.*?\b(?:python3?|node|bash|sh|ruby)\b)\s+(?:-\s*<<-?\s*['"]?\w+['"]?|-[ce]\s+["']?)$/);
  if (inline && lines[1]) return `${inline[1]}: ${lines[1]}`;
  return lines[0] ?? "";
}

type Action = { label: string; fold?: string };

function describeAction(item: Extract<GroupedAgentEvent, { kind: "tool" }>): Action | null {
  const parsed = parseToolMessage(item.call.message);
  if (!parsed) return { label: firstLine(item.call.message) };
  const { name, args, body } = parsed;
  if (PLAN_TOOLS.has(name)) return null; // the plan section shows these
  // Long inputs are clipped at the event cap mid-JSON (args === null); the
  // leading fields are still recoverable.
  const str = (key: string) =>
    args ? (typeof args[key] === "string" ? (args[key] as string) : null) : extractJsonStringField(body, key);
  const file = str("file_path") ?? str("path") ?? str("notebook_path");
  if (EXPLORE_TOOLS.has(name)) {
    const target = file ? basename(file) : str("pattern");
    return { label: target ? `${name} ${target}` : name, fold: "explore" };
  }
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") {
    const verb = name === "Write" ? "Write" : "Edit";
    return { label: file ? `${verb} ${basename(file)}` : verb, fold: file ? `edit:${file}` : undefined };
  }
  if (name === "Bash") {
    const description = str("description");
    const command = str("command");
    return { label: description ?? (command ? describeShellCommand(command) : "Shell command") };
  }
  if (name === "Task" || name === "Agent") return { label: `Subagent: ${str("description") ?? "task"}` };
  if (name === "Skill") return { label: `Skill ${str("skill") ?? ""}`.trim() };
  if (name === "WebSearch") return { label: `Search “${str("query") ?? ""}”` };
  if (name === "WebFetch") return { label: `Fetch ${str("url") ?? ""}`.trim() };
  const detail = str("description") ?? str("title") ?? str("text") ?? str("query");
  const display = toolDisplayName(name);
  return { label: detail ? `${display}: ${proseLine(detail)}` : display };
}

export function buildTrajectoryOutline(events: AiRunEventView[], isRunning: boolean): TrajectoryEntry[] {
  const grouped = groupAgentEvents(events);
  const finalReplyIdx = findFinalReplyIndex(grouped, isRunning);
  const entries: TrajectoryEntry[] = [];
  // Open fold: consecutive actions with the same fold key share one entry.
  let fold: { key: string; entry: TrajectoryEntry; count: number; base: string } | null = null;

  grouped.forEach((item, idx) => {
    if (item.kind === "tool") {
      const action = describeAction(item);
      if (!action) return;
      const failed = toolResultFailed(item.result);
      const running = isRunning && !item.result && idx === grouped.length - 1;
      if (action.fold && fold && fold.key === action.fold) {
        fold.count += 1;
        fold.entry.label = fold.key === "explore" ? `Explored ${fold.count} files` : fold.base;
        fold.entry.hint = fold.key === "explore" ? undefined : `×${fold.count}`;
        fold.entry.failed = fold.entry.failed || failed;
        fold.entry.running = running;
        return;
      }
      const entry: TrajectoryEntry = {
        key: item.key,
        anchorEventId: item.call.id,
        kind: "action",
        label: truncate(action.label || "Tool call", 90),
        hint: toolDuration(item.call, item.result) ?? undefined,
        failed,
        running,
        at: item.call.createdAt
      };
      entries.push(entry);
      fold = action.fold ? { key: action.fold, entry, count: 1, base: entry.label } : null;
      return;
    }
    if (item.kind !== "message") return; // steps and system notes are plumbing
    fold = null;
    const label = truncate(proseLine(item.event.message) || "(empty)", 110);
    const kind =
      item.role === "user" ? "prompt" : item.role === "error" ? "error" : idx === finalReplyIdx ? "reply" : "agent";
    const previous = entries[entries.length - 1];
    // Consecutive prose of one speaker is one heading (the first line wins).
    if (previous && previous.kind === kind && kind === "agent" && grouped[idx - 1]?.kind === "message") return;
    entries.push({ key: item.key, anchorEventId: item.event.id, kind, label, at: item.event.createdAt });
  });
  return entries;
}
