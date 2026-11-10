import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { lifecycleStepLabel } from "@/agent-core/lifecycle-messages";
import { cn, truncate } from "@/lib/utils";

import { MarkdownBody } from "./markdown";
import {
  extractJsonStringField,
  findFinalReplyIndex,
  foldToolRuns,
  formatDuration,
  groupAgentEvents,
  parseToolMessage,
  summarizeToolRun,
  toolDisplayName,
  toolDuration,
  toolResultFailed,
  unwrapToolResultText,
  type ParsedToolCall,
  type ToolItem
} from "./timeline-model";
import { normalizeTodoItem, todoStatusMark } from "./todo-outline";
import type { AiRunEventView } from "./types";

// The pure half of this module lives in timeline-model.ts; re-exported so
// existing importers (and tests) keep their entry point.
export * from "./timeline-model";
import { basename, formatRelativeTime } from "./utils";

/** file edits extracted from Edit / MultiEdit / Write tool inputs, for diff rendering. */
export type ToolDiff = {
  filePath: string | null;
  edits: Array<{ oldText: string; newText: string }>;
};

export function extractToolDiff(parsed: ParsedToolCall): ToolDiff | null {
  const args = parsed.args;
  if (!args) return null;
  const filePath = typeof args.file_path === "string" ? args.file_path : null;
  if (parsed.name === "Edit") {
    const oldText = typeof args.old_string === "string" ? args.old_string : null;
    const newText = typeof args.new_string === "string" ? args.new_string : null;
    if (oldText === null && newText === null) return null;
    return { filePath, edits: [{ oldText: oldText ?? "", newText: newText ?? "" }] };
  }
  if (parsed.name === "MultiEdit" && Array.isArray(args.edits)) {
    const edits = (args.edits as unknown[])
      .map((edit) => {
        if (!edit || typeof edit !== "object") return null;
        const e = edit as { old_string?: unknown; new_string?: unknown };
        const oldText = typeof e.old_string === "string" ? e.old_string : null;
        const newText = typeof e.new_string === "string" ? e.new_string : null;
        if (oldText === null && newText === null) return null;
        return { oldText: oldText ?? "", newText: newText ?? "" };
      })
      .filter((e): e is { oldText: string; newText: string } => Boolean(e));
    if (edits.length === 0) return null;
    return { filePath, edits };
  }
  if (parsed.name === "Write" && typeof args.content === "string") {
    return { filePath, edits: [{ oldText: "", newText: args.content }] };
  }
  return null;
}

/**
 * Known lifecycle plumbing emitted by agent-core as `system` events. These are
 * progress markers, not agent prose — render them as quiet step rows instead
 * of italic notes so they don't read like part of the conversation. The
 * producer strings and this recogniser live together in
 * agent-core/lifecycle-messages.ts; re-exported here so existing importers
 * (and tests) keep their entry point.
 */
export { lifecycleStepLabel };

/**
 * Interim Slack activity ("Posted to Slack: hi", "Shared plot.png to Slack")
 * — turn into a tool-style presentation instead of a raw text row.
 */
function parseSlackActivity(message: string): { label: string; summary: string } | null {
  const t = message.trim();
  if (t.startsWith("Posted to Slack: ")) {
    return { label: "slack message", summary: t.slice("Posted to Slack: ".length) };
  }
  const shared = t.match(/^Shared (.+) to Slack$/);
  if (shared) {
    return { label: "slack file", summary: shared[1] };
  }
  return null;
}

function readLineRange(args: Record<string, unknown>): string | null {
  const offset = typeof args.offset === "number" ? args.offset : null;
  const limit = typeof args.limit === "number" ? args.limit : null;
  if (offset !== null && limit !== null) return `lines ${offset}–${offset + limit}`;
  if (offset !== null) return `from line ${offset}`;
  if (limit !== null) return `first ${limit} lines`;
  return null;
}

