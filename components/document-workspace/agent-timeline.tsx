import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";

import { lifecycleStepLabel, SUBMIT_STEP_LABEL } from "@/agent-core/lifecycle-messages";
import { cn, truncate } from "@/lib/utils";

import { MarkdownBody } from "./markdown";
import { normalizeTodoItem, todoStatusMark } from "./todo-outline";
import type { AiRunEventView } from "./types";
import { basename, formatRelativeTime } from "./utils";

export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown> | null;
  body: string;
};

export function parseToolMessage(message: string): ParsedToolCall | null {
  const trimmed = message.trim();
  const usingMatch = trimmed.match(/^Using\s+([A-Za-z][A-Za-z0-9_]*)\.?$/);
  if (usingMatch) {
    return { name: usingMatch[1], args: null, body: "" };
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
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = null;
    }
  }
  return { name, args, body };
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
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const textParts = parsed
          .map((block) => {
            if (block && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string") {
              return (block as { text: string }).text;
            }
            return null;
          })
          .filter((part): part is string => Boolean(part));
        if (textParts.length > 0) {
          return textParts.join("\n");
        }
      }
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
export function parseToolResultData(toolName: string, message: string): ToolResultData | null {
  const trimmed = message.trim();
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

/** Custom expanded body for the builtin tools; null falls back to Input/Output JSON. */
function renderToolBody(
  parsed: ParsedToolCall | null,
  resultData: ToolResultData | null,
  resultText: string
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
    return (
      <>
        {filePath ? (
          <div className="agent-tool-desc"><code>{filePath}</code></div>
        ) : null}
        {resultData.base64 ? (
          <img
            alt={filePath ? basename(filePath) : "image read by the agent"}
            className="agent-tool-image"
            src={`data:${imageMediaTypeFromPath(filePath)};base64,${resultData.base64}`}
          />
        ) : (
          <div className="agent-tool-image-placeholder">
            <span aria-hidden>🖼</span> Image file — preview not stored in the timeline
          </div>
        )}
      </>
    );
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
    result,
    running
  }: {
    call: AiRunEventView;
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
    const customBody = renderToolBody(parsed, resultData, resultText);
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

    return (
      <details className={cn("agent-tool", !hasDetails && "agent-tool-empty")} data-agent-event-id={call.id}>
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
          {meta ? (
            <span className={cn("agent-tool-meta", !result && "agent-tool-meta-running")}>{meta}</span>
          ) : null}
        </summary>
        {hasDetails ? (
          <div className="agent-tool-body">
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

export type GroupedAgentEvent =
  | { kind: "message"; role: "user" | "agent" | "system" | "error"; event: AiRunEventView; key: string }
  | { kind: "step"; label: string; event: AiRunEventView; key: string }
  | { kind: "tool"; call: AiRunEventView; result: AiRunEventView | null; key: string };

export function groupAgentEvents(events: AiRunEventView[]): GroupedAgentEvent[] {
  const out: GroupedAgentEvent[] = [];
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
      // "Using Read." is a low-value progress signal — keep only when a richer
      // "Read: {...}" event isn't right next to it.
      if (isUsingProgressMessage(ev.message)) {
        const neighborHasDetails = [events[i - 1], events[i + 1]].some((neighbor) => {
          if (!neighbor || neighbor.role !== "tool") return false;
          if (isUsingProgressMessage(neighbor.message)) return false;
          return true;
        });
        if (neighborHasDetails) continue;
      }
      const next = events[i + 1];
      if (next && next.role === "tool_result") {
        out.push({ kind: "tool", call: ev, result: next, key: ev.id });
        i++;
      } else {
        out.push({ kind: "tool", call: ev, result: null, key: ev.id });
      }
      continue;
    }
    // Orphan tool_results (no preceding tool event) have no context — skip.
    if (ev.role === "tool_result") {
      continue;
    }
    if (!ev.message.trim()) continue;
    if (ev.role === "system") {
      const step = lifecycleStepLabel(ev.message);
      if (step) {
        out.push({ kind: "step", label: step, event: ev, key: ev.id });
        continue;
      }
    }
    const role: "user" | "agent" | "system" | "error" =
      ev.role === "user" || ev.role === "agent" || ev.role === "system" || ev.role === "error"
        ? ev.role
        : "agent";
    out.push({ kind: "message", role, event: ev, key: ev.id });
  }
  return out;
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

export function agentDisplayName(model: string | null | undefined): string {
  return model?.toLowerCase().startsWith("codex") ? "Codex" : "Claude";
}

export function AgentTimeline({
  agentName = "Claude",
  events,
  progress,
  status,
  intro,
  outro
}: {
  agentName?: string;
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
  const finalReplyIdx = useMemo(() => findFinalReplyIndex(grouped, isRunning), [grouped, isRunning]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
      {grouped.map((item, idx) => {
        if (item.kind === "tool") {
          return <AgentToolBlock call={item.call} key={item.key} result={item.result} running={isRunning} />;
        }
        if (item.kind === "step") {
          const active = isRunning && idx === grouped.length - 1;
          return (
            <div className={cn("agent-step", active && "agent-step-active")} key={item.key}>
              <span className="agent-step-icon" aria-hidden>
                {active ? "◌" : "✓"}
              </span>
              <span className="agent-step-label">{item.label}</span>
              <span className="agent-step-time">{formatRelativeTime(item.event.createdAt)}</span>
            </div>
          );
        }
        const { event, role } = item;
        const prev = idx > 0 ? grouped[idx - 1] : null;
        const isContinuation =
          prev?.kind === "message" && prev.role === role && (role === "user" || role === "agent");
        if (role === "user") {
          return (
            <div
              className={cn("agent-bubble agent-bubble-user", isContinuation && "agent-bubble-continuation")}
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
          const isFinalReply = idx === finalReplyIdx;
          return (
            <div
              className={cn(
                "agent-bubble agent-bubble-agent",
                isContinuation && !isFinalReply && "agent-bubble-continuation",
                isFinalReply && "agent-bubble-reply"
              )}
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
        if (role === "error") {
          return (
            <div className="agent-note agent-note-error" key={item.key}>
              <strong>Error</strong>
              <span>{event.message}</span>
            </div>
          );
        }
        return (
          <div className="agent-note" key={item.key}>
            {event.message}
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
    </div>
  );
}
