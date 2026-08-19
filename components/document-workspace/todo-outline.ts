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
 * The Task tool family (TaskCreate / TaskUpdate / TaskList / TaskGet) replaced
 * the single TodoWrite snapshot tool in newer Claude Code builds. Unlike
 * TodoWrite, the plan is never sent as a whole: each event is an incremental
 * mutation, and the task id a mutation refers to only ever appears in the
 * tool_result text of the create call ("Task #3 created successfully: …").
 */
export type TaskToolEvent =
  | { type: "create"; subject: string }
  | { type: "update"; taskId: string; status: TodoStatus | "deleted" | null; subject: string | null };

function jsonStringField(body: string, key: string): string | null {
  const match = body.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return match ? unescapeJsonString(match[1]) : null;
}

/** Parse a TaskCreate / TaskUpdate tool event, tolerating payloads clipped mid-JSON. */
export function parseTaskToolEvent(message: string): TaskToolEvent | null {
  const trimmed = message.trim();
  if (trimmed.startsWith("TaskCreate:")) {
    const body = trimmed.slice("TaskCreate:".length);
    const subject = jsonStringField(body, "subject");
    return subject && subject.trim() ? { type: "create", subject: subject.trim() } : null;
  }
  if (trimmed.startsWith("TaskUpdate:")) {
    const body = trimmed.slice("TaskUpdate:".length);
    const taskId = jsonStringField(body, "taskId") ?? body.match(/"taskId"\s*:\s*(\d+)/)?.[1] ?? null;
    if (!taskId) return null;
    const rawStatus = jsonStringField(body, "status");
    const subject = jsonStringField(body, "subject");
    return {
      type: "update",
      taskId,
      status: rawStatus === "deleted" ? "deleted" : rawStatus === null ? null : normalizeStatus(rawStatus),
      subject: subject && subject.trim() ? subject.trim() : null
    };
  }
  return null;
}

/** Recover the task id a TaskCreate result announced ("Task #3 created successfully: …"). */
export function parseCreatedTaskId(resultMessage: string): string | null {
  return resultMessage.match(/Task #(\d+) created/)?.[1] ?? null;
}

/**
 * Fold every plan mutation of a session into one ordered outline: each todo
 * appears once, with its status as of the newest event that mentioned it, and
 * an anchor pointing at the event where it reached that status. Handles both
 * whole-plan TodoWrite/Codex snapshots and incremental Task* mutations.
 */
export function buildTodoOutline(events: AiRunEventView[]): TodoOutline {
  const byKey = new Map<string, TodoOutlineItem>();
  const order: string[] = [];
  let snapshots = 0;
  let lastOrder: string[] = [];

  const upsert = (key: string, content: string, status: TodoStatus, eventId: string) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, content, status, anchorEventId: eventId, current: false });
      order.push(key);
      return;
    }
    if (existing.status !== status) {
      existing.status = status;
      existing.anchorEventId = eventId;
    }
    existing.content = content;
  };

  const rekey = (from: string, to: string) => {
    const item = byKey.get(from);
    if (!item || from === to) return;
    byKey.delete(from);
    item.key = to;
    byKey.set(to, item);
    const index = order.indexOf(from);
    if (index >= 0) order[index] = to;
  };

  // A TaskCreate's id is only revealed by the tool_result that follows it.
  let pendingCreateKey: string | null = null;

  for (const event of events) {
    if (event.role === "tool_result") {
      if (pendingCreateKey) {
        const taskId = parseCreatedTaskId(event.message);
        if (taskId) rekey(pendingCreateKey, `task:${taskId}`);
        pendingCreateKey = null;
      }
      continue;
    }
    if (event.role !== "tool") continue;

    const taskEvent = parseTaskToolEvent(event.message);
    if (taskEvent) {
      snapshots += 1;
      if (taskEvent.type === "create") {
        const key = `task-pending:${event.id}`;
        upsert(key, taskEvent.subject, "pending", event.id);
        pendingCreateKey = key;
        continue;
      }
      pendingCreateKey = null;
      const key = `task:${taskEvent.taskId}`;
      if (taskEvent.status === "deleted") {
        byKey.delete(key);
        const index = order.indexOf(key);
        if (index >= 0) order.splice(index, 1);
        continue;
      }
      const existing = byKey.get(key);
      // A task created before the loaded event window still gets a rail entry.
      const content = taskEvent.subject ?? existing?.content ?? `Task #${taskEvent.taskId}`;
      upsert(key, content, taskEvent.status ?? existing?.status ?? "pending", event.id);
      continue;
    }

    pendingCreateKey = null;
    const items = parseTodoSnapshot(event.message);
    if (!items) continue;
    snapshots += 1;
    lastOrder = items.map((item) => item.content.toLowerCase());
    for (const item of items) {
      upsert(item.content.toLowerCase(), item.content, item.status, event.id);
    }
  }

  // Present the newest snapshot's ordering; todos dropped from the plan keep
  // their first-seen order after it.
  const all = order.map((key) => byKey.get(key)).filter((item): item is TodoOutlineItem => Boolean(item));
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