export function renderToolSummary(parsed: ParsedToolCall): ReactNode {
  const { name, args, body } = parsed;
  if (!args) {
    if (!body) {
      return <span className="agent-tool-arg agent-tool-arg-muted">working…</span>;
    }
    return <code className="agent-tool-arg">{truncate(body, 80)}</code>;
  }
  if (name === "Bash" && typeof args.command === "string") {
    return (
      <code className="agent-tool-arg" title={typeof args.description === "string" ? args.description : undefined}>
        <span className="agent-tool-prompt">$</span> {truncate(args.command, 90)}
      </code>
    );
  }
  if (typeof args.file_path === "string") {
    const range = name === "Read" ? readLineRange(args) : null;
    return (
      <code className="agent-tool-arg" title={args.file_path}>
        {basename(args.file_path)}
        {range ? <span className="agent-tool-arg-muted"> · {range}</span> : null}
      </code>
    );
  }
  if (typeof args.path === "string" && (name === "LS" || name === "Read")) {
    return (
      <code className="agent-tool-arg" title={args.path}>
        {basename(args.path)}
      </code>
    );
  }
  if (typeof args.pattern === "string") {
    const where = typeof args.path === "string" ? ` in ${basename(args.path)}` : "";
    return (
      <code className="agent-tool-arg">
        {truncate(`${args.pattern}${where}`, 80)}
      </code>
    );
  }
  if ((name === "WebSearch" || name === "web_search") && typeof args.query === "string") {
    return <code className="agent-tool-arg">{truncate(args.query, 80)}</code>;
  }
  if ((name === "WebFetch" || name === "web_fetch") && typeof args.url === "string") {
    return <code className="agent-tool-arg">{truncate(args.url, 80)}</code>;
  }
  if ((name === "Task" || name === "Agent") && typeof args.description === "string") {
    return <code className="agent-tool-arg">{truncate(args.description, 80)}</code>;
  }
  if (name === "TodoWrite" && Array.isArray(args.todos)) {
    const todos = (args.todos as unknown[]).map(normalizeTodoItem).filter(Boolean);
    const done = todos.filter((t) => t!.status === "completed").length;
    return (
      <span className="agent-tool-arg agent-tool-arg-muted">
        {done}/{todos.length} done
      </span>
    );
  }
  // The Task* tool family (TaskCreate / TaskUpdate / TaskList / TaskGet) is the
  // successor of TodoWrite; the plan rail folds these into the session outline.
  if (name === "TaskCreate" && typeof args.subject === "string") {
    return <code className="agent-tool-arg">{truncate(args.subject, 80)}</code>;
  }
  if ((name === "TaskUpdate" || name === "TaskGet") && typeof args.taskId === "string") {
    const status = typeof args.status === "string" ? args.status : null;
    return (
      <span className="agent-tool-arg agent-tool-arg-muted">
        #{args.taskId}
        {status ? ` → ${status}` : ""}
      </span>
    );
  }
  if (name === "TaskList") {
    return <span className="agent-tool-arg agent-tool-arg-muted">plan</span>;
  }
  if (typeof args.glob === "string") {
    return <code className="agent-tool-arg">{truncate(args.glob, 80)}</code>;
  }
  const firstKey = Object.keys(args)[0];
  if (firstKey) {
    const value = args[firstKey];
    if (typeof value === "string") {
      return <code className="agent-tool-arg">{truncate(value, 80)}</code>;
    }
  }
  return <code className="agent-tool-arg">{truncate(JSON.stringify(args), 80)}</code>;
}

