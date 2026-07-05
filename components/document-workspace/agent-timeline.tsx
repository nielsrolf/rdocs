import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { cn, truncate } from "@/lib/utils";

import { MarkdownBody } from "./markdown";
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

export function renderToolSummary(parsed: ParsedToolCall): ReactNode {
  const { name, args, body } = parsed;
  if (!args) {
    if (!body) {
      return <span className="agent-tool-arg agent-tool-arg-muted">working…</span>;
    }
    return <code className="agent-tool-arg">{truncate(body, 80)}</code>;
  }
  if (name === "Bash" && typeof args.command === "string") {
    return <code className="agent-tool-arg">{truncate(args.command, 90)}</code>;
  }
  if (typeof args.file_path === "string") {
    return (
      <code className="agent-tool-arg" title={args.file_path}>
        {basename(args.file_path)}
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

function AgentToolBlock({ call, result }: { call: AiRunEventView; result: AiRunEventView | null }) {
  const parsed = parseToolMessage(call.message);
  const name = parsed?.name ?? "tool";
  const summary = parsed ? renderToolSummary(parsed) : (
    <code className="agent-tool-arg">{truncate(call.message, 120)}</code>
  );
  const resultText = result ? formatToolResult(result.message) : "";
  const argsPretty = parsed?.args ? JSON.stringify(parsed.args, null, 2) : null;
  const hasDetails = Boolean(argsPretty || resultText);

  if (!hasDetails) {
    return (
      <div className="agent-tool">
        <div className="agent-tool-header agent-tool-header-static">
          <span className="agent-tool-name">{name}</span>
          <span className="agent-tool-summary">{summary}</span>
        </div>
      </div>
    );
  }

  return (
    <details className="agent-tool">
      <summary className="agent-tool-header">
        <span className="agent-tool-name">{name}</span>
        <span className="agent-tool-summary">{summary}</span>
        <span className="agent-tool-toggle" aria-hidden />
      </summary>
      <div className="agent-tool-body">
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
      </div>
    </details>
  );
}

type GroupedAgentEvent =
  | { kind: "message"; role: "user" | "agent" | "system" | "error"; event: AiRunEventView; key: string }
  | { kind: "tool"; call: AiRunEventView; result: AiRunEventView | null; key: string };

function groupAgentEvents(events: AiRunEventView[]): GroupedAgentEvent[] {
  const out: GroupedAgentEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
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
    const role: "user" | "agent" | "system" | "error" =
      ev.role === "user" || ev.role === "agent" || ev.role === "system" || ev.role === "error"
        ? ev.role
        : "agent";
    if (!ev.message.trim()) continue;
    out.push({ kind: "message", role, event: ev, key: ev.id });
  }
  return out;
}

export function AgentTimeline({
  events,
  progress,
  status
}: {
  events: AiRunEventView[];
  progress: string | null;
  status: string;
}) {
  const grouped = useMemo(() => groupAgentEvents(events), [events]);
  const isRunning = status === "RUNNING";
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

  if (grouped.length === 0 && !isRunning) {
    return <div className="agent-timeline-empty">No events yet.</div>;
  }

  return (
    <div className="agent-timeline" ref={scrollRef}>
      {grouped.map((item, idx) => {
        if (item.kind === "tool") {
          return <AgentToolBlock call={item.call} key={item.key} result={item.result} />;
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
          return (
            <div
              className={cn("agent-bubble agent-bubble-agent", isContinuation && "agent-bubble-continuation")}
              key={item.key}
            >
              {!isContinuation ? (
                <div className="agent-bubble-meta">
                  <span>Claude</span>
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
    </div>
  );
}
