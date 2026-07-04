import { NodeSelection } from "@tiptap/pm/state";
import type { useEditor } from "@tiptap/react";

import { getDocumentMarkdown } from "@/lib/content";
import { formatDateTime } from "@/lib/utils";

import type { ActiveAiRunView, ThreadView } from "./types";

export function getSelectionContext(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function getAiRunProgressLabel(activeAiRun: ActiveAiRunView | null) {
  if (!activeAiRun) {
    return "Starting";
  }

  const progress = activeAiRun.progress?.trim() || activeAiRun.instruction;
  const toolMatch = progress.match(/^Using\s+(.+?)\.?$/i);
  if (toolMatch?.[1]) {
    return `Using ${toolMatch[1]}`;
  }

  return progress.replace(/\.$/, "");
}

export function parseAiRunSelectionId(triggerId: string | null | undefined) {
  if (!triggerId) return null;
  const parts = triggerId.split(":");
  if (parts[0] !== "selection") return null;
  // selection:{id}
  if (parts.length === 2 && parts[1]) return parts[1];
  // legacy forms: selection:{from}:{to} or selection:{id}:{from}:{to}
  if (parts.length === 4 && parts[1]) return parts[1];
  return null;
}

export function buildAiRunSelectionTriggerId(selectionId: string) {
  return `selection:${selectionId}`;
}

export function getSelectionContextFromEditor(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  from: number,
  to: number
) {
  const start = Math.max(0, from - 500);
  const end = Math.min(editor.state.doc.content.size, to + 500);
  // Split the ±500-char window into the text immediately BEFORE and AFTER the
  // selection, with explicit sentinels, so the agent can write a replacement that
  // reads continuously with its surroundings instead of guessing where the
  // selection sits inside an unlabeled blob.
  const before = editor.state.doc.textBetween(start, from, " ").replace(/\s+/g, " ").trim();
  const after = editor.state.doc.textBetween(to, end, " ").replace(/\s+/g, " ").trim();
  if (!before && !after) {
    return "";
  }
  return [
    "<text_before_selection>",
    before || "(start of document)",
    "</text_before_selection>",
    "<text_after_selection>",
    after || "(end of document)",
    "</text_after_selection>"
  ].join("\n");
}

export function getSelectionMarkdownFromEditor(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  from: number,
  to: number
): string {
  const slice = editor.state.doc.slice(from, to);
  const fragment = slice.content.toJSON();
  if (!Array.isArray(fragment) || fragment.length === 0) {
    return editor.state.doc.textBetween(from, to, " ").trim();
  }
  const markdown = getDocumentMarkdown({ type: "doc", content: fragment }).trim();
  if (markdown) {
    return markdown;
  }
  return editor.state.doc.textBetween(from, to, " ").trim();
}

function truncateForAnchor(value: string, max = 200) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function describeNodeSelection(node: { type?: { name?: string }; attrs?: Record<string, unknown> }) {
  if (node.type?.name === "image") {
    const altAttr = typeof node.attrs?.alt === "string" ? node.attrs.alt.trim() : "";
    const titleAttr = typeof node.attrs?.title === "string" ? node.attrs.title.trim() : "";
    const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
    const alt = altAttr || (titleAttr ? "" : "Image");
    const parts = [alt, titleAttr, src ? `Source: ${truncateForAnchor(src)}` : ""].filter(Boolean);
    return parts.join("\n");
  }

  if (node.type?.name === "repoImage") {
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "Repository image";
    const caption = typeof node.attrs?.caption === "string" ? node.attrs.caption : null;
    const path = typeof node.attrs?.path === "string" ? node.attrs.path : null;
    return [alt, caption, path ? `Repository path: ${truncateForAnchor(path)}` : null].filter(Boolean).join("\n");
  }

  if (node.type?.name === "embeddedWidget") {
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : "Interactive widget";
    const embedSource = typeof node.attrs?.embedSource === "string" ? node.attrs.embedSource : null;
    const buildCmd = typeof node.attrs?.buildCmd === "string" ? node.attrs.buildCmd : null;
    return [
      `Interactive widget: ${label}`,
      embedSource ? `Embed source: ${truncateForAnchor(embedSource)}` : null,
      buildCmd ? `Build command: ${truncateForAnchor(buildCmd)}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export function isNodeSelection(value: unknown): value is NodeSelection {
  return value instanceof NodeSelection;
}

export function logClientEvent(input: {
  scope: string;
  level?: "info" | "warn" | "error";
  message: string;
  data?: unknown;
}) {
  void fetch("/api/client-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    keepalive: true
  }).catch(() => null);
}

export function getInitials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getImagePathFromSource(src: string) {
  const trimmed = src.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed, window.location.origin);
    const pathParam = url.searchParams.get("path");
    if (pathParam) {
      return pathParam;
    }
  } catch {
    // Fall back to treating the value as a repo-relative path.
  }

  return trimmed.replace(/^\.?\//, "");
}

export function isImageSource(src: string) {
  const withoutHash = src.split("#")[0]?.split("?")[0] ?? src;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(withoutHash);
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function formatRelativeTime(value: string | Date): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor(diff / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDateTime(date);
}

export function isThreadUnread(thread: ThreadView, currentUserId: string | null): boolean {
  if (!currentUserId) return false;
  const lastReadMs = thread.lastReadAt ? new Date(thread.lastReadAt).getTime() : 0;
  return thread.comments.some((comment) => {
    if (comment.author?.id === currentUserId) return false;
    const createdMs = new Date(comment.createdAt).getTime();
    return Number.isFinite(createdMs) && createdMs > lastReadMs;
  });
}

export function getThreadTags(thread: { tags: string[]; status: string }) {
  const tags = Array.isArray(thread.tags) ? thread.tags : [];
  if (thread.status === "RESOLVED" && !tags.some((tag) => tag.toLowerCase() === "resolved")) {
    return ["Resolved", ...tags];
  }
  return tags;
}
