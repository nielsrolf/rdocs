// Detection of live background work in an agent session.
//
// Used at the turn boundary (result frame) to decide whether ending the run
// would kill something the agent still cares about. Two independent,
// deliberately ADVISORY signals — neither keeps a session alive by itself;
// they only trigger the one-time question that asks the agent to decide via
// keep_alive_after_turn / check_back_later:
//
//  1. SDK stream tracking: Bash tool calls with `run_in_background: true` that
//     have not been observed to complete (via a <task-notification> for that
//     task, or a matching completion marker). Cheap, harness-level, works on
//     every backend — but it only sees what went through the Bash tool, not a
//     `nohup ... &` inside a foreground Bash call.
//
//  2. Container process scan: children of PID 1 that are not part of the
//     agent infrastructure (claude CLI / entrypoint). Sees everything that is
//     actually alive — but only meaningful when agent-core IS PID 1 of an
//     isolated container (the in-process/host backend would see unrelated
//     host processes, so the scan returns null there).

import { readdirSync, readFileSync } from "node:fs";

const CLIP_COMMAND_LENGTH = 120;

export type BackgroundTaskTracker = {
  /** Feed every SDK message (assistant/user/system) through this. */
  observe(message: unknown): void;
  /** Descriptions of background Bash tasks with no observed completion. */
  pending(): string[];
};

function clipCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > CLIP_COMMAND_LENGTH ? `${flat.slice(0, CLIP_COMMAND_LENGTH)}…` : flat;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const rec = block as Record<string, unknown>;
      if (typeof rec.text === "string") return rec.text;
      if (typeof rec.content === "string") return rec.content;
      return "";
    })
    .join("\n");
}

export function createBackgroundTaskTracker(): BackgroundTaskTracker {
  // toolUseId -> clipped command. A task leaves the map when we see evidence
  // it finished (completion notification naming its shell/task id, or the
  // agent killed it). We key on the tool_use id because that is the only
  // stable identifier both sides of the stream share.
  const pendingTasks = new Map<string, string>();
  // Background task ids (e.g. "bash_3") reported at launch, mapped back to the
  // tool_use id so a later <task-notification> can clear the right entry.
  const taskIdToToolUse = new Map<string, string>();

  const observe = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content ?? (msg as Record<string, unknown>).content;

    if (msg.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const rec = block as Record<string, unknown>;
        if (rec.type !== "tool_use" || rec.name !== "Bash") continue;
        const input = rec.input as Record<string, unknown> | undefined;
        if (!input || input.run_in_background !== true) continue;
        const id = typeof rec.id === "string" ? rec.id : null;
        const command = typeof input.command === "string" ? input.command : "(unknown command)";
        if (id) pendingTasks.set(id, clipCommand(command));
      }
      return;
    }

    if (msg.type === "user") {
      // Two shapes reach us here: tool_result blocks (the Bash launch result
      // carries the background task id) and plain-text task notifications.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const rec = block as Record<string, unknown>;
          if (rec.type === "tool_result" && typeof rec.tool_use_id === "string") {
            const text = textOfContent(rec.content);
            if (pendingTasks.has(rec.tool_use_id)) {
              // Launch result of a background Bash: remember its task/shell id.
              const idMatch = text.match(/(?:task|shell)[ _-]?id[^\w]{0,3}([\w-]+)/i) ?? text.match(/\b(bash_\d+)\b/i);
              if (idMatch) taskIdToToolUse.set(idMatch[1], rec.tool_use_id);
            }
          }
        }
      }
      const text = textOfContent(content);
      if (text.includes("<task-notification>") || /task .* (?:completed|finished|failed|exited|stopped)/i.test(text)) {
        for (const [taskId, toolUseId] of taskIdToToolUse) {
          if (text.includes(taskId)) {
            pendingTasks.delete(toolUseId);
            taskIdToToolUse.delete(taskId);
          }
        }
        // A notification we cannot attribute clears nothing — advisory signal,
        // better to over-report than to miss live work.
      }
    }
  };

  return {
    observe,
    pending() {
      return [...pendingTasks.values()].map((command) => `background Bash: ${command}`);
    }
  };
}