export function formatToolResult(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const unwrapped = unwrapToolResultText(trimmed);
    if (unwrapped !== null) {
      return unwrapped;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
      return JSON.stringify(parsed, null, 2);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function describeToolResult(resultText: string): string {
  if (!resultText) {
    return "done";
  }
  const lines = resultText.split("\n").length;
  return lines === 1 ? truncate(resultText, 40) : `${lines} lines`;
}

export type ToolResultData =
  | { kind: "bash"; stdout: string; stderr: string; truncated: boolean }
  | { kind: "file"; filePath: string | null; content: string; startLine: number; truncated: boolean }
  | { kind: "editResult"; filePath: string | null; oldText: string; newText: string; truncated: boolean }
  | { kind: "write"; filePath: string | null; content: string; created: boolean; truncated: boolean }
  | { kind: "grep"; content: string; numMatches: number | null }
  // Read of an image file. `base64` is only set when the stored payload is
  // complete (small images) — screenshots overflow the event cap, leaving an
  // unusable base64 prefix, so the renderer shows a placeholder instead.
  | { kind: "image"; base64: string | null; truncated: boolean }
  | {
      kind: "taskOutput";
      status: string | null;
      description: string | null;
      output: string;
      exitCode: number | null;
      retrievalStatus: string | null;
      truncated: boolean;
    };

/**
 * Interpret a tool_result event for a known builtin tool. Payloads are the
 * SDK's tool_use_result JSON — complete when small, clipped mid-JSON when
 * large — so this parses strictly first and falls back to lenient
 * field extraction on truncated payloads.
 */
/**
 * Strip Read's `   12\tsource` line-number gutter from a content-block payload
 * so the file view can render its own numbers from the real start line.
 */
function stripReadLineNumbers(text: string): { content: string; startLine: number } {
  const lines = text.split("\n");
  const parsed = lines.map((line) => line.match(/^\s*(\d+)\t(.*)$/));
  const numbered = parsed.filter(Boolean).length;
  if (!numbered || numbered < lines.filter((line) => line.trim()).length) {
    return { content: text, startLine: 1 };
  }
  const first = parsed.find(Boolean);
  return {
    content: parsed.map((match, i) => (match ? match[2] : lines[i])).join("\n"),
    startLine: first ? Number(first[1]) : 1
  };
}

export function parseToolResultData(toolName: string, message: string): ToolResultData | null {
  const trimmed = message.trim();
  if (trimmed.startsWith("[")) {
    // Content-block form — plain text, not the structured tool_use_result.
    const text = unwrapToolResultText(trimmed);
    if (text === null) return null;
    let truncated = true;
    try {
      JSON.parse(trimmed);
      truncated = false;
    } catch {
      truncated = true;
    }
    if (toolName === "Bash") {
      return { kind: "bash", stdout: text, stderr: "", truncated };
    }
    if (toolName === "Read") {
      const { content, startLine } = stripReadLineNumbers(text);
      return { kind: "file", filePath: null, content, startLine, truncated };
    }
    if (toolName === "Grep" || toolName === "Glob") {
      return { kind: "grep", content: text, numMatches: null };
    }
    return null;
  }
  if (!trimmed.startsWith("{")) return null;
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    obj = null;
  }
  const truncated = obj === null;
  const str = (key: string): string | null => {
    if (obj) {
      const v = obj[key];
      return typeof v === "string" ? v : null;
    }
    return extractJsonStringField(trimmed, key);
  };

  if (toolName === "Bash") {
    const stdout = str("stdout");
    const stderr = str("stderr");
    if (stdout === null && stderr === null) return null;
    return { kind: "bash", stdout: stdout ?? "", stderr: stderr ?? "", truncated };
  }
  if (toolName === "Read") {
    // Image reads: {"type":"image","file":{"base64":"..."}}. The base64 of a
    // real screenshot always overflows the event cap, so a complete payload
    // (renderable inline) is the exception, not the rule.
    if ((obj ? obj.type === "image" : str("type") === "image")) {
      let base64: string | null = null;
      if (obj && obj.file && typeof obj.file === "object") {
        const file = obj.file as Record<string, unknown>;
        if (typeof file.base64 === "string") base64 = file.base64;
      }
      return { kind: "image", base64, truncated };
    }
    let content: string | null = null;
    let filePath: string | null = null;
    let startLine = 1;
    if (obj && obj.file && typeof obj.file === "object") {
      const file = obj.file as Record<string, unknown>;
      content = typeof file.content === "string" ? file.content : null;
      filePath = typeof file.filePath === "string" ? file.filePath : null;
      if (typeof file.startLine === "number") startLine = file.startLine;
    } else if (!obj) {
      content = extractJsonStringField(trimmed, "content");
      filePath = extractJsonStringField(trimmed, "filePath");
      const startMatch = trimmed.match(/"startLine"\s*:\s*(\d+)/);
      if (startMatch) startLine = Number(startMatch[1]);
    }
    if (content === null) return null;
    return { kind: "file", filePath, content, startLine, truncated };
  }
  if (toolName === "Edit" || toolName === "MultiEdit") {
    const oldText = str("oldString");
    const newText = str("newString");
    if (oldText === null && newText === null) return null;
    return {
      kind: "editResult",
      filePath: str("filePath"),
      oldText: oldText ?? "",
      newText: newText ?? "",
      truncated
    };
  }
  if (toolName === "Write") {
    const content = str("content");
    if (content === null) return null;
    const type = str("type");
    return { kind: "write", filePath: str("filePath"), content, created: type === "create", truncated };
  }
  if (toolName === "Grep" || toolName === "Glob") {
    const content = str("content");
    if (content === null) return null;
    const matchCount = trimmed.match(/"numMatches"\s*:\s*(\d+)/);
    return { kind: "grep", content, numMatches: matchCount ? Number(matchCount[1]) : null };
  }
  if (toolName === "TaskOutput") {
    // {"retrieval_status": "...", "task": {"task_id", "status", "description", "output", "exitCode"}}
    const task = obj && obj.task && typeof obj.task === "object" ? (obj.task as Record<string, unknown>) : null;
    const field = (key: string): string | null => {
      if (task) {
        const v = task[key];
        return typeof v === "string" ? v : null;
      }
      if (obj) return null;
      return extractJsonStringField(trimmed, key);
    };
    const output = field("output");
    const status = field("status");
    if (output === null && status === null) return null;
    const exitMatch = trimmed.match(/"exitCode"\s*:\s*(-?\d+)/);
    return {
      kind: "taskOutput",
      status,
      description: field("description"),
      output: output ?? "",
      exitCode: exitMatch ? Number(exitMatch[1]) : null,
      retrievalStatus: obj
        ? typeof obj.retrieval_status === "string"
          ? obj.retrieval_status
          : null
        : extractJsonStringField(trimmed, "retrieval_status"),
      truncated
    };
  }
  return null;
}

function describeToolResultData(data: ToolResultData): string {
  if (data.kind === "bash") {
    const out = data.stdout || data.stderr;
    if (!out.trim()) return "done";
    const lines = out.trimEnd().split("\n");
    return lines.length === 1 ? truncate(lines[0], 40) : `${lines.length} lines`;
  }
  if (data.kind === "file") return `${data.content.split("\n").length} lines`;
  if (data.kind === "editResult") return "applied";
  if (data.kind === "write") return `${data.content.split("\n").length} lines written`;
  if (data.kind === "image") return "image";
  if (data.kind === "taskOutput") {
    if (data.retrievalStatus === "timeout") return "still running";
    if (data.status === "completed") {
      return data.exitCode !== null && data.exitCode !== 0 ? `exit ${data.exitCode}` : "completed";
    }
    return data.status ?? "done";
  }
  if (data.numMatches !== null) return `${data.numMatches} matches`;
  return `${data.content.split("\n").length} results`;
}

function DiffBlock({ diff }: { diff: ToolDiff }) {
  return (
    <div className="agent-diff">
      {diff.edits.map((edit, editIdx) => (
        <div className="agent-diff-hunk" key={editIdx}>
          {edit.oldText
            ? edit.oldText.split("\n").map((line, i) => (
                <div className="agent-diff-line agent-diff-del" key={`o${i}`}>
                  <span className="agent-diff-sign">-</span>
                  {line || " "}
                </div>
              ))
            : null}
          {edit.newText
            ? edit.newText.split("\n").map((line, i) => (
                <div className="agent-diff-line agent-diff-add" key={`n${i}`}>
                  <span className="agent-diff-sign">+</span>
                  {line || " "}
                </div>
              ))
            : null}
        </div>
      ))}
    </div>
  );
}

function TodoBody({ todos }: { todos: unknown[] }) {
  const items = todos.map(normalizeTodoItem).filter((item) => Boolean(item));
  return (
    <ul className="agent-todo-list">
      {items.map((item, i) => (
        <li className={cn("agent-todo-item", `agent-todo-${item!.status}`)} key={i}>
          <span className="agent-todo-mark" aria-hidden>
            {todoStatusMark(item!.status)}
          </span>
          {item!.content}
        </li>
      ))}
    </ul>
  );
}

/** Line-numbered read-only file viewer (Read / Write payloads). */
function FileView({
  content,
  startLine,
  tone
}: {
  content: string;
  startLine: number;
  tone?: "add";
}) {
  const lines = content.split("\n");
  return (
    <div className={cn("agent-file-view", tone === "add" && "agent-file-view-add")}>
      {lines.map((line, i) => (
        <div className="agent-file-line" key={i}>
          <span className="agent-file-num">{startLine + i}</span>
          <span className="agent-file-text">{line || " "}</span>
        </div>
      ))}
    </div>
  );
}

function TruncationNote({ truncated }: { truncated: boolean }) {
  if (!truncated) return null;
  return <div className="agent-tool-truncated">output clipped for the timeline</div>;
}

/** MCP tools whose payload is a human-readable message (show it, not the ack). */
export function slackMessageField(name: string): "text" | null {
  return name.endsWith("post_slack_message") ? "text" : null;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml"
};

function imageMediaTypeFromPath(filePath: string | null): string {
  const ext = filePath?.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() ?? "";
  return IMAGE_MEDIA_TYPES[ext] ?? "image/png";
}

/**
 * Map a path the agent read to a path the workspace file route can serve.
 * Runs see the workspace mounted at /workspace, so strip that prefix; any other
 * absolute path is outside the workspace and cannot be served.
 */
export function workspaceRelativePath(filePath: string | null): string | null {
  if (!filePath) return null;
  if (filePath.startsWith("/workspace/")) return filePath.slice("/workspace/".length);
  if (filePath.startsWith("/")) return null;
  return filePath;
}

/**
 * Image reads: the base64 payload almost always overflows the event cap, so
 * prefer serving the file itself out of the run workspace and fall back to the
 * placeholder only when neither source works.
 */
function ReadImageView({
  base64,
  documentId,
  filePath
}: {
  base64: string | null;
  documentId?: string;
  filePath: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const relative = workspaceRelativePath(filePath);
  const src = base64
    ? `data:${imageMediaTypeFromPath(filePath)};base64,${base64}`
    : documentId && relative
      ? `/api/documents/${documentId}/repo-files?path=${encodeURIComponent(relative)}`
      : null;
  return (
    <>
      {filePath ? (
        <div className="agent-tool-desc">
          <code>{filePath}</code>
        </div>
      ) : null}
      {src && !failed ? (
        <img
          alt={filePath ? basename(filePath) : "image read by the agent"}
          className="agent-tool-image"
          onError={() => setFailed(true)}
          src={src}
        />
      ) : (
        <div className="agent-tool-image-placeholder">
          <span aria-hidden>🖼</span> Image file — preview not stored in the timeline
        </div>
      )}
    </>
  );
}

/** Custom expanded body for the builtin tools; null falls back to Input/Output JSON. */
function renderToolBody(
  parsed: ParsedToolCall | null,
  resultData: ToolResultData | null,
  resultText: string,
  documentId?: string
): ReactNode | null {
  if (!parsed?.args) return null;
  const args = parsed.args;
  const messageField = slackMessageField(parsed.name);
  if (messageField && typeof args[messageField] === "string") {
    // The interesting content is the MESSAGE the agent sent, not the tool's
    // "Posted." acknowledgement.
    return <MarkdownBody body={String(args[messageField])} className="agent-tool-message markdown-body" />;
  }
  if (parsed.name === "Bash" && typeof args.command === "string") {
    const bash = resultData?.kind === "bash" ? resultData : null;
    return (
      <>
        {typeof args.description === "string" && args.description ? (
          <div className="agent-tool-desc">{args.description}</div>
        ) : null}
        <pre className="agent-tool-pre agent-tool-pre-terminal">
          <span className="agent-term-prompt">$ </span>
          {args.command}
          {bash && (bash.stdout || bash.stderr) ? "\n" : null}
          {bash?.stdout ? bash.stdout.trimEnd() : null}
          {bash?.stderr ? <span className="agent-term-stderr">{`\n${bash.stderr.trimEnd()}`}</span> : null}
        </pre>
        {bash ? (
          <TruncationNote truncated={bash.truncated} />
        ) : resultText ? (
          <>
            <div className="agent-tool-label">Output</div>
            <pre className="agent-tool-pre">{resultText}</pre>
          </>
        ) : null}
      </>
    );
  }
  if (parsed.name === "Read" && resultData?.kind === "image") {
    const filePath = typeof args.file_path === "string" ? args.file_path : null;
    return <ReadImageView base64={resultData.base64} documentId={documentId} filePath={filePath} />;
  }
  if (parsed.name === "Read" && resultData?.kind === "file") {
    // A clipped payload loses its startLine field (it serializes after the
    // content) — recover the position from the Read call's offset argument.
    const startLine =
      resultData.truncated && resultData.startLine === 1 && typeof args.offset === "number"
        ? Math.max(1, args.offset)
        : resultData.startLine;
    return (
      <>
        {resultData.filePath ? (
          <div className="agent-tool-desc"><code>{resultData.filePath}</code></div>
        ) : null}
        <FileView content={resultData.content} startLine={startLine} />
        <TruncationNote truncated={resultData.truncated} />
      </>
    );
  }
  if (parsed.name === "Write") {
    const write = resultData?.kind === "write" ? resultData : null;
    const content = write?.content ?? (typeof args.content === "string" ? args.content : null);
    if (content !== null) {
      return (
        <>
          {typeof args.file_path === "string" ? (
            <div className="agent-tool-desc"><code>{args.file_path}</code></div>
          ) : null}
          <FileView content={content} startLine={1} tone="add" />
          <TruncationNote truncated={write?.truncated ?? false} />
        </>
      );
    }
  }
  if (parsed.name === "Edit" || parsed.name === "MultiEdit") {
    // Prefer the RESULT payload: it exists for historical runs and, when the
    // JSON parses cleanly, it is the complete edit (input summaries are
    // clipped). Fall back to the input diff while the result is pending.
    const fromResult = resultData?.kind === "editResult" ? resultData : null;
    const diff: ToolDiff | null = fromResult
      ? { filePath: fromResult.filePath, edits: [{ oldText: fromResult.oldText, newText: fromResult.newText }] }
      : extractToolDiff(parsed);
    if (diff) {
      return (
        <>
          {diff.filePath ?? (typeof args.file_path === "string" ? args.file_path : null) ? (
            <div className="agent-tool-desc">
              <code>{diff.filePath ?? String(args.file_path)}</code>
            </div>
          ) : null}
          <DiffBlock diff={diff} />
          <TruncationNote truncated={fromResult?.truncated ?? false} />
        </>
      );
    }
  }
  if (parsed.name === "TaskOutput" && resultData?.kind === "taskOutput") {
    const statusLine = [
      resultData.description,
      resultData.status ? `status: ${resultData.status}` : null,
      resultData.exitCode !== null ? `exit ${resultData.exitCode}` : null
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <>
        {statusLine ? <div className="agent-tool-desc">{statusLine}</div> : null}
        {resultData.output.trim() ? (
          <pre className="agent-tool-pre agent-tool-pre-terminal">{resultData.output.trimEnd()}</pre>
        ) : (
          <div className="agent-tool-desc">No output yet.</div>
        )}
        <TruncationNote truncated={resultData.truncated} />
      </>
    );
  }
  if ((parsed.name === "Grep" || parsed.name === "Glob") && resultData?.kind === "grep") {
    return (
      <>
        <pre className="agent-tool-pre">{resultData.content}</pre>
      </>
    );
  }
  const inputDiff = extractToolDiff(parsed);
  if (inputDiff) {
    return (
      <>
        {inputDiff.filePath ? <div className="agent-tool-desc"><code>{inputDiff.filePath}</code></div> : null}
        <DiffBlock diff={inputDiff} />
        {resultText ? (
          <>
            <div className="agent-tool-label">Output</div>
            <pre className="agent-tool-pre">{resultText}</pre>
          </>
        ) : null}
      </>
    );
  }
  if (parsed.name === "TodoWrite" && Array.isArray(args.todos)) {
    return <TodoBody todos={args.todos as unknown[]} />;
  }
  if (parsed.name === "TaskCreate" && typeof args.subject === "string") {
    return (
      <>
        <div className="agent-tool-desc">{args.subject}</div>
        {typeof args.description === "string" && args.description ? (
          <pre className="agent-tool-pre">{args.description}</pre>
        ) : null}
      </>
    );
  }
  return null;
}

// One collapsed row per tool call, codex-style: the summary line carries the
// tool name, its key argument and a size hint of the output; expanding reveals
// the full input/output. Always a <details> element — a result arriving later
// must not change the element type, or React remounts the block and throws
// away its open state (and any text selection inside it). Memoized so poll
// re-renders leave settled blocks' DOM completely untouched.
const AgentToolBlock = memo(
  function AgentToolBlock({
    call,
    documentId,
    result,
    running
  }: {
    call: AiRunEventView;
    documentId?: string;
    result: AiRunEventView | null;
    running: boolean;
  }) {
    const parsed = parseToolMessage(call.message);
    const slack = !parsed ? parseSlackActivity(call.message) : null;
    const name = parsed ? toolDisplayName(parsed.name) : slack ? slack.label : "tool";
    const summary = parsed ? (
      renderToolSummary(parsed)
    ) : slack ? (
      <code className="agent-tool-arg">{truncate(slack.summary, 120)}</code>
    ) : (
      <code className="agent-tool-arg">{truncate(call.message, 120)}</code>
    );
    const resultData = result && parsed ? parseToolResultData(parsed.name, result.message) : null;
    const resultText = result && !resultData ? formatToolResult(result.message) : "";
    const customBody = renderToolBody(parsed, resultData, resultText, documentId);
    const argsPretty = parsed?.args ? JSON.stringify(parsed.args, null, 2) : null;
    const hasDetails = Boolean(customBody || argsPretty || resultText);
    const meta = result
      ? resultData
        ? describeToolResultData(resultData)
        : parsed && slackMessageField(parsed.name)
          ? // The "Posted." ack is tool plumbing; the body shows the message.
            "posted"
          : describeToolResult(resultText)
      : running
        ? "running…"
        : null;

    const failed = toolResultFailed(result);
    const duration = toolDuration(call, result);

    return (
      <details
        className={cn("agent-tool", !hasDetails && "agent-tool-empty", failed && "agent-tool-failed")}
        data-agent-event-id={call.id}
      >
        <summary
          className="agent-tool-header"
          onClick={(event) => {
            if (!hasDetails) {
              event.preventDefault();
            }
          }}
        >
          <span className="agent-tool-caret" aria-hidden />
          <span className="agent-tool-name">{name}</span>
          <span className="agent-tool-summary">{summary}</span>
          {failed ? <span className="agent-tool-failed-chip">failed</span> : null}
          {meta ? (
            <span className={cn("agent-tool-meta", !result && "agent-tool-meta-running")}>{meta}</span>
          ) : null}
          {duration ? <span className="agent-tool-duration">{duration}</span> : null}
        </summary>
        {hasDetails ? (
          <div className="agent-tool-body">
            {parsed?.clipped ? (
              <div className="agent-tool-truncated">input clipped for the timeline: the beginning is shown</div>
            ) : null}
            {customBody ?? (
              <>
                {argsPretty ? (
                  <>
                    <div className="agent-tool-label">Input</div>
                    <pre className="agent-tool-pre">{argsPretty}</pre>
                  </>
                ) : null}
                {resultText ? (
                  <>
                    <div className="agent-tool-label">Output</div>
                    <pre className="agent-tool-pre">{resultText}</pre>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </details>
    );
  },
  (prev, next) =>
    prev.call.id === next.call.id &&
    prev.call.message === next.call.message &&
    (prev.result?.id ?? null) === (next.result?.id ?? null) &&
    (prev.result?.message ?? null) === (next.result?.message ?? null) &&
    prev.running === next.running
);

/**
 * A run of consecutive tool calls, folded: "Ran 16 tool calls" with what they
 * were, how many failed and how long they took. Collapsed by default — the
 * prose around it carries the story; the calls are one click away.
 */
function AgentToolRun({
  documentId,
  items,
  live,
  running
}: {
  documentId?: string;
  items: ToolItem[];
  /** The run is still growing (last item of a running conversation). */
  live: boolean;
  running: boolean;
}) {
  const summary = summarizeToolRun(items);
  const latest = live ? parseToolMessage(items[items.length - 1].call.message) : null;
  return (
    <details className={cn("agent-tool-run", summary.failed > 0 && "agent-tool-run-failed")}>
      <summary className="agent-tool-run-header">
        <span className="agent-tool-caret" aria-hidden />
        <span className="agent-tool-run-title">
          {live ? "Running" : "Ran"} {summary.count} tool calls
        </span>
        <span className="agent-tool-run-breakdown">
          {latest ? (
            <>
              <span className="agent-tool-run-now">now</span> {toolDisplayName(latest.name)} {renderToolSummary(latest)}
            </>
          ) : (
            summary.breakdown
          )}
        </span>
        {summary.failed > 0 ? <span className="agent-tool-failed-chip">{summary.failed} failed</span> : null}
        {summary.durationMs !== null && summary.durationMs >= 5000 ? (
          <span className="agent-tool-duration">{formatDuration(summary.durationMs)}</span>
        ) : null}
      </summary>
      <div className="agent-tool-run-body">
        {items.map((item) => (
          <AgentToolBlock call={item.call} documentId={documentId} key={item.key} result={item.result} running={running} />
        ))}
      </div>
    </details>
  );
}

export function agentDisplayName(model: string | null | undefined): string {
  return model?.toLowerCase().startsWith("codex") ? "Codex" : "Claude";
}

export function AgentTimeline({
  agentName = "Claude",
  documentId,
  events,
  progress,
  status,
  intro,
  outro
}: {
  agentName?: string;
  /** Enables serving image Reads out of the run workspace. */
  documentId?: string;
  events: AiRunEventView[];
  progress: string | null;
  status: string;
  /** Rendered inside the scroll area, above the events (trigger context card). */
  intro?: ReactNode;
  /** Rendered inside the scroll area, after the events (final-edit payload). */
  outro?: ReactNode;
}) {
  const grouped = useMemo(() => groupAgentEvents(events), [events]);
  const isRunning = status === "RUNNING";
  const finalReplyEventId = useMemo(() => {
    const idx = findFinalReplyIndex(grouped, isRunning);
    return idx >= 0 ? grouped[idx].key : null;
  }, [grouped, isRunning]);
  const items = useMemo(() => foldToolRuns(grouped), [grouped]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Scrolled away from the live end: offer a way back instead of yanking.
  const [awayFromEnd, setAwayFromEnd] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setAwayFromEnd(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Stick to the bottom only when the user is already there. Yanking the
    // scroll on every progress tick made it impossible to read or select
    // earlier output while a run streams.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 160) return;
    // Never move the pane out from under an in-progress text selection.
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.anchorNode && el.contains(selection.anchorNode)) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [grouped.length, isRunning, progress]);

  if (grouped.length === 0 && !isRunning && !intro && !outro) {
    return <div className="agent-timeline-empty">No events yet.</div>;
  }

  return (
    <div className="agent-timeline" ref={scrollRef}>
      {intro}
      {items.map((item, idx) => {
        if (item.kind === "toolRun") {
          return (
            <AgentToolRun
              documentId={documentId}
              items={item.items}
              key={item.key}
              live={isRunning && idx === items.length - 1}
              running={isRunning}
            />
          );
        }
        if (item.kind === "tool") {
          return <AgentToolBlock
              call={item.call}
              documentId={documentId}
              key={item.key}
              result={item.result}
              running={isRunning}
            />;
        }
        if (item.kind === "step") {
          const active = isRunning && idx === items.length - 1;
          return (
            <div
              className={cn("agent-step", active && "agent-step-active")}
              data-agent-event-id={item.event.id}
              key={item.key}
            >
              <span className="agent-step-icon" aria-hidden>
                {active ? "◌" : "✓"}
              </span>
              <span className="agent-step-label">{item.label}</span>
              <span className="agent-step-time">{formatRelativeTime(item.event.createdAt)}</span>
            </div>
          );
        }
        if (item.kind === "notes") {
          // System plumbing (worktree path, credential policy, retries): one
          // quiet line, the full text one click away.
          const [first, ...rest] = item.events;
          const expandable = rest.length > 0 || first.message.length > 110 || first.message.includes("\n");
          return (
            <details
              className={cn("agent-notes", !expandable && "agent-notes-plain")}
              data-agent-event-id={first.id}
              key={item.key}
            >
              <summary onClick={(event) => { if (!expandable) event.preventDefault(); }}>
                <span className="agent-tool-caret" aria-hidden />
                <span className="agent-notes-first">{truncate(first.message.split("\n")[0], 110)}</span>
                {rest.length > 0 ? <span className="agent-notes-more">+{rest.length} more</span> : null}
              </summary>
              {expandable ? (
                <div className="agent-notes-body">
                  {item.events.map((note) => (
                    <p key={note.id}>{note.message}</p>
                  ))}
                </div>
              ) : null}
            </details>
          );
        }
        const { event, role } = item;
        const prev = idx > 0 ? items[idx - 1] : null;
        const isContinuation =
          prev?.kind === "message" && prev.role === role && (role === "user" || role === "agent");
        if (role === "user") {
          return (
            <div
              className={cn("agent-bubble agent-bubble-user", isContinuation && "agent-bubble-continuation")}
              data-agent-event-id={event.id}
              key={item.key}
            >
              {!isContinuation ? (
                <div className="agent-bubble-meta">
                  <span>You</span>
                  <span>{formatRelativeTime(event.createdAt)}</span>
                </div>
              ) : null}
              <MarkdownBody body={event.message} className="agent-bubble-body markdown-body" />
            </div>
          );
        }
        if (role === "agent") {
          const isFinalReply = item.key === finalReplyEventId;
          return (
            <div
              className={cn(
                "agent-bubble agent-bubble-agent",
                isContinuation && !isFinalReply && "agent-bubble-continuation",
                isFinalReply && "agent-bubble-reply"
              )}
              data-agent-event-id={event.id}
              key={item.key}
            >
              {!isContinuation || isFinalReply ? (
                <div className="agent-bubble-meta">
                  <span>{agentName}</span>
                  {isFinalReply ? <span className="agent-reply-chip">reply</span> : null}
                  <span>{formatRelativeTime(event.createdAt)}</span>
                </div>
              ) : null}
              <MarkdownBody body={event.message} className="agent-bubble-body markdown-body" />
            </div>
          );
        }
        return (
          <div className="agent-note agent-note-error" data-agent-event-id={event.id} key={item.key}>
            <strong>Error</strong>
            <span>{event.message}</span>
          </div>
        );
      })}
      {isRunning ? (
        <div className="agent-thinking">
          <span className="agent-thinking-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span>{progress ?? "Working…"}</span>
        </div>
      ) : null}
      {outro}
      {awayFromEnd && isRunning ? (
        <button
          className="agent-jump-latest"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          type="button"
        >
          ↓ Latest
        </button>
      ) : null}
    </div>
  );
}
