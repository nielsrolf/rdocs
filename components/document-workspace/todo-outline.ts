import type { AiRunEventView } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoSnapshotItem = { content: string; status: TodoStatus };

export type TodoOutlineItem = {
  /** Stable key = normalized content. */
  key: string;
  content: string;
  /** Status in the newest snapshot that mentioned this item. */
  status: TodoStatus;
  /** Event id of the TodoWrite snapshot where this status was first reached — scroll anchor. */
  anchorEventId: string;
  /** The step the agent is (or was last) working on. */
  current: boolean;
};

export type TodoOutline = {
  items: TodoOutlineItem[];
  /** Number of TodoWrite snapshots seen in the session. */
  snapshots: number;
  done: number;
};

function normalizeStatus(value: unknown): TodoStatus {
  if (value === "completed" || value === "in_progress" || value === "pending") return value;
  if (value === true) return "completed";
  if (value === "done" || value === "complete") return "completed";
  if (value === "active" || value === "running") return "in_progress";
  return "pending";
}

/**
 * Todo entries arrive in two shapes: Claude Code's `{content, status, activeForm}`
 * and the Codex SDK's plan items `{text, completed}` (mapped in
 * agent-core/codex-agent.ts). Normalize both.
 */
export function normalizeTodoItem(raw: unknown): TodoSnapshotItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const content =
    typeof item.content === "string"
      ? item.content
      : typeof item.text === "string"
        ? item.text
        : typeof item.subject === "string"
          ? item.subject
          : typeof item.activeForm === "string"
            ? item.activeForm
            : "";
  if (!content.trim()) return null;
  const status = "status" in item ? normalizeStatus(item.status) : normalizeStatus(item.completed);
  return { content: content.trim(), status };
}

export function todoStatusMark(status: TodoStatus): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "◐" : "○";
}

const CONTENT_RE = /"(?:content|text|subject)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const STATUS_RE = /"(?:status)"\s*:\s*"((?:[^"\\]|\\.)*)"|"completed"\s*:\s*(true|false)/g;

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/**
 * Recover todos from a TodoWrite event body. Event messages are capped
 * (MAX_PROGRESS_MESSAGE_LENGTH in agent-core), so a long list can arrive
 * truncated mid-JSON — fall back to a positional regex scan pairing each
 * content with the status that follows it.
 */
export function parseTodoSnapshot(message: string): TodoSnapshotItem[] | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("TodoWrite:")) return null;
  const body = trimmed.slice("TodoWrite:".length).trim();
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as { todos?: unknown };
      if (Array.isArray(parsed?.todos)) {
        const items = parsed.todos
          .map(normalizeTodoItem)
          .filter((item): item is TodoSnapshotItem => Boolean(item));
        return items.length ? items : null;
      }
    } catch {
      // Clipped mid-JSON — fall through to the positional scan below.
    }
  }
  const contents: Array<{ index: number; value: string }> = [];
  const statuses: Array<{ index: number; value: unknown }> = [];
  for (const match of body.matchAll(CONTENT_RE)) {
    contents.push({ index: match.index ?? 0, value: unescapeJsonString(match[1]) });
  }
  for (const match of body.matchAll(STATUS_RE)) {
    statuses.push({ index: match.index ?? 0, value: match[1] !== undefined ? match[1] : match[2] === "true" });
  }
  if (!contents.length) return null;
  const items: TodoSnapshotItem[] = [];
  for (let i = 0; i < contents.length; i++) {
    const start = contents[i].index;
    const end = i + 1 < contents.length ? contents[i + 1].index : Number.MAX_SAFE_INTEGER;
    const status = statuses.find((s) => s.index > start && s.index < end);
    const content = contents[i].value.trim();
    if (!content) continue;
    items.push({ content, status: normalizeStatus(status?.value) });
  }
  return items.length ? items : null;
}

/**
 * Fold every TodoWrite snapshot of a session into one ordered outline: each
 * todo appears once, with its status as of the newest snapshot that mentioned
 * it, and an anchor pointing at the snapshot where it reached that status.
 */
export function buildTodoOutline(events: AiRunEventView[]): TodoOutline {
  const byKey = new Map<string, TodoOutlineItem>();
  let snapshots = 0;
  let lastOrder: string[] = [];
  for (const event of events) {
    if (event.role !== "tool") continue;
    const items = parseTodoSnapshot(event.message);
    if (!items) continue;
    snapshots += 1;
    lastOrder = items.map((item) => item.content.toLowerCase());
    for (const item of items) {
      const key = item.content.toLowerCase();
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          content: item.content,
          status: item.status,
          anchorEventId: event.id,
          current: false
        });
        continue;
      }
      if (existing.status !== item.status) {
        existing.status = item.status;
        existing.anchorEventId = event.id;
      }
      existing.content = item.content;
    }
  }

  // Present the newest snapshot's ordering; todos dropped from the plan keep
  // their first-seen order after it.
  const all = [...byKey.values()];
  const rank = new Map(lastOrder.map((key, index) => [key, index]));
  const items = [
    ...all.filter((item) => rank.has(item.key)).sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0)),
    ...all.filter((item) => !rank.has(item.key))
  ];

  let currentIndex = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].status === "in_progress") currentIndex = i;
  }
  if (currentIndex === -1 && items.some((item) => item.status === "completed")) {
    // Codex plans have no in_progress state: the first unfinished step is current.
    currentIndex = items.findIndex((item) => item.status !== "completed");
  }
  if (currentIndex >= 0) items[currentIndex].current = true;

  return { items, snapshots, done: items.filter((item) => item.status === "completed").length };
}