export type BackgroundProcess = { pid: number; command: string };

const INFRA_COMMAND_PATTERN = /\bclaude\b|agent-entrypoint|@anthropic|anthropic-ai|\bcodex\b|\bnode\b.*entrypoint/i;

/**
 * Scan the container process tree for live background work: processes whose
 * ancestry reaches PID 1 without passing through the agent infrastructure
 * (claude CLI / entrypoint node process). Returns null when not applicable —
 * we are not PID 1 (not the container entrypoint) or /proc is unavailable
 * (macOS in-process runs) — so callers can distinguish "no scan possible"
 * from "scanned, nothing running".
 */
export function scanContainerBackgroundProcesses(options?: {
  procRoot?: string;
  selfPid?: number;
  fs?: { readdirSync(path: string): string[]; readFileSync(path: string, encoding: string): string };
}): BackgroundProcess[] | null {
  const procRoot = options?.procRoot ?? "/proc";
  const selfPid = options?.selfPid ?? process.pid;
  if (selfPid !== 1) return null;
  const fsImpl = options?.fs ?? { readdirSync: (p: string) => readdirSync(p), readFileSync: (p: string, enc: string) => readFileSync(p, enc as BufferEncoding) };

  let entries: string[];
  try {
    entries = fsImpl.readdirSync(procRoot);
  } catch {
    return null;
  }

  type ProcInfo = { pid: number; ppid: number; command: string };
  const procs = new Map<number, ProcInfo>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    try {
      const stat = fsImpl.readFileSync(`${procRoot}/${entry}/stat`, "utf8");
      // Field layout: pid (comm) state ppid ... — comm may contain spaces and
      // parentheses, so split after the LAST ")".
      const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ppid = Number(afterComm[1]);
      if (!Number.isFinite(ppid)) continue;
      let command = "";
      try {
        command = fsImpl.readFileSync(`${procRoot}/${entry}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
      } catch {
        /* kernel threads etc. */
      }
      if (!command) {
        const commMatch = stat.match(/\(([^)]*)\)/);
        command = commMatch ? `[${commMatch[1]}]` : "";
      }
      procs.set(pid, { pid, ppid, command });
    } catch {
      /* process exited mid-scan */
    }
  }

  // Partition the direct children of PID 1 into infra roots vs background
  // roots; a process belongs to the infra tree if any ancestor on the path to
  // PID 1 matches the infra pattern.
  const isInfraTree = new Map<number, boolean>();
  const infraOf = (pid: number): boolean => {
    const cached = isInfraTree.get(pid);
    if (cached != null) return cached;
    const proc = procs.get(pid);
    if (!proc) return false;
    isInfraTree.set(pid, false); // cycle guard
    const own = INFRA_COMMAND_PATTERN.test(proc.command);
    const result = own || (proc.ppid !== selfPid && proc.ppid !== 0 && infraOf(proc.ppid));
    isInfraTree.set(pid, result);
    return result;
  };

  const background: BackgroundProcess[] = [];
  for (const proc of procs.values()) {
    if (!proc.command || proc.command.startsWith("[")) continue; // kernel threads
    if (infraOf(proc.pid)) continue;
    // Report only tree roots (children of PID 1) to keep the list short.
    if (proc.ppid !== selfPid) continue;
    background.push({ pid: proc.pid, command: clipCommand(proc.command) });
  }
  return background;
}

/** Merge both signals into one advisory description list. */
export function describeBackgroundWork(
  tracker: BackgroundTaskTracker | null,
  processes: BackgroundProcess[] | null
): string[] {
  const out: string[] = [];
  if (tracker) out.push(...tracker.pending());
  if (processes) {
    for (const proc of processes) out.push(`process ${proc.pid}: ${proc.command}`);
  }
  return out;
}
