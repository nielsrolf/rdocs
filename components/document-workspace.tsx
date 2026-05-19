"use client";

import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import { Fragment } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, JSONContent, NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";

import { PermissionLevelValue, ThreadStatusValue, permissionLevels } from "@/lib/contracts";
import { getSourceLabel } from "@/lib/sources";
import { cn, formatDateTime, permissionLabel, truncate } from "@/lib/utils";

type CommentView = {
  id: string;
  body: string;
  aiModel: string | null;
  sourceLinks: string[];
  commitSha: string | null;
  commitUrl: string | null;
  aiRunId: string | null;
  createdAt: string | Date;
  author: {
    id: string;
    name: string;
  } | null;
};

type ThreadView = {
  id: string;
  anchorText: string;
  anchorContext: string | null;
  fromPos: number | null;
  toPos: number | null;
  status: ThreadStatusValue;
  tags: string[];
  createdAt: string | Date;
  createdBy: {
    id: string;
    name: string;
  };
  comments: CommentView[];
};

type ShareLinkView = {
  id: string;
  token: string;
  permission: PermissionLevelValue;
  createdAt: string | Date;
};

type MemberView = {
  id: string;
  permission: PermissionLevelValue;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

type DocumentWorkspaceProps = {
  currentUserId: string | null;
  currentUserName: string;
  documentId: string;
  initialTitle: string;
  initialContent: unknown;
  initialDocumentUpdatedAt: string;
  initialPermission: PermissionLevelValue;
  initialMembers: MemberView[];
  initialThreads: ThreadView[];
  initialShareLinks: ShareLinkView[];
  initialRepoUrl: string | null;
  initialRepoBranch: string | null;
  isAuthenticated: boolean;
  isOwner: boolean;
  shareToken: string | null;
  viaShareLink: boolean;
};

type VersionView = {
  id: string;
  title: string;
  plainText: string;
  sourceLinks: string[];
  commitSha: string | null;
  commitUrl: string | null;
  createdAt: string | Date;
};

type AiEditImage = {
  path?: string;
  src: string;
  alt: string;
  caption: string | null;
};

type AiEditWidget = {
  id: string;
  label: string;
  buildCmd: string;
  embedSource: string;
  src: string;
};

type ActiveAiRunView = {
  id: string;
  triggerType: string;
  triggerId?: string | null;
  parentRunId?: string | null;
  instruction: string;
  status: string;
  progress: string | null;
  model?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  error?: string | null;
  startedAt: string | Date;
  finishedAt?: string | Date | null;
  events?: AiRunEventView[];
};

type AiRunEventView = {
  id: string;
  role: string;
  message: string;
  createdAt: string | Date;
};

type AgentToast = {
  id: string;
  title: string;
  body: string;
};

type ActiveAiTarget =
  | {
      type: "selection-edit";
      top: number;
      left: number;
      width: number;
      height: number;
    }
  | {
      type: "comment-thread";
      threadId: string;
    };

type SelectionState = {
  text: string;
  from: number;
  to: number;
  context: string;
  bubbleTop: number;
  bubbleLeft: number;
};

type SelectionPopoverMode = "menu" | "comment" | "edit";
type CommentTagFilterValue = "yes" | "no" | "all";

type HighlightThread = {
  id: string;
  fromPos: number | null;
  toPos: number | null;
};

type CommentAnchorRange = {
  threadId: string;
  fromPos: number;
  toPos: number;
};

type ToolbarButtonProps = {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
};

function getSelectionContext(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function getAiRunProgressLabel(activeAiRun: ActiveAiRunView | null) {
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

function parseAiRunSelectionRange(triggerId: string | null | undefined) {
  const match = triggerId?.match(/^selection:(\d+):(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    from: Number(match[1]),
    to: Number(match[2])
  };
}

function ClaudeWorkingInline({
  activeAiRun,
  compact = false
}: {
  activeAiRun: ActiveAiRunView | null;
  compact?: boolean;
}) {
  const progressLabel = getAiRunProgressLabel(activeAiRun);

  return (
    <div
      aria-label={`Claude is working. ${progressLabel}`}
      className={`claude-working-inline ${compact ? "claude-working-inline-compact" : ""}`}
      role="status"
    >
      <div className="claude-working-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <img alt="" className="claude-working-icon" src="/claude/investigating_no_outline.png" />
      <span className="claude-working-tool">{progressLabel}</span>
    </div>
  );
}

function getSelectionContextFromEditor(editor: NonNullable<ReturnType<typeof useEditor>>, from: number, to: number) {
  const start = Math.max(0, from - 500);
  const end = Math.min(editor.state.doc.content.size, to + 500);
  return editor.state.doc.textBetween(start, end, " ").replace(/\s+/g, " ").trim();
}

function describeNodeSelection(node: { type?: { name?: string }; attrs?: Record<string, unknown> }) {
  if (node.type?.name === "image") {
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "Image";
    const title = typeof node.attrs?.title === "string" ? node.attrs.title : null;
    const src = typeof node.attrs?.src === "string" ? node.attrs.src : null;
    return [alt, title, src ? `Source: ${src}` : null].filter(Boolean).join("\n");
  }

  if (node.type?.name === "repoImage") {
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "Repository image";
    const caption = typeof node.attrs?.caption === "string" ? node.attrs.caption : null;
    const path = typeof node.attrs?.path === "string" ? node.attrs.path : null;
    return [alt, caption, path ? `Repository path: ${path}` : null].filter(Boolean).join("\n");
  }

  if (node.type?.name === "embeddedWidget") {
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : "Interactive widget";
    const embedSource = typeof node.attrs?.embedSource === "string" ? node.attrs.embedSource : null;
    const buildCmd = typeof node.attrs?.buildCmd === "string" ? node.attrs.buildCmd : null;
    return [
      `Interactive widget: ${label}`,
      embedSource ? `Embed source: ${embedSource}` : null,
      buildCmd ? `Build command: ${buildCmd}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const CLAUDE_COMMENT_ICON_SRC = "/claude/happy_no_outline.png";

function CommentAvatar({ comment }: { comment: Pick<CommentView, "aiModel" | "author"> }) {
  const authorName = comment.author?.name ?? "Claude";

  if (comment.aiModel) {
    return <img alt="" className="avatar-dot avatar-dot-image" src={CLAUDE_COMMENT_ICON_SRC} />;
  }

  return <span className="avatar-dot">{getInitials(authorName)}</span>;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const aiEditMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});
const DEFAULT_COMMENT_TAGS = ["Resolved", "Footnote"];

function getThreadTags(thread: Pick<ThreadView, "tags" | "status">) {
  const tags = Array.isArray(thread.tags) ? thread.tags : [];
  if (thread.status === "RESOLVED" && !tags.some((tag) => tag.toLowerCase() === "resolved")) {
    return ["Resolved", ...tags];
  }
  return tags;
}

function buildAiEditHtml(replacementText: string, sourceLinks: string[]) {
  const trimmed = replacementText.trim();
  const renderedHtml = trimmed ? aiEditMarkdown.render(trimmed) : "<p></p>";

  if (sourceLinks.length > 0) {
    return `${renderedHtml}<p><strong>Sources:</strong> ${sourceLinks
        .map(
          (sourceLink, index) =>
            `<a href="${escapeHtml(sourceLink)}" target="_blank" rel="noopener noreferrer">[${index + 1}] ${escapeHtml(getSourceLabel(sourceLink))}</a>`
        )
        .join(", ")}</p>`;
  }

  return renderedHtml;
}

function getImagePathFromSource(src: string) {
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

function isImageSource(src: string) {
  const withoutHash = src.split("#")[0]?.split("?")[0] ?? src;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(withoutHash);
}

function toRepoImageNode(image: AiEditImage) {
  return `<figure data-repo-image src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" caption="${escapeHtml(
    image.caption ?? ""
  )}" path="${escapeHtml(image.path ?? image.src)}"></figure>`;
}

function toWidgetNode(widget: AiEditWidget, documentId: string, shareToken: string | null) {
  return `<div data-embedded-widget widgetId="${escapeHtml(widget.id)}" documentId="${escapeHtml(
    documentId
  )}" shareToken="${escapeHtml(shareToken ?? "")}" label="${escapeHtml(widget.label)}" buildCmd="${escapeHtml(
    widget.buildCmd
  )}" embedSource="${escapeHtml(widget.embedSource)}" src="${escapeHtml(widget.src)}" collapsed="true"></div>`;
}

function resolveMarkdownImage(input: {
  src: string;
  alt: string;
  imagesByPath: Map<string, AiEditImage>;
  documentId: string;
  shareToken: string | null;
}) {
  const path = getImagePathFromSource(input.src);
  const matchedImage = input.imagesByPath.get(path) ?? input.imagesByPath.get(input.src.trim());

  if (matchedImage) {
    return matchedImage;
  }

  const isAppRepoFile = input.src.includes(`/api/documents/${input.documentId}/repo-files`);
  if (!isImageSource(path) && !isAppRepoFile) {
    return null;
  }

  const isRemoteOrAppSource = /^(https?:|data:|blob:|\/api\/)/i.test(input.src.trim());
  const src = isRemoteOrAppSource
    ? input.src.trim()
    : `/api/documents/${input.documentId}/repo-files?path=${encodeURIComponent(path)}${
        input.shareToken ? `&share=${encodeURIComponent(input.shareToken)}` : ""
      }`;

  return {
    path,
    src,
    alt: input.alt || path.split("/").pop() || "Figure",
    caption: input.alt || null
  };
}

function buildAiEditInsertContent(input: {
  replacementText: string;
  sourceLinks: string[];
  images: AiEditImage[];
  widgets: AiEditWidget[];
  documentId: string;
  shareToken: string | null;
}) {
  const imagesByPath = new Map<string, AiEditImage>();
  input.images.forEach((image) => {
    if (image.path) {
      imagesByPath.set(getImagePathFromSource(image.path), image);
    }
    imagesByPath.set(getImagePathFromSource(image.src), image);
  });

  const usedImagePaths = new Set<string>();
  const content: string[] = [];
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?<!\!)\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = markdownImagePattern.exec(input.replacementText)) !== null) {
    const alt = match[1] ?? match[3] ?? "";
    const src = match[2] ?? match[4] ?? "";
    const image = resolveMarkdownImage({
      src,
      alt,
      imagesByPath,
      documentId: input.documentId,
      shareToken: input.shareToken
    });

    if (!image) {
      continue;
    }

    const before = input.replacementText.slice(cursor, match.index).trim();
    if (before) {
      content.push(buildAiEditHtml(before, []));
    }
    content.push(toRepoImageNode(image));
    usedImagePaths.add(getImagePathFromSource(image.path ?? image.src));
    cursor = match.index + match[0].length;
  }

  const after = input.replacementText.slice(cursor).trim();
  if (after) {
    content.push(buildAiEditHtml(after, input.sourceLinks));
  } else if (input.sourceLinks.length > 0) {
    content.push(buildAiEditHtml("", input.sourceLinks));
  }

  input.images
    .filter((image) => !usedImagePaths.has(getImagePathFromSource(image.path ?? image.src)))
    .forEach((image) => {
      content.push(toRepoImageNode(image));
    });

  input.widgets.forEach((widget) => {
    content.push(toWidgetNode(widget, input.documentId, input.shareToken));
  });

  return content.length > 0 ? content.join("\n") : "<p></p>";
}

function normalizeWidgetsOutsideTables(content: JSONContent) {
  let changed = false;

  function visit(node: JSONContent, insideTable: boolean): { nodes: JSONContent[]; hoisted: JSONContent[] } {
    if (insideTable && node.type === "embeddedWidget") {
      changed = true;
      return { nodes: [], hoisted: [{ ...node }] };
    }

    const nodeIsTable = node.type === "table";
    const nextContent: JSONContent[] = [];
    const hoisted: JSONContent[] = [];

    for (const child of node.content ?? []) {
      const visited = visit(child, insideTable || nodeIsTable);
      nextContent.push(...visited.nodes);
      hoisted.push(...visited.hoisted);
    }

    const nextNode =
      node.content && nextContent.length !== node.content.length
        ? {
            ...node,
            content:
              insideTable && (node.type === "tableCell" || node.type === "tableHeader") && nextContent.length === 0
                ? [{ type: "paragraph" }]
                : nextContent
          }
        : node.content
          ? {
              ...node,
              content:
                insideTable && (node.type === "tableCell" || node.type === "tableHeader") && nextContent.length === 0
                  ? [{ type: "paragraph" }]
                  : nextContent
            }
          : { ...node };

    if (nodeIsTable) {
      return { nodes: [nextNode, ...hoisted], hoisted: [] };
    }

    return insideTable ? { nodes: [nextNode], hoisted } : { nodes: [nextNode, ...hoisted], hoisted: [] };
  }

  const visited = visit(content, false);
  return {
    content: visited.nodes[0] ?? content,
    changed
  };
}

function ToolbarButton({ active = false, disabled = false, label, onClick }: ToolbarButtonProps) {
  return (
    <button
      className={`editor-toolbar-button ${active ? "editor-toolbar-button-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Image read failed."));
    };
    reader.onerror = () => reject(new Error("Image read failed."));
    reader.readAsDataURL(file);
  });
}

async function insertImagesAtPosition(
  view: NonNullable<NonNullable<ReturnType<typeof useEditor>>["view"]>,
  files: File[],
  dropCoordinates?: { left: number; top: number }
) {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    return false;
  }

  const imageType = view.state.schema.nodes.image;
  if (!imageType) {
    return false;
  }

  const paragraphType = view.state.schema.nodes.paragraph;
  const targetPosition =
    dropCoordinates != null ? view.posAtCoords(dropCoordinates)?.pos ?? view.state.selection.from : view.state.selection.from;

  const dataUrls = await Promise.all(imageFiles.map((file) => readFileAsDataUrl(file)));
  const nodes = dataUrls.flatMap((src, index) => {
    const imageNode = imageType.create({
      src,
      alt: imageFiles[index]?.name || "Pasted image"
    });

    return paragraphType ? [imageNode, paragraphType.create()] : [imageNode];
  });

  const transaction = view.state.tr.insert(targetPosition, Fragment.fromArray(nodes));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return true;
}

const CommentAnchor = Mark.create({
  name: "commentAnchor",
  inclusive: false,
  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment-thread-id"),
        renderHTML: (attributes) =>
          typeof attributes.threadId === "string" && attributes.threadId
            ? { "data-comment-thread-id": attributes.threadId }
            : {}
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-thread-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  }
});

function collectCommentAnchorRanges(doc: { descendants: (callback: (node: any, pos: number) => void) => void }) {
  const ranges = new Map<string, CommentAnchorRange>();

  doc.descendants((node, pos) => {
    if (!node.isText || !Array.isArray(node.marks)) {
      return;
    }

    node.marks.forEach((mark: { type?: { name?: string }; attrs?: { threadId?: unknown } }) => {
      if (mark.type?.name !== "commentAnchor" || typeof mark.attrs?.threadId !== "string") {
        return;
      }

      const threadId = mark.attrs.threadId;
      const fromPos = pos;
      const toPos = pos + node.nodeSize;
      const current = ranges.get(threadId);
      ranges.set(threadId, {
        threadId,
        fromPos: current ? Math.min(current.fromPos, fromPos) : fromPos,
        toPos: current ? Math.max(current.toPos, toPos) : toPos
      });
    });
  });

  return ranges;
}

function resolveCommentAnchorRange(
  doc: { descendants: (callback: (node: any, pos: number) => void) => void },
  thread: HighlightThread
) {
  return collectCommentAnchorRanges(doc).get(thread.id) ?? null;
}

function createCommentHighlightExtension(
  threadsRef: MutableRefObject<HighlightThread[]>,
  activeThreadIdRef: MutableRefObject<string | null>,
  onActivateThread: (threadId: string | null) => void
) {
  return Extension.create({
    name: "commentHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("commentHighlight"),
          props: {
            decorations(state) {
              const decorations = threadsRef.current.flatMap((thread) => {
                const range = resolveCommentAnchorRange(state.doc, thread);
                if (!range) {
                  return [];
                }

                const isActive = thread.id === activeThreadIdRef.current;
                return [
                  Decoration.inline(range.fromPos, range.toPos, {
                    class: isActive
                      ? "comment-anchor-highlight comment-anchor-highlight-active"
                      : "comment-anchor-highlight"
                  })
                ];
              });

              return DecorationSet.create(state.doc, decorations);
            },
            handleClick(view, pos) {
              const thread = threadsRef.current.find((candidate) => {
                const range = resolveCommentAnchorRange(view.state.doc, candidate);
                return range && pos >= range.fromPos && pos <= range.toPos;
              });

              onActivateThread(thread?.id ?? null);
              return false;
            }
          }
        })
      ];
    }
  });
}

type LatexMatch = {
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  latex: string;
  displayMode: boolean;
};

function findLatexMatches(text: string, basePosition: number) {
  const matches: LatexMatch[] = [];
  let index = 0;

  while (index < text.length) {
    const displayStart = text.indexOf("$$", index);
    const inlineStart = text.indexOf("$", index);
    if (displayStart === -1 && inlineStart === -1) {
      break;
    }

    const isDisplay = displayStart !== -1 && (inlineStart === -1 || displayStart <= inlineStart);
    const start = isDisplay ? displayStart : inlineStart;
    if (start > 0 && text[start - 1] === "\\") {
      index = start + 1;
      continue;
    }

    const delimiter = isDisplay ? "$$" : "$";
    const contentStart = start + delimiter.length;
    const end = text.indexOf(delimiter, contentStart);
    if (end === -1 || end === contentStart) {
      index = contentStart;
      continue;
    }

    const latex = text.slice(contentStart, end).trim();
    if (latex) {
      matches.push({
        from: basePosition + start,
        to: basePosition + end + delimiter.length,
        sourceFrom: basePosition + contentStart,
        sourceTo: basePosition + end,
        latex,
        displayMode: isDisplay
      });
    }

    index = end + delimiter.length;
  }

  return matches;
}

function createLatexRenderExtension() {
  return Extension.create({
    name: "latexRender",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("latexRender"),
          props: {
            handleDOMEvents: {
              mousedown(view, event) {
                const target = event.target;
                if (!(target instanceof Element)) {
                  return false;
                }

                const rendered = target.closest<HTMLElement>(".latex-render");
                if (!rendered?.dataset.sourceFrom || !rendered.dataset.sourceTo) {
                  return false;
                }

                const sourceFrom = Number(rendered.dataset.sourceFrom);
                const sourceTo = Number(rendered.dataset.sourceTo);
                if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) {
                  return false;
                }

                event.preventDefault();
                view.focus();
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, sourceFrom, sourceTo))
                    .scrollIntoView()
                );
                return true;
              }
            },
            decorations(state) {
              const decorations: Decoration[] = [];
              const { from: selectionFrom, to: selectionTo } = state.selection;

              state.doc.descendants((node, position) => {
                if (!node.isText || !node.text) {
                  return true;
                }

                findLatexMatches(node.text, position).forEach((match) => {
                  const isActive = selectionFrom <= match.to && selectionTo >= match.from;
                  decorations.push(
                    Decoration.inline(match.from, match.to, {
                      class: isActive ? "latex-source latex-source-active" : "latex-source latex-source-hidden"
                    })
                  );
                  if (!isActive) {
                    decorations.push(
                      Decoration.widget(
                        match.from,
                        () => {
                          const rendered = document.createElement(match.displayMode ? "div" : "span");
                          rendered.className = match.displayMode
                            ? "latex-render latex-render-display"
                            : "latex-render";
                          rendered.dataset.sourceFrom = String(match.sourceFrom);
                          rendered.dataset.sourceTo = String(match.sourceTo);
                          rendered.innerHTML = katex.renderToString(match.latex, {
                            displayMode: match.displayMode,
                            strict: "ignore",
                            throwOnError: false,
                            trust: false
                          });
                          rendered.title = match.displayMode ? `$$${match.latex}$$` : `$${match.latex}$`;
                          return rendered;
                        },
                        {
                          key: `latex:${match.from}:${match.to}:${match.displayMode ? "display" : "inline"}:${match.latex}`,
                          side: -1
                        }
                      )
                    );
                  }
                });

                return true;
              });

              return DecorationSet.create(state.doc, decorations);
            }
          }
        })
      ];
    }
  });
}

function EmbeddedWidgetView({ deleteNode, editor, node, selected, updateAttributes }: NodeViewProps) {
  const [refreshing, setRefreshing] = useState(false);
  const collapsed = node.attrs.collapsed !== false;
  const expanded = !collapsed;
  const [frameHeight, setFrameHeight] = useState(720);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const widgetId = node.attrs.widgetId as string;
  const documentId = node.attrs.documentId as string;
  const shareToken = (node.attrs.shareToken as string | null) || null;
  const label = (node.attrs.label as string) || "Interactive widget";
  const buildCmd = (node.attrs.buildCmd as string) || "";
  const embedSource = (node.attrs.embedSource as string) || "";
  const src =
    (node.attrs.src as string) ||
    `/api/documents/${documentId}/widgets/${widgetId}/source${shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""}`;

  useEffect(() => {
    window.requestAnimationFrame(resizeFrame);
  }, [expanded, src]);

  async function refreshWidget() {
    setRefreshing(true);
    setError(null);

    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    const response = await fetch(
      `/api/documents/${documentId}/widgets/${widgetId}/refresh${shareQuery}`,
      { method: "POST" }
    );
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      setError(data?.error ?? "Widget refresh failed.");
      setRefreshing(false);
      return;
    }

    const nextSrc = `${data.embedUrl || src}${data.embedUrl?.includes("?") ? "&" : "?"}t=${Date.now()}`;
    updateAttributes({
      src: nextSrc
    });
    setRefreshing(false);
  }

  function resizeFrame() {
    if (!expanded) {
      setFrameHeight(0);
      return;
    }

    const frame = iframeRef.current;
    const body = frame?.contentDocument?.body;
    const documentElement = frame?.contentDocument?.documentElement;
    const contentHeight = Math.max(
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      documentElement?.scrollHeight ?? 0,
      documentElement?.offsetHeight ?? 0,
      520
    );
    setFrameHeight(expanded ? Math.min(Math.max(contentHeight + 24, 720), 8000) : 520);
  }

  return (
    <NodeViewWrapper
      className={`embedded-widget-node ${expanded ? "embedded-widget-node-expanded" : ""} ${
        selected ? "embedded-widget-node-selected" : ""
      }`}
      contentEditable={false}
      draggable
    >
      <div className="embedded-widget-header">
        <div>
          <strong>{label}</strong>
          <span>{embedSource}</span>
        </div>
        <div className="embedded-widget-actions">
          <button
            className="ghost-button"
            onClick={() => {
              updateAttributes({ collapsed: expanded });
              window.requestAnimationFrame(resizeFrame);
            }}
            type="button"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
          <button className="ghost-button" disabled={refreshing || !editor.isEditable} onClick={refreshWidget} type="button">
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          {editor.isEditable ? (
            <button className="ghost-button danger-button" onClick={deleteNode} type="button">
              Remove
            </button>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <>
          <iframe
            className="embedded-widget-frame"
            onLoad={resizeFrame}
            ref={iframeRef}
            sandbox="allow-scripts allow-same-origin"
            src={src}
            scrolling="no"
            style={{ height: frameHeight }}
            title={label}
          />
          {error ? <div className="embedded-widget-error">{error}</div> : null}
          <details className="embedded-widget-details">
            <summary>Build command</summary>
            <code>{buildCmd}</code>
          </details>
        </>
      ) : (
        <div className="embedded-widget-collapsed">Widget collapsed</div>
      )}
    </NodeViewWrapper>
  );
}

function RepoImageView({ node }: NodeViewProps) {
  const rawSrc = (node.attrs.src as string) || "";
  const alt = (node.attrs.alt as string) || "Repository image";
  const caption = (node.attrs.caption as string | null) || null;
  let src = rawSrc;
  if (
    typeof window !== "undefined" &&
    rawSrc.startsWith("/api/documents/") &&
    rawSrc.includes("/repo-files")
  ) {
    const shareToken = new URLSearchParams(window.location.search).get("share");
    if (shareToken) {
      const url = new URL(rawSrc, window.location.origin);
      if (!url.searchParams.has("share")) {
        url.searchParams.set("share", shareToken);
      }
      src = `${url.pathname}?${url.searchParams.toString()}`;
    }
  }

  return (
    <NodeViewWrapper className="repo-image-node">
      <img alt={alt} src={src} title={caption ?? alt} />
      {caption ? <div className="repo-image-caption">{caption}</div> : null}
    </NodeViewWrapper>
  );
}

const RepoImage = Node.create({
  name: "repoImage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "Repository image" },
      caption: {
        default: null,
        parseHTML: (element) => element.getAttribute("caption") || null
      },
      path: {
        default: null,
        parseHTML: (element) => element.getAttribute("path") || null
      }
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-repo-image]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-repo-image": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(RepoImageView);
  }
});

const EmbeddedWidget = Node.create({
  name: "embeddedWidget",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      widgetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("widgetid") || element.getAttribute("widgetId")
      },
      documentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("documentid") || element.getAttribute("documentId")
      },
      shareToken: {
        default: null,
        parseHTML: (element) => element.getAttribute("sharetoken") || element.getAttribute("shareToken")
      },
      label: { default: "Interactive widget" },
      buildCmd: {
        default: "",
        parseHTML: (element) => element.getAttribute("buildcmd") || element.getAttribute("buildCmd") || ""
      },
      embedSource: {
        default: "",
        parseHTML: (element) => element.getAttribute("embedsource") || element.getAttribute("embedSource") || ""
      },
      src: { default: "" },
      collapsed: {
        default: true,
        parseHTML: (element) => element.getAttribute("collapsed") !== "false",
        renderHTML: (attributes) => ({
          collapsed: attributes.collapsed === false ? "false" : "true"
        })
      }
    };
  },
  parseHTML() {
    return [{ tag: "div[data-embedded-widget]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-embedded-widget": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbeddedWidgetView);
  }
});

type ParsedToolCall = {
  name: string;
  args: Record<string, unknown> | null;
  body: string;
};

function parseToolMessage(message: string): ParsedToolCall | null {
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

function isUsingProgressMessage(message: string): boolean {
  return /^Using\s+[A-Za-z][A-Za-z0-9_]*\.?\s*$/.test(message.trim());
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function renderToolSummary(parsed: ParsedToolCall) {
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

function formatToolResult(message: string): string {
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

function formatRelativeTime(value: string | Date): string {
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

type AgentConversation = {
  rootId: string;
  runs: ActiveAiRunView[];
  events: AiRunEventView[];
  latestRun: ActiveAiRunView;
  rootInstruction: string;
  startedAt: string | Date;
  lastActivityAt: string | Date;
  status: string;
  branchName: string | null;
  commitSha: string | null;
  commitUrl: string | null;
  progress: string | null;
};

function buildConversations(runs: ActiveAiRunView[]): AgentConversation[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const rootIdFor = (run: ActiveAiRunView): string => {
    let cursor: ActiveAiRunView = run;
    const seen = new Set<string>();
    while (cursor.parentRunId && byId.has(cursor.parentRunId) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentRunId)!;
    }
    return cursor.id;
  };
  const grouped = new Map<string, ActiveAiRunView[]>();
  for (const run of runs) {
    const rootId = rootIdFor(run);
    if (!grouped.has(rootId)) grouped.set(rootId, []);
    grouped.get(rootId)!.push(run);
  }
  const conversations: AgentConversation[] = [];
  for (const [rootId, list] of grouped) {
    const sorted = [...list].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );
    const events = sorted
      .flatMap((run) => run.events ?? [])
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const latest = sorted[sorted.length - 1];
    const root = sorted[0];
    conversations.push({
      rootId,
      runs: sorted,
      events,
      latestRun: latest,
      rootInstruction: root.instruction,
      startedAt: root.startedAt,
      lastActivityAt: latest.finishedAt ?? latest.startedAt,
      status: latest.status,
      branchName: latest.branchName ?? null,
      commitSha: latest.commitSha ?? null,
      commitUrl: latest.commitUrl ?? null,
      progress: latest.progress
    });
  }
  conversations.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );
  return conversations;
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

function AgentTimeline({
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
              <div className="agent-bubble-body">{event.message}</div>
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
              <div className="agent-bubble-body">{event.message}</div>
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

export function DocumentWorkspace({
  currentUserId,
  currentUserName,
  documentId,
  initialTitle,
  initialContent,
  initialDocumentUpdatedAt,
  initialPermission,
  initialMembers,
  initialThreads,
  initialShareLinks,
  initialRepoUrl,
  initialRepoBranch,
  isAuthenticated,
  isOwner,
  shareToken,
  viaShareLink
}: DocumentWorkspaceProps) {
  const [title, setTitle] = useState(initialTitle);
  const [members, setMembers] = useState<MemberView[]>(initialMembers);
  const [threads, setThreads] = useState<ThreadView[]>(initialThreads);
  const [shareLinks, setShareLinks] = useState<ShareLinkView[]>(initialShareLinks);
  const [repoUrl, setRepoUrl] = useState(initialRepoUrl ?? "");
  const [repoBranch, setRepoBranch] = useState(initialRepoBranch ?? "");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoNotice, setRepoNotice] = useState<string | null>(null);
  const [documentUpdatedAt, setDocumentUpdatedAt] = useState(initialDocumentUpdatedAt);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectionPopoverMode, setSelectionPopoverMode] = useState<SelectionPopoverMode | null>(null);
  const [composerBody, setComposerBody] = useState("");
  const [editInstruction, setEditInstruction] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreads[0]?.id ?? null);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [creatingLink, setCreatingLink] = useState<PermissionLevelValue | null>(null);
  const [aiBusyThreadId, setAiBusyThreadId] = useState<string | null>(null);
  const [replyBusyThreadId, setReplyBusyThreadId] = useState<string | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentTagFilters, setCommentTagFilters] = useState<Record<string, CommentTagFilterValue>>({
    resolved: "no"
  });
  const [activeAiRun, setActiveAiRun] = useState<ActiveAiRunView | null>(null);
  const [activeAiRuns, setActiveAiRuns] = useState<ActiveAiRunView[]>([]);
  const [aiRuns, setAiRuns] = useState<ActiveAiRunView[]>([]);
  const [activeAiTarget, setActiveAiTarget] = useState<ActiveAiTarget | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [composeMode, setComposeMode] = useState<"selected" | "new">("selected");
  const [agentMessage, setAgentMessage] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentToast, setAgentToast] = useState<AgentToast | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] = useState<PermissionLevelValue>("COMMENT");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [deleteBusyCommentId, setDeleteBusyCommentId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<VersionView[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  const [threadOffsets, setThreadOffsets] = useState<Record<string, number>>({});
  const [railHeight, setRailHeight] = useState(640);
  const saveTimerRef = useRef<number | null>(null);
  const isApplyingRemoteUpdateRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const pendingVersionSourcesRef = useRef<string[]>([]);
  const pendingCommitRef = useRef<{ commitSha: string | null; commitUrl: string | null; aiRunId: string | null }>({
    commitSha: null,
    commitUrl: null,
    aiRunId: null
  });
  const forceVersionRef = useRef(false);
  const titleRef = useRef(initialTitle);
  const documentUpdatedAtRef = useRef(initialDocumentUpdatedAt);
  const replyDraftsRef = useRef<Record<string, string>>({});
  const [replyDraftTick, setReplyDraftTick] = useState(0);
  const editorPageRef = useRef<HTMLDivElement | null>(null);
  const threadsRef = useRef<HighlightThread[]>(initialThreads);
  const activeThreadIdRef = useRef<string | null>(initialThreads[0]?.id ?? null);
  const previousAiRunsRef = useRef<Record<string, string>>({});
  const notifiedAgentRunsRef = useRef<Set<string>>(new Set());
  const canWriteComments = isAuthenticated && initialPermission !== "VIEW";
  const canWriteDocument = initialPermission === "EDIT";

  const commentHighlightExtension = useMemo(
    () =>
      createCommentHighlightExtension(threadsRef, activeThreadIdRef, (threadId) => {
        setActiveThreadId(threadId);
        setSelectionPopoverMode(null);
      }),
    []
  );
  const latexRenderExtension = useMemo(() => createLatexRenderExtension(), []);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    documentUpdatedAtRef.current = documentUpdatedAt;
  }, [documentUpdatedAt]);

  async function ensureAgentNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }

    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }

    if (Notification.permission !== "granted") {
      return false;
    }

    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("/agent-notifications-sw.js").catch(() => null);
    }

    return true;
  }

  async function showAgentSystemNotification(title: string, body: string) {
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    if ("serviceWorker" in navigator) {
      const registration =
        (await navigator.serviceWorker.getRegistration("/agent-notifications-sw.js").catch(() => null)) ??
        (await navigator.serviceWorker.register("/agent-notifications-sw.js").catch(() => null));
      if (registration?.showNotification) {
        await registration.showNotification(title, {
          body,
          icon: "/favicon.ico",
          tag: `agent-${Date.now()}`
        });
        return;
      }
    }

    new Notification(title, { body });
  }

  function notifyAgentDone(run: ActiveAiRunView) {
    if (notifiedAgentRunsRef.current.has(run.id)) {
      return;
    }
    notifiedAgentRunsRef.current.add(run.id);

    const ok = run.status === "SUCCEEDED";
    const title = ok ? "Agent finished" : "Agent needs attention";
    const body =
      run.triggerType === "CONVERSATION"
        ? truncate(run.instruction, 120)
        : `${run.triggerType.replace("_", " ").toLowerCase()} completed`;

    setAgentToast({ id: run.id, title, body });
    window.setTimeout(() => {
      setAgentToast((current) => (current?.id === run.id ? null : current));
    }, 6500);

    void showAgentSystemNotification(title, body);
  }

  function notifyAgentCompleted(input: {
    id: string;
    triggerType: string;
    triggerId?: string | null;
    instruction: string;
    status?: string;
  }) {
    notifyAgentDone({
      ...input,
      status: input.status ?? "SUCCEEDED",
      progress: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });
  }

  function syncAiRuns(nextRuns: ActiveAiRunView[]) {
    const previous = previousAiRunsRef.current;

    nextRuns.forEach((run) => {
      const previousStatus = previous[run.id];
      if (previousStatus === "RUNNING" && run.status !== "RUNNING") {
        notifyAgentDone(run);
      }
      previous[run.id] = run.status;
    });

    previousAiRunsRef.current = previous;
    setAiRuns(nextRuns);
    setActiveAiRuns(nextRuns.filter((run) => run.status === "RUNNING"));
    setActiveAiRun(nextRuns.find((run) => run.status === "RUNNING") ?? null);
  }

  function updateThreadOffsets() {
    if (!editor || !editorPageRef.current) {
      return;
    }

    const pageRect = editorPageRef.current.getBoundingClientRect();
    const nextOffsets = threads
      .map((thread) => {
        try {
          const range = resolveCommentAnchorRange(editor.state.doc, thread);
          const top = range ? editor.view.coordsAtPos(range.fromPos).top - pageRect.top : 0;
          return { id: thread.id, top: Math.max(16, top) };
        } catch {
          return { id: thread.id, top: 16 };
        }
      })
      .sort((left, right) => left.top - right.top);

    let cursor = 16;
    const normalized: Record<string, number> = {};

    nextOffsets.forEach((item) => {
      const top = Math.max(item.top, cursor);
      normalized[item.id] = top;
      cursor = top + (item.id === activeThreadId ? 244 : 124);
    });

    setThreadOffsets(normalized);
    setRailHeight(Math.max(editorPageRef.current.offsetHeight, cursor + 32));
  }

  async function saveDocument(
    nextContent: JSONContent,
    metadata?: {
      sourceLinks?: string[];
      commitSha?: string | null;
      commitUrl?: string | null;
      aiRunId?: string | null;
      forceVersion?: boolean;
    }
  ) {
    const normalizedContent = normalizeWidgetsOutsideTables(nextContent).content;
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: titleRef.current,
        content: normalizedContent,
        shareToken,
        forceVersion: metadata?.forceVersion ?? forceVersionRef.current,
        sourceLinks: metadata?.sourceLinks ?? pendingVersionSourcesRef.current,
        commitSha: metadata?.commitSha ?? pendingCommitRef.current.commitSha,
        commitUrl: metadata?.commitUrl ?? pendingCommitRef.current.commitUrl,
        aiRunId: metadata?.aiRunId ?? pendingCommitRef.current.aiRunId
      })
    });

    const data = await response.json().catch(() => null);
    const saved = response.ok && typeof data?.updatedAt === "string";

    if (saved) {
      hasUnsavedChangesRef.current = false;
      forceVersionRef.current = false;
      pendingVersionSourcesRef.current = [];
      pendingCommitRef.current = { commitSha: null, commitUrl: null, aiRunId: null };
      setDocumentUpdatedAt(data.updatedAt);
      setRemoteNotice(null);
      if (historyOpen) {
        void loadVersionHistory();
      }
    }

    setSaveState(saved ? "saved" : "error");
    return saved;
  }

  function normalizeCurrentEditorWidgets() {
    if (!editor) {
      return null;
    }

    const normalized = normalizeWidgetsOutsideTables(editor.getJSON());
    if (normalized.changed) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(normalized.content, false);
      window.requestAnimationFrame(() => {
        isApplyingRemoteUpdateRef.current = false;
      });
    }

    return normalized.content;
  }

  function applyRemoteSnapshot(snapshot: {
    title: string;
    content: JSONContent;
    updatedAt: string;
    threads: ThreadView[];
    activeAiRun: ActiveAiRunView | null;
    activeAiRuns?: ActiveAiRunView[];
    aiRuns?: ActiveAiRunView[];
  }) {
    setThreads(snapshot.threads);
    syncAiRuns(snapshot.aiRuns ?? snapshot.activeAiRuns ?? (snapshot.activeAiRun ? [snapshot.activeAiRun] : []));
    setActiveAiTarget((currentTarget) => {
      const visibleRun = snapshot.activeAiRun ?? snapshot.activeAiRuns?.[0] ?? null;
      if (!visibleRun) {
        return null;
      }

      if (visibleRun.triggerType === "COMMENT_THREAD" && visibleRun.triggerId) {
        return {
          type: "comment-thread",
          threadId: visibleRun.triggerId
        };
      }

      if (visibleRun.triggerType === "SELECTION_EDIT") {
        const range = parseAiRunSelectionRange(visibleRun.triggerId);
        if (range) {
          return getRangeEditTarget(range.from, range.to);
        }
      }

      return currentTarget?.type === "selection-edit" ? currentTarget : null;
    });
    setActiveThreadId((currentThreadId) =>
      snapshot.threads.some((thread) => thread.id === currentThreadId)
        ? currentThreadId
        : snapshot.threads[0]?.id ?? null
    );

    if (snapshot.updatedAt === documentUpdatedAtRef.current) {
      return;
    }

    if (!editor) {
      return;
    }

    if (hasUnsavedChangesRef.current) {
      setRemoteNotice("A collaborator updated the document. Save your edits to refresh.");
      return;
    }

    isApplyingRemoteUpdateRef.current = true;
    setTitle(snapshot.title);
    titleRef.current = snapshot.title;
    editor.commands.setContent(snapshot.content, false);
    setDocumentUpdatedAt(snapshot.updatedAt);
    setRemoteNotice(null);
    window.requestAnimationFrame(() => {
      isApplyingRemoteUpdateRef.current = false;
      updateThreadOffsets();
    });
  }

  async function loadVersionHistory() {
    setHistoryLoading(true);
    setGlobalError(null);

    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    const response = await fetch(`/api/documents/${documentId}/versions${shareQuery}`);
    const data = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(data?.versions)) {
      setGlobalError(data?.error ?? "Unable to load version history.");
      setHistoryLoading(false);
      return;
    }

    setHistoryVersions(data.versions);
    setSelectedVersionId(data.versions[0]?.id ?? null);
    setHistoryLoaded(true);
    setHistoryLoading(false);
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Image.configure({
        allowBase64: true,
        inline: false
      }),
      CommentAnchor,
      commentHighlightExtension,
      latexRenderExtension,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https"
      }),
      Table.configure({
        resizable: false
      }),
      TableRow,
      TableHeader,
      TableCell,
      RepoImage,
      EmbeddedWidget
    ],
    immediatelyRender: false,
    editable: canWriteDocument,
    content: initialContent as JSONContent,
    editorProps: {
      attributes: {
        class: "gdocs-prosemirror"
      },
      handlePaste(view, event) {
        const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/")
        );

        if (imageFiles.length === 0) {
          return false;
        }

        event.preventDefault();
        void insertImagesAtPosition(view, imageFiles);
        return true;
      },
      handleDrop(view, event) {
        const imageFiles = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
          file.type.startsWith("image/")
        );

        if (imageFiles.length === 0) {
          return false;
        }

        event.preventDefault();
        void insertImagesAtPosition(view, imageFiles, {
          left: event.clientX,
          top: event.clientY
        });
        return true;
      },
      handleClick(_view, _pos, event) {
        const target = event.target;
        if (!(target instanceof Element)) {
          return false;
        }

        const anchor = target.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) {
          return false;
        }

        if (!canWriteDocument || event.metaKey || event.ctrlKey) {
          window.open(anchor.href, "_blank", "noopener,noreferrer");
          return true;
        }

        return false;
      }
    },
    onSelectionUpdate: ({ editor }) => {
      const { selection } = editor.state;
      const { from, to } = selection;
      if (!editorPageRef.current) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const selectedNodeText =
        selection instanceof NodeSelection ? describeNodeSelection(selection.node) : "";
      if (from === to && !selectedNodeText) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const text = editor.state.doc.textBetween(from, to, " ").trim() || selectedNodeText;
      if (!text) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const pageRect = editorPageRef.current.getBoundingClientRect();
      const left = Math.max(
        24,
        Math.min((start.left + end.right) / 2 - pageRect.left - 72, pageRect.width - 164)
      );
      const top = Math.max(16, start.top - pageRect.top - 54);

      setSelection({
        text,
        from,
        to,
        context: getSelectionContextFromEditor(editor, from, to) || getSelectionContext(text),
        bubbleTop: top,
        bubbleLeft: left
      });
      setSelectionPopoverMode("menu");
    },
    onUpdate: ({ editor }) => {
      if (!canWriteDocument || isApplyingRemoteUpdateRef.current) {
        return;
      }

      hasUnsavedChangesRef.current = true;
      setSaveState("saving");
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(async () => {
        await saveDocument(editor.getJSON());
      }, 700);

      window.requestAnimationFrame(() => {
        updateThreadOffsets();
      });
    }
  });

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  );

  useEffect(() => {
    threadsRef.current = threads;
    activeThreadIdRef.current = activeThreadId;

    if (editor) {
      editor.view.dispatch(editor.state.tr.setMeta("comment-highlight-refresh", Date.now()));
    }
  }, [activeThreadId, editor, threads]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      updateThreadOffsets();
    });
  }, [editor, threads, activeThreadId]);

  useEffect(() => {
    function handleLayoutChange() {
      updateThreadOffsets();
    }

    window.addEventListener("resize", handleLayoutChange);
    window.addEventListener("scroll", handleLayoutChange, true);

    return () => {
      window.removeEventListener("resize", handleLayoutChange);
      window.removeEventListener("scroll", handleLayoutChange, true);
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [editor, threads, activeThreadId]);

  useEffect(() => {
    if (!historyOpen || historyLoaded) {
      return;
    }

    void loadVersionHistory();
  }, [historyLoaded, historyOpen]);

  useEffect(() => {
    const pollInterval = window.setInterval(async () => {
      const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(`/api/documents/${documentId}${shareQuery}`, {
        cache: "no-store"
      }).catch(() => null);

      if (!response?.ok) {
        return;
      }

      const data = await response.json().catch(() => null);
      if (!data?.document || !Array.isArray(data?.threads)) {
        return;
      }

      applyRemoteSnapshot({
        title: data.document.title,
        content: data.document.content as JSONContent,
        updatedAt: data.document.updatedAt,
        threads: data.threads as ThreadView[],
        activeAiRun: data.activeAiRun ?? null,
        activeAiRuns: Array.isArray(data.activeAiRuns) ? data.activeAiRuns : [],
        aiRuns: Array.isArray(data.aiRuns) ? data.aiRuns : []
      });
    }, 2000);

    return () => window.clearInterval(pollInterval);
  }, [documentId, editor, shareToken]);

  function getReplyDraft(threadId: string) {
    void replyDraftTick;
    return replyDraftsRef.current[threadId] ?? "";
  }

  function setReplyDraft(threadId: string, value: string) {
    replyDraftsRef.current[threadId] = value;
    setReplyDraftTick((count) => count + 1);
  }

  async function handleSaveTitleBlur() {
    if (!canWriteDocument || !editor) {
      return;
    }

    hasUnsavedChangesRef.current = true;
    setSaveState("saving");
    titleRef.current = title;
    await saveDocument(editor.getJSON());
  }

  async function handleSaveRepository() {
    if (!canWriteDocument) {
      return;
    }

    setRepoBusy(true);
    setRepoNotice(null);
    setGlobalError(null);

    const response = await fetch(`/api/documents/${documentId}/repository`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        repoUrl: repoUrl.trim() || null,
        repoBranch: repoBranch.trim() || null
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.repository) {
      setGlobalError(data?.error ?? "Unable to save repository settings.");
      setRepoBusy(false);
      return;
    }

    setRepoUrl(data.repository.repoUrl ?? "");
    setRepoBranch(data.repository.repoBranch ?? "");
    setRepoNotice(data.repository.repoUrl ? "Repository linked" : "Repository link removed");
    setRepoBusy(false);
  }

  async function handleInsertWidget() {
    if (!editor || !canWriteDocument) {
      return;
    }

    const raw = window.prompt(
      "Widget JSON",
      '{"label":"Rollout explorer","build_cmd":"python widgets/build_rollout_explorer.py --output assets/rollouts.html","embed_source":"assets/rollouts.html"}'
    );
    if (!raw) {
      return;
    }

    let parsed: { label?: unknown; build_cmd?: unknown; buildCmd?: unknown; embed_source?: unknown; embedSource?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      setGlobalError("Widget config must be valid JSON.");
      return;
    }

    const label = typeof parsed.label === "string" ? parsed.label : "Interactive widget";
    const buildCmd =
      typeof parsed.build_cmd === "string"
        ? parsed.build_cmd
        : typeof parsed.buildCmd === "string"
          ? parsed.buildCmd
          : "";
    const embedSource =
      typeof parsed.embed_source === "string"
        ? parsed.embed_source
        : typeof parsed.embedSource === "string"
          ? parsed.embedSource
          : "";

    if (!buildCmd || !embedSource) {
      setGlobalError("Widget config needs build_cmd and embed_source.");
      return;
    }

    const response = await fetch(`/api/documents/${documentId}/widgets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        label,
        buildCmd,
        embedSource
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.widget) {
      setGlobalError(data?.error ?? "Unable to create widget.");
      return;
    }

    const src = `/api/documents/${documentId}/widgets/${data.widget.id}/source${
      shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""
    }`;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "embeddedWidget",
        attrs: {
          widgetId: data.widget.id,
          documentId,
          shareToken,
          label,
          buildCmd,
          embedSource,
          src
        }
      })
      .run();
    normalizeCurrentEditorWidgets();
  }

  async function handleCreateComment() {
    if (!selection || !composerBody.trim() || !editor) {
      return;
    }

    setCommentBusy(true);
    setGlobalError(null);

    const selectedRange = selection;
    const threadId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousContent = editor.getJSON();

    isApplyingRemoteUpdateRef.current = true;
    const marked = editor
      .chain()
      .setTextSelection({ from: selectedRange.from, to: selectedRange.to })
      .setMark("commentAnchor", { threadId })
      .setTextSelection({ from: selectedRange.to, to: selectedRange.to })
      .run();
    isApplyingRemoteUpdateRef.current = false;

    if (!marked) {
      setGlobalError("Unable to anchor the comment to the selected text.");
      setCommentBusy(false);
      return;
    }

    const nextContent = editor.getJSON();

    const response = await fetch(`/api/documents/${documentId}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        threadId,
        body: composerBody.trim(),
        anchorText: selectedRange.text,
        anchorContext: selectedRange.context,
        fromPos: selectedRange.from,
        toPos: selectedRange.to,
        content: nextContent,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.thread) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(previousContent, false);
      isApplyingRemoteUpdateRef.current = false;
      setGlobalError(data?.error ?? "Unable to create thread.");
      setCommentBusy(false);
      return;
    }

    setThreads((current) => [data.thread, ...current]);
    setActiveThreadId(data.thread.id);
    if (typeof data.updatedAt === "string") {
      setDocumentUpdatedAt(data.updatedAt);
    }
    setSelection(null);
    setComposerBody("");
    setSelectionPopoverMode(null);
    setCommentBusy(false);
  }

  function getRangeEditTarget(from: number, to: number): ActiveAiTarget | null {
    if (!editor || !editorPageRef.current) {
      return null;
    }

    const boundedFrom = Math.max(0, Math.min(from, editor.state.doc.content.size));
    const boundedTo = Math.max(boundedFrom, Math.min(to, editor.state.doc.content.size));
    const start = editor.view.coordsAtPos(boundedFrom);
    const end = editor.view.coordsAtPos(boundedTo);
    const pageRect = editorPageRef.current.getBoundingClientRect();
    const isMultiline = end.bottom - start.top > 32 || end.left < start.left;
    const left = isMultiline ? 0 : Math.max(18, start.left - pageRect.left);
    const availableWidth = Math.max(220, pageRect.width - left - 24);
    const selectedWidth = Math.abs(end.right - start.left);
    const selectedHeight = Math.max(76, end.bottom - start.top + 24);

    return {
      type: "selection-edit",
      left,
      top: Math.max(24, start.top - pageRect.top - 8),
      width: isMultiline ? pageRect.width : Math.min(Math.max(selectedWidth, 260), availableWidth),
      height: Math.min(selectedHeight, Math.max(160, pageRect.height - (start.top - pageRect.top) + 16))
    };
  }

  function getSelectionEditTarget(selectionState: SelectionState): ActiveAiTarget | null {
    return getRangeEditTarget(selectionState.from, selectionState.to);
  }

  async function handleAiEdit() {
    if (!selection || !editInstruction.trim() || !editor) {
      return;
    }

    const editSelection = selection;
    const instruction = editInstruction.trim();
    const aiTarget = getSelectionEditTarget(selection);
    setGlobalError(null);
    await ensureAgentNotificationPermission();
    setActiveAiTarget(aiTarget);
    setActiveAiRun({
      id: `pending-selection-edit-${Date.now()}`,
      triggerType: "SELECTION_EDIT",
      instruction,
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString()
    });
    setSelectionPopoverMode(null);
    setSelection(null);
    setEditInstruction("");

    const response = await fetch(`/api/documents/${documentId}/ai-edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        selectedText: editSelection.text,
        selectedContext: editSelection.context,
        instruction,
        fromPos: editSelection.from,
        toPos: editSelection.to,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.replacementText) {
      setGlobalError(data?.error ?? "AI edit failed.");
      notifyAgentCompleted({
        id: `failed-selection-edit-${Date.now()}`,
        triggerType: "SELECTION_EDIT",
        instruction,
        status: "FAILED"
      });
      setActiveAiRun(null);
      setActiveAiTarget(null);
      return;
    }

    const sourceLinks = Array.isArray(data.visitedSources) ? data.visitedSources : [];
    const aiImages: AiEditImage[] = Array.isArray(data.images) ? data.images : [];
    const aiWidgets: AiEditWidget[] = Array.isArray(data.widgets) ? data.widgets : [];
    const commitSha = typeof data.commitSha === "string" ? data.commitSha : null;
    const commitUrl = typeof data.commitUrl === "string" ? data.commitUrl : null;
    const aiRunId = typeof data.aiRunId === "string" ? data.aiRunId : null;

    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: editSelection.from, to: editSelection.to },
        buildAiEditInsertContent({
          replacementText: data.replacementText,
          sourceLinks,
          images: aiImages,
          widgets: aiWidgets,
          documentId,
          shareToken
        })
      )
      .run();
    const contentToSave = normalizeCurrentEditorWidgets() ?? editor.getJSON();
    hasUnsavedChangesRef.current = true;
    setSaveState("saving");
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveDocument(contentToSave, {
      sourceLinks,
      commitSha,
      commitUrl,
      aiRunId,
      forceVersion: true
    });

    setActiveAiRun(null);
    setActiveAiTarget(null);
    notifyAgentCompleted({
      id: aiRunId ?? `finished-selection-edit-${Date.now()}`,
      triggerType: "SELECTION_EDIT",
      instruction
    });
  }

  async function handleReply(threadId: string) {
    const draft = getReplyDraft(threadId).trim();
    if (!draft) {
      return;
    }

    setReplyBusyThreadId(threadId);
    setGlobalError(null);

    const response = await fetch(`/api/comments/${threadId}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body: draft,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.comment) {
      setGlobalError(data?.error ?? "Unable to send reply.");
      setReplyBusyThreadId(null);
      return;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              comments: [...thread.comments, data.comment]
            }
          : thread
      )
    );
    setReplyDraft(threadId, "");
    setReplyBusyThreadId(null);
  }

  async function handleAskAi(threadId: string) {
    setAiBusyThreadId(threadId);
    setGlobalError(null);
    await ensureAgentNotificationPermission();
    setActiveAiTarget({
      type: "comment-thread",
      threadId
    });
    setActiveAiRun({
      id: "pending-comment-reply",
      triggerType: "COMMENT_THREAD",
      triggerId: threadId,
      instruction: "Write the next assistant reply for this comment thread.",
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString()
    });

    const response = await fetch(`/api/comments/${threadId}/ask-ai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.comment) {
      setGlobalError(data?.error ?? "AI reply failed.");
      notifyAgentCompleted({
        id: `failed-comment-reply-${Date.now()}`,
        triggerType: "COMMENT_THREAD",
        triggerId: threadId,
        instruction: "Write the next assistant reply for this comment thread.",
        status: "FAILED"
      });
      setActiveAiRun(null);
      setActiveAiTarget(null);
      setAiBusyThreadId(null);
      return;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              comments: [...thread.comments, data.comment]
            }
          : thread
      )
    );
    setActiveAiRun(null);
    setActiveAiTarget(null);
    setAiBusyThreadId(null);
    notifyAgentCompleted({
      id: data.comment.aiRunId ?? `finished-comment-reply-${Date.now()}`,
      triggerType: "COMMENT_THREAD",
      triggerId: threadId,
      instruction: "Write the next assistant reply for this comment thread."
    });
  }

  async function updateThreadTags(thread: ThreadView, tags: string[], status?: ThreadStatusValue) {
    const response = await fetch(`/api/comments/${thread.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tags,
        status,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.thread) {
      setGlobalError(data?.error ?? "Unable to update comment tags.");
      return;
    }

    setThreads((current) =>
      current.map((candidate) => (candidate.id === thread.id ? data.thread : candidate))
    );
  }

  function toggleThreadTag(thread: ThreadView, tag: string) {
    const currentTags = getThreadTags(thread);
    const hasTag = currentTags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase());
    const tags = hasTag
      ? currentTags.filter((candidate) => candidate.toLowerCase() !== tag.toLowerCase())
      : [...currentTags, tag];
    void updateThreadTags(thread, tags, tag === "Resolved" && !hasTag ? "RESOLVED" : undefined);
  }

  function handleAddThreadTag(thread: ThreadView) {
    const raw = window.prompt("Tag name", "");
    const tag = raw?.trim();
    if (!tag) {
      return;
    }

    toggleThreadTag(thread, tag.slice(0, 48));
  }

  async function handleAgentConversation(options?: { previousRunId?: string | null; rootId?: string | null }) {
    const message = agentMessage.trim();
    if (!message) {
      return;
    }

    const previousRunId = options?.previousRunId ?? null;
    const followUpRootId = options?.rootId ?? previousRunId ?? null;

    setAgentBusy(true);
    setGlobalError(null);
    setAgentPanelOpen(true);
    await ensureAgentNotificationPermission();

    const pendingRun: ActiveAiRunView = {
      id: `pending-conversation-${Date.now()}`,
      triggerType: previousRunId ? "CONVERSATION_FOLLOWUP" : "CONVERSATION",
      parentRunId: previousRunId,
      instruction: message,
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString(),
      events: [
        {
          id: `pending-event-${Date.now()}`,
          role: "user",
          message,
          createdAt: new Date().toISOString()
        }
      ]
    };
    syncAiRuns([pendingRun, ...aiRuns]);
    setAgentMessage("");
    setComposeMode("selected");
    if (followUpRootId) {
      setSelectedConversationId(followUpRootId);
    }

    const response = await fetch(`/api/documents/${documentId}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        shareToken,
        previousRunId
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.aiRun) {
      setGlobalError(data?.error ?? "Agent message failed.");
      setAgentBusy(false);
      return;
    }

    const nextRuns = [
      data.aiRun,
      ...aiRuns.filter((run) => run.id !== pendingRun.id && run.id !== data.aiRun.id)
    ];
    syncAiRuns(nextRuns);
    if (!followUpRootId) {
      const resolvedRootId = data.aiRun.parentRunId
        ? buildConversations(nextRuns).find((c) => c.runs.some((r) => r.id === data.aiRun.id))?.rootId ?? data.aiRun.id
        : data.aiRun.id;
      setSelectedConversationId(resolvedRootId);
    }
    setAgentBusy(false);
  }

  async function handleCreateShareLink(permission: PermissionLevelValue) {
    setCreatingLink(permission);
    setGlobalError(null);

    const response = await fetch("/api/share-links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        documentId,
        permission
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.shareLink) {
      setGlobalError(data?.error ?? "Unable to create share link.");
      setCreatingLink(null);
      return;
    }

    setShareLinks((current) => [data.shareLink, ...current]);
    setCreatingLink(null);
  }

  async function handleRevokeShareLink(linkId: string) {
    const response = await fetch(`/api/share-links/${linkId}/revoke`, {
      method: "POST"
    });

    if (!response.ok) {
      setGlobalError("Unable to revoke share link.");
      return;
    }

    setShareLinks((current) => current.filter((link) => link.id !== linkId));
  }

  async function handleInviteCollaborator() {
    if (!inviteEmail.trim()) {
      return;
    }

    setInviteBusy(true);
    setGlobalError(null);

    const response = await fetch("/api/memberships", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        documentId,
        email: inviteEmail.trim(),
        permission: invitePermission
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.membership) {
      setGlobalError(data?.error ?? "Unable to add collaborator.");
      setInviteBusy(false);
      return;
    }

    setMembers((current) => {
      const existingIndex = current.findIndex((member) => member.user.id === data.membership.user.id);
      if (existingIndex === -1) {
        return [...current, data.membership];
      }

      return current.map((member) =>
        member.user.id === data.membership.user.id ? data.membership : member
      );
    });
    setInviteEmail("");
    setInvitePermission("COMMENT");
    setInviteBusy(false);
  }

  function focusThread(thread: ThreadView) {
    setActiveThreadId(thread.id);
    setSelectionPopoverMode(null);

    if (editor) {
      try {
        const range = resolveCommentAnchorRange(editor.state.doc, thread);
        if (!range) {
          return;
        }

        editor.commands.setTextSelection({ from: range.fromPos, to: range.toPos });
        editor.commands.focus();
      } catch {
        // Ignore stale positions after content edits.
      }
    }
  }

  async function handleDeleteComment(commentId: string) {
    setDeleteBusyCommentId(commentId);
    setGlobalError(null);

    const response = await fetch(`/api/comments/comment/${commentId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.deletedCommentId) {
      setGlobalError(data?.error ?? "Unable to delete comment.");
      setDeleteBusyCommentId(null);
      return;
    }

    if (data.deletedThreadId) {
      setThreads((current) => {
        const nextThreads = current.filter((thread) => thread.id !== data.deletedThreadId);
        setActiveThreadId((activeId) =>
          activeId === data.deletedThreadId ? nextThreads[0]?.id ?? null : activeId
        );
        return nextThreads;
      });
      setDeleteBusyCommentId(null);
      return;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.comments.some((comment) => comment.id === data.deletedCommentId)
          ? {
              ...thread,
              comments: thread.comments.filter((comment) => comment.id !== data.deletedCommentId)
            }
          : thread
      )
    );
    setDeleteBusyCommentId(null);
  }

  const availableCommentTags = useMemo(() => {
    const tags = new Map<string, string>();
    DEFAULT_COMMENT_TAGS.forEach((tag) => tags.set(tag.toLowerCase(), tag));
    threads.forEach((thread) => {
      getThreadTags(thread).forEach((tag) => tags.set(tag.toLowerCase(), tag));
    });
    return Array.from(tags.values()).sort((left, right) => left.localeCompare(right));
  }, [threads]);

  function getCommentTagFilter(tag: string) {
    return commentTagFilters[tag.toLowerCase()] ?? "all";
  }

  function setCommentTagFilter(tag: string, value: CommentTagFilterValue) {
    setCommentTagFilters((current) => ({
      ...current,
      [tag.toLowerCase()]: value
    }));
  }

  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) => {
        const threadTags = getThreadTags(thread);
        for (const tag of availableCommentTags) {
          const filter = commentTagFilters[tag.toLowerCase()] ?? "all";
          if (filter === "all") {
            continue;
          }
          const hasTag = threadTags.some((threadTag) => threadTag.toLowerCase() === tag.toLowerCase());
          if (filter === "yes" && !hasTag) {
            return false;
          }
          if (filter === "no" && hasTag) {
            return false;
          }
        }
        return true;
      }),
    [availableCommentTags, commentTagFilters, threads]
  );

  const orderedThreads = useMemo(() => {
    const inactiveThreads = visibleThreads.filter((thread) => thread.id !== activeThreadId);
    const activeThread = visibleThreads.find((thread) => thread.id === activeThreadId);
    return activeThread ? [...inactiveThreads, activeThread] : inactiveThreads;
  }, [activeThreadId, visibleThreads]);
  const selectedVersion =
    historyVersions.find((version) => version.id === selectedVersionId) ?? historyVersions[0] ?? null;
  const conversations = useMemo(() => buildConversations(aiRuns), [aiRuns]);
  const selectedConversation = useMemo(() => {
    if (composeMode === "new") return null;
    if (selectedConversationId) {
      const found = conversations.find((c) => c.rootId === selectedConversationId);
      if (found) return found;
    }
    return conversations[0] ?? null;
  }, [composeMode, conversations, selectedConversationId]);

  useEffect(() => {
    if (composeMode === "new") return;
    if (!selectedConversationId && conversations[0]) {
      setSelectedConversationId(conversations[0].rootId);
      return;
    }
    if (
      selectedConversationId &&
      conversations.length > 0 &&
      !conversations.some((c) => c.rootId === selectedConversationId)
    ) {
      setSelectedConversationId(conversations[0].rootId);
    }
  }, [composeMode, conversations, selectedConversationId]);

  const selectionRunTargets = useMemo(() => {
    if (!editor || !editorPageRef.current) return [];
    const out: Array<{
      runId: string;
      run: ActiveAiRunView;
      coords: { top: number; left: number; width: number; height: number };
    }> = [];
    for (const run of activeAiRuns) {
      if (run.status !== "RUNNING") continue;
      if (run.triggerType !== "SELECTION_EDIT") continue;
      const range = parseAiRunSelectionRange(run.triggerId);
      if (!range) continue;
      const target = getRangeEditTarget(range.from, range.to);
      if (target && target.type === "selection-edit") {
        out.push({
          runId: run.id,
          run,
          coords: { top: target.top, left: target.left, width: target.width, height: target.height }
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAiRuns, editor]);

  const commentThreadRunsByThread = useMemo(() => {
    const map = new Map<string, ActiveAiRunView>();
    for (const run of activeAiRuns) {
      if (run.status !== "RUNNING") continue;
      if (run.triggerType !== "COMMENT_THREAD" || !run.triggerId) continue;
      if (!map.has(run.triggerId)) {
        map.set(run.triggerId, run);
      }
    }
    return map;
  }, [activeAiRuns]);

  return (
    <section className="workspace-shell">
      {globalError ? <div className="error-banner">{globalError}</div> : null}

      {agentPanelOpen ? null : (
      <>
      <div className="document-chrome">
        <div className="document-topbar">
          <div className="document-topbar-left">
            <input
              aria-label="Document title"
              className="document-title-input"
              disabled={!canWriteDocument}
              onBlur={handleSaveTitleBlur}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </div>

          <div className="document-compact-status">
            <span className="save-indicator">
              {saveState === "saving"
                ? "Saving..."
                : saveState === "saved"
                  ? "Saved"
                  : saveState === "error"
                    ? "Save failed"
                    : "Ready"}
            </span>
          </div>

          <details className="header-menu">
            <summary>Format</summary>
            <div className="header-menu-panel editor-toolbar" role="toolbar" aria-label="Document formatting">
              <div className="editor-toolbar-group">
                <ToolbarButton
                  active={editor?.isActive("heading", { level: 1 }) ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Title"
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
                />
                <ToolbarButton
                  active={editor?.isActive("heading", { level: 2 }) ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="H2"
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
                />
                <ToolbarButton
                  active={editor?.isActive("paragraph") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Text"
                  onClick={() => editor?.chain().focus().setParagraph().run()}
                />
              </div>

              <div className="editor-toolbar-group">
                <ToolbarButton
                  active={editor?.isActive("bold") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="B"
                  onClick={() => editor?.chain().focus().toggleBold().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("italic") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="I"
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("underline") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="U"
                  onClick={() => editor?.chain().focus().toggleUnderline().run()}
                />
              </div>

              <div className="editor-toolbar-group">
                <ToolbarButton
                  active={editor?.isActive("bulletList") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Bullets"
                  onClick={() => editor?.chain().focus().toggleBulletList().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("orderedList") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Numbered"
                  onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("blockquote") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Quote"
                  onClick={() => editor?.chain().focus().toggleBlockquote().run()}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !editor}
                  label="Widget"
                  onClick={handleInsertWidget}
                />
              </div>
            </div>
          </details>

          <details className="header-menu header-menu-comments">
            <summary>Comments</summary>
            <div className="header-menu-panel comment-filter-panel" aria-label="Comment filters">
              {availableCommentTags.map((tag) => {
                const filter = getCommentTagFilter(tag);
                return (
                  <div className="comment-tag-filter-row" key={tag}>
                    <span>{tag}</span>
                    <div className="comment-tag-filter-controls" role="group" aria-label={`${tag} filter`}>
                      {(["yes", "no", "all"] as CommentTagFilterValue[]).map((value) => (
                        <button
                          className={filter === value ? "active" : ""}
                          key={value}
                          onClick={() => setCommentTagFilter(tag, value)}
                          type="button"
                        >
                          {value === "yes" ? "Yes" : value === "no" ? "No" : "All"}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>

          <details className="header-menu header-menu-wide">
            <summary>Repo</summary>
            <div className="header-menu-panel research-repo-panel">
              <div>
                <strong>Research repository</strong>
                <p>
                  {repoUrl
                    ? `${repoUrl}${repoBranch ? ` on ${repoBranch}` : ""}`
                    : "Link a GitHub repo to give the AI a checked-out workspace."}
                </p>
              </div>
              {canWriteDocument ? (
                <div className="research-repo-controls">
                  <input
                    aria-label="GitHub repository URL"
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/org/repo"
                    value={repoUrl}
                  />
                  <input
                    aria-label="Repository branch"
                    onChange={(event) => setRepoBranch(event.target.value)}
                    placeholder="Branch"
                    value={repoBranch}
                  />
                  <button
                    className="ghost-button"
                    disabled={repoBusy}
                    onClick={handleSaveRepository}
                    type="button"
                  >
                    {repoBusy ? "Saving..." : "Save"}
                  </button>
                </div>
              ) : null}
              {repoNotice ? <span className="subtle-pill">{repoNotice}</span> : null}
            </div>
          </details>

          <div className="document-topbar-actions">
            <details className="header-menu header-menu-right">
              <summary>More</summary>
              <div className="header-menu-panel header-actions-panel">
                <div className="presence-chip">
                  {isAuthenticated ? `Signed in as ${currentUserName}` : "Browsing via share link"}
                </div>
                <div className="document-menu-status">
                  <span className="permission-pill">{permissionLabel(initialPermission)}</span>
                  {viaShareLink ? <span className="subtle-pill">Link access</span> : null}
                  {remoteNotice ? <span className="subtle-pill">{remoteNotice}</span> : null}
                </div>
                <button
                  className="ghost-button"
                  onClick={() => setHistoryOpen(true)}
                  type="button"
                >
                  Version history
                </button>
                <button
                  className="ghost-button"
                  onClick={() => setAgentPanelOpen((open) => !open)}
                  type="button"
                >
                  Agents{activeAiRuns.length > 0 ? ` (${activeAiRuns.length})` : ""}
                </button>
                {isOwner ? (
                  <button className="primary-button" onClick={() => setShareModalOpen(true)} type="button">
                    Share
                  </button>
                ) : null}
              </div>
            </details>
          </div>
        </div>
      </div>

      {agentToast ? (
        <button className="agent-toast" onClick={() => setAgentPanelOpen(true)} type="button">
          <strong>{agentToast.title}</strong>
          <span>{agentToast.body}</span>
        </button>
      ) : null}

      {activeAiRuns.length > 1 ? (
        <div className="agent-progress-banner">
          <div>
            <strong>{activeAiRuns.length} agents running</strong>
            <p>{activeAiRuns.map((run) => getAiRunProgressLabel(run)).join(" · ")}</p>
          </div>
          <button className="ghost-button" onClick={() => setAgentPanelOpen(true)} type="button">
            Open agent view
          </button>
        </div>
      ) : null}

      <div className="editor-stage">
        <div className="editor-page-shell">
          <div className="editor-page" ref={editorPageRef}>
            {selection && (canWriteComments || canWriteDocument) ? (
              <div
                className="selection-bubble-wrap"
                style={{
                  left: selection.bubbleLeft,
                  top: selection.bubbleTop
                }}
              >
                {selectionPopoverMode === "menu" ? (
                  <div className="selection-bubble-menu">
                    {canWriteComments ? (
                      <button
                        className="selection-bubble"
                        onClick={() => setSelectionPopoverMode("comment")}
                        type="button"
                      >
                        Add comment
                      </button>
                    ) : null}
                    {canWriteDocument ? (
                      <button
                        className="selection-bubble selection-bubble-secondary"
                        onClick={() => setSelectionPopoverMode("edit")}
                        type="button"
                      >
                        Edit with AI
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {selectionPopoverMode === "comment" ? (
                  <div className="comment-composer-popover">
                    <div className="composer-selection-preview">“{truncate(selection.text, 80)}”</div>
                    <textarea
                      onChange={(event) => setComposerBody(event.target.value)}
                      placeholder="Add a comment"
                      rows={4}
                      value={composerBody}
                    />
                    <div className="comment-composer-actions">
                      <button
                        className="ghost-button"
                        onClick={() => {
                          setSelectionPopoverMode("menu");
                          setComposerBody("");
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="primary-button"
                        disabled={!composerBody.trim() || commentBusy}
                        onClick={handleCreateComment}
                        type="button"
                      >
                        {commentBusy ? "Posting..." : "Comment"}
                      </button>
                    </div>
                  </div>
                ) : null}

                {selectionPopoverMode === "edit" ? (
                  <div className="comment-composer-popover">
                    <div className="composer-selection-preview">“{truncate(selection.text, 80)}”</div>
                    <textarea
                      onChange={(event) => setEditInstruction(event.target.value)}
                      placeholder="Tell AI how to rewrite the selection"
                      rows={4}
                      value={editInstruction}
                    />
                    <div className="comment-composer-actions">
                      <button
                        className="ghost-button"
                        onClick={() => {
                          setSelectionPopoverMode("menu");
                          setEditInstruction("");
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="primary-button"
                        disabled={!editInstruction.trim()}
                        onClick={handleAiEdit}
                        type="button"
                      >
                        Apply edit
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectionRunTargets.map((target) => (
              <div
                className="claude-working-selection"
                key={target.runId}
                style={{
                  left: target.coords.left,
                  top: target.coords.top,
                  width: target.coords.width,
                  minHeight: target.coords.height
                }}
              >
                <ClaudeWorkingInline activeAiRun={target.run} />
              </div>
            ))}

            <EditorContent editor={editor} />
          </div>
        </div>

        <aside className="comment-rail" style={{ minHeight: railHeight }}>
          {threads.length === 0 ? (
            <div className="comment-rail-empty">
              <p>
                {canWriteComments
                  ? "Select text to add a comment."
                  : "Comments will appear here when collaborators start a thread."}
              </p>
            </div>
          ) : orderedThreads.length === 0 ? (
            <div className="comment-rail-empty">
              <p>No comments match this filter.</p>
            </div>
          ) : (
            orderedThreads.map((thread) => {
              const isActive = activeThread?.id === thread.id;
              const latestComment = thread.comments[thread.comments.length - 1];
              const threadRun = commentThreadRunsByThread.get(thread.id) ?? null;
              const isThreadAiBusy = aiBusyThreadId === thread.id || threadRun !== null;

              return (
                <article
                  className={`comment-thread-card ${isActive ? "comment-thread-card-active" : ""}`}
                  key={thread.id}
                  onMouseDown={() => focusThread(thread)}
                  style={{ top: threadOffsets[thread.id] ?? 16 }}
                >
                  <button className="comment-thread-anchor" onClick={() => focusThread(thread)} type="button">
                    <span className="comment-anchor-quote">“{truncate(thread.anchorText, 52)}”</span>
                    <span className="comment-anchor-meta">
                      {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}
                    </span>
                  </button>
                  <div className="comment-tag-row" onMouseDown={(event) => event.stopPropagation()}>
                    {[...DEFAULT_COMMENT_TAGS, ...getThreadTags(thread).filter((tag) => !DEFAULT_COMMENT_TAGS.includes(tag))].map(
                      (tag) => {
                        const active = getThreadTags(thread).some((candidate) => candidate.toLowerCase() === tag.toLowerCase());
                        return (
                          <button
                            className={active ? "comment-tag-chip comment-tag-chip-active" : "comment-tag-chip"}
                            disabled={!canWriteComments}
                            key={tag}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleThreadTag(thread, tag);
                            }}
                            type="button"
                          >
                            {tag}
                          </button>
                        );
                      }
                    )}
                    {canWriteComments ? (
                      <button
                        className="comment-tag-add"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAddThreadTag(thread);
                        }}
                        type="button"
                      >
                        +
                      </button>
                    ) : null}
                  </div>

                  {!isActive ? (
                    <div className="comment-thread-preview">
                      {isThreadAiBusy ? (
                        <ClaudeWorkingInline activeAiRun={threadRun ?? activeAiRun} compact />
                      ) : (
                        <>
                          <div className="comment-author-chip">
                            {latestComment ? <CommentAvatar comment={latestComment} /> : null}
                            <strong>{latestComment?.author?.name ?? "Claude"}</strong>
                          </div>
                          <p>{truncate(latestComment?.body ?? "", 140)}</p>
                        </>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="comment-bubble-list">
                        {thread.comments.map((comment) => (
                          <div className="comment-bubble" key={comment.id}>
                            <div className="comment-bubble-header">
                              <div className="comment-author-chip">
                                <CommentAvatar comment={comment} />
                                <strong>{comment.author?.name ?? "Claude"}</strong>
                              </div>
                              <div className="comment-bubble-meta">
                                <span>{formatDateTime(comment.createdAt)}</span>
                                {isOwner ||
                                comment.author?.id === currentUserId ||
                                comment.aiModel ? (
                                  <button
                                    className="comment-delete-button"
                                    disabled={deleteBusyCommentId === comment.id}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleDeleteComment(comment.id);
                                    }}
                                    type="button"
                                  >
                                    {deleteBusyCommentId === comment.id ? "Deleting..." : "Delete"}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            <p>{comment.body}</p>
                            {comment.aiModel ? (
                              <div className="comment-ai-meta">
                                <span className="subtle-pill">{comment.aiModel}</span>
                                {comment.sourceLinks.length > 0 ? (
                                  <details className="comment-sources">
                                    <summary>Visited websites</summary>
                                    <div className="comment-sources-list">
                                      {comment.sourceLinks.map((sourceLink, index) => (
                                        <a
                                          href={sourceLink}
                                          key={`${comment.id}-${sourceLink}`}
                                          rel="noopener noreferrer"
                                          target="_blank"
                                        >
                                          [{index + 1}] {getSourceLabel(sourceLink)}
                                        </a>
                                      ))}
                                    </div>
                                  </details>
                                ) : null}
                                {comment.commitUrl ? (
                                  <a
                                    className="comment-commit-link"
                                    href={comment.commitUrl}
                                    rel="noopener noreferrer"
                                    target="_blank"
                                  >
                                    Commit {comment.commitSha?.slice(0, 7)}
                                  </a>
                                ) : comment.commitSha ? (
                                  <span className="subtle-pill">Commit {comment.commitSha.slice(0, 7)}</span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          ))}
                      </div>

                      {isThreadAiBusy ? <ClaudeWorkingInline activeAiRun={threadRun ?? activeAiRun} /> : null}

                      {canWriteComments ? (
                        <div className="thread-actions">
                          <textarea
                            onChange={(event) => setReplyDraft(thread.id, event.target.value)}
                            placeholder="Reply"
                            rows={3}
                            value={getReplyDraft(thread.id)}
                          />
                          <div className="comment-composer-actions">
                            <button
                              className="ghost-button"
                              disabled={
                                replyBusyThreadId === thread.id || !getReplyDraft(thread.id).trim()
                              }
                              onClick={() => handleReply(thread.id)}
                              type="button"
                            >
                              {replyBusyThreadId === thread.id ? "Sending..." : "Reply"}
                            </button>
                            <button
                              className="primary-button"
                              disabled={aiBusyThreadId === thread.id}
                              onClick={() => handleAskAi(thread.id)}
                              type="button"
                            >
                              {aiBusyThreadId === thread.id ? "Claude is thinking..." : "Ask AI"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </article>
              );
            })
          )}
        </aside>
      </div>
      </>
      )}

      {agentPanelOpen ? (
        <div className="agent-screen" role="region" aria-label="Agents">
          <header className="agent-screen-topbar">
            <button
              className="agent-back-button"
              onClick={() => setAgentPanelOpen(false)}
              type="button"
            >
              ← Back to document
            </button>
            <div className="agent-screen-title">
              <span className="agent-screen-title-eyebrow">Agents</span>
              <span className="agent-screen-title-doc">{title}</span>
            </div>
            <span className="agent-screen-topbar-status">
              {activeAiRuns.length > 0
                ? `${activeAiRuns.length} running`
                : `${conversations.length} ${conversations.length === 1 ? "thread" : "threads"}`}
            </span>
          </header>
          <div className="agent-screen-body">
          <aside className="agent-sidebar" aria-label="Agent conversations">
            {canWriteComments ? (
              <button
                className={cn("agent-new-button", composeMode === "new" && "agent-new-button-active")}
                onClick={() => {
                  setComposeMode("new");
                  setSelectedConversationId(null);
                }}
                type="button"
              >
                + New conversation
              </button>
            ) : null}
            <div className="agent-sidebar-list">
              {conversations.length === 0 ? (
                <div className="agent-sidebar-empty">No conversations yet.</div>
              ) : (
                conversations.map((conv) => {
                  const firstLine =
                    conv.rootInstruction.split("\n")[0] ||
                    conv.latestRun.triggerType.replace(/_/g, " ").toLowerCase();
                  const isActive = composeMode === "selected" && selectedConversation?.rootId === conv.rootId;
                  const turnCount = conv.runs.length;
                  return (
                    <button
                      aria-current={isActive ? "true" : undefined}
                      className={cn("agent-sidebar-item", isActive && "agent-sidebar-item-active")}
                      key={conv.rootId}
                      onClick={() => {
                        setComposeMode("selected");
                        setSelectedConversationId(conv.rootId);
                      }}
                      type="button"
                    >
                      <div className="agent-sidebar-item-top">
                        <span className={`agent-status-dot agent-status-dot-${conv.status.toLowerCase()}`} aria-hidden />
                        <span className="agent-sidebar-item-title">{truncate(firstLine, 48)}</span>
                        <span className="agent-sidebar-item-time">{formatRelativeTime(conv.lastActivityAt)}</span>
                      </div>
                      <p className="agent-sidebar-item-snippet">{truncate(conv.rootInstruction, 120)}</p>
                      {turnCount > 1 ? (
                        <span className="agent-sidebar-item-turns">{turnCount} turns</span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="agent-main" aria-label="Selected agent conversation">
            {composeMode === "selected" && selectedConversation ? (
              <>
                <header className="agent-main-header">
                  <div className="agent-main-title">
                    <span className={`agent-status agent-status-${selectedConversation.status.toLowerCase()}`}>
                      {selectedConversation.status.toLowerCase()}
                    </span>
                    <h3>{truncate(selectedConversation.rootInstruction.split("\n")[0], 120)}</h3>
                    {selectedConversation.runs.length > 1 ? (
                      <span className="agent-main-turns">{selectedConversation.runs.length} turns</span>
                    ) : null}
                  </div>
                  <div className="agent-main-meta">
                    {selectedConversation.branchName ? (
                      <span><span className="agent-meta-label">branch</span> {selectedConversation.branchName}</span>
                    ) : null}
                    {selectedConversation.commitUrl ? (
                      <a href={selectedConversation.commitUrl} rel="noopener noreferrer" target="_blank">
                        commit {selectedConversation.commitSha?.slice(0, 7)}
                      </a>
                    ) : selectedConversation.commitSha ? (
                      <span><span className="agent-meta-label">commit</span> {selectedConversation.commitSha.slice(0, 7)}</span>
                    ) : null}
                  </div>
                </header>

                <AgentTimeline
                  events={selectedConversation.events}
                  progress={selectedConversation.progress}
                  status={selectedConversation.status}
                />

                {canWriteComments ? (
                  <form
                    className="agent-compose"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!agentBusy && agentMessage.trim()) {
                        handleAgentConversation({
                          previousRunId: selectedConversation.latestRun.id,
                          rootId: selectedConversation.rootId
                        });
                      }
                    }}
                  >
                    <textarea
                      onChange={(event) => setAgentMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          if (!agentBusy && agentMessage.trim()) {
                            handleAgentConversation({
                              previousRunId: selectedConversation.latestRun.id,
                              rootId: selectedConversation.rootId
                            });
                          }
                        }
                      }}
                      placeholder="Reply to the agent… (⌘/Ctrl + Enter to send)"
                      rows={2}
                      value={agentMessage}
                    />
                    <button
                      className="primary-button"
                      disabled={agentBusy || !agentMessage.trim()}
                      type="submit"
                    >
                      {agentBusy ? "Sending…" : "Reply"}
                    </button>
                  </form>
                ) : null}
              </>
            ) : (
              <div className="agent-main-empty">
                <h3>Start a new conversation</h3>
                <p>Ask Claude to inspect the document, run code in the linked repo, or answer a question. Each thread keeps its own history so you can follow up.</p>
                {canWriteComments ? (
                  <form
                    className="agent-compose agent-compose-standalone"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!agentBusy && agentMessage.trim()) {
                        handleAgentConversation();
                      }
                    }}
                  >
                    <textarea
                      autoFocus
                      onChange={(event) => setAgentMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          if (!agentBusy && agentMessage.trim()) {
                            handleAgentConversation();
                          }
                        }
                      }}
                      placeholder="What should Claude do? (⌘/Ctrl + Enter to send)"
                      rows={3}
                      value={agentMessage}
                    />
                    <button
                      className="primary-button"
                      disabled={agentBusy || !agentMessage.trim()}
                      type="submit"
                    >
                      {agentBusy ? "Sending…" : "Send"}
                    </button>
                  </form>
                ) : null}
              </div>
            )}
          </section>
          </div>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="share-modal-backdrop" onClick={() => setHistoryOpen(false)} role="presentation">
          <div
            aria-modal="true"
            className="version-history-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="share-modal-header">
              <div>
                <h2>Version history</h2>
                <p>Past snapshots load only when this panel is opened.</p>
              </div>
              <button className="ghost-button" onClick={() => setHistoryOpen(false)} type="button">
                Close
              </button>
            </div>

            {historyLoading ? (
              <div className="empty-state">Loading versions...</div>
            ) : historyVersions.length === 0 ? (
              <div className="empty-state">No saved versions yet.</div>
            ) : (
              <div className="version-history-layout">
                <div className="version-history-list">
                  {historyVersions.map((version) => (
                    <button
                      className={`version-history-item ${selectedVersion?.id === version.id ? "version-history-item-active" : ""}`}
                      key={version.id}
                      onClick={() => setSelectedVersionId(version.id)}
                      type="button"
                    >
                      <strong>{version.title}</strong>
                      <span>{formatDateTime(version.createdAt)}</span>
                    </button>
                  ))}
                </div>

                <div className="version-history-preview">
                  {selectedVersion ? (
                    <>
                      <div className="version-history-preview-header">
                        <div>
                          <strong>{selectedVersion.title}</strong>
                          <div className="muted-copy">{formatDateTime(selectedVersion.createdAt)}</div>
                        </div>
                        {selectedVersion.sourceLinks.length > 0 ? (
                          <div className="version-source-list">
                            {selectedVersion.sourceLinks.map((sourceLink, index) => (
                              <a
                                href={sourceLink}
                                key={`${selectedVersion.id}-${sourceLink}`}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                [{index + 1}] {getSourceLabel(sourceLink)}
                              </a>
                            ))}
                          </div>
                        ) : null}
                        {selectedVersion.commitUrl ? (
                          <a
                            className="comment-commit-link"
                            href={selectedVersion.commitUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Commit {selectedVersion.commitSha?.slice(0, 7)}
                          </a>
                        ) : selectedVersion.commitSha ? (
                          <span className="subtle-pill">Commit {selectedVersion.commitSha.slice(0, 7)}</span>
                        ) : null}
                      </div>
                      <pre>{selectedVersion.plainText}</pre>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {shareModalOpen ? (
        <div className="share-modal-backdrop" onClick={() => setShareModalOpen(false)} role="presentation">
          <div
            aria-modal="true"
            className="share-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="share-modal-header">
              <div>
                <h2>Share document</h2>
                <p>Add collaborators or create permissioned links.</p>
              </div>
              <button className="ghost-button" onClick={() => setShareModalOpen(false)} type="button">
                Close
              </button>
            </div>

            <div className="member-invite-form">
              <input
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="Collaborator email"
                type="email"
                value={inviteEmail}
              />
              <div className="comment-composer-actions">
                <select
                  onChange={(event) => setInvitePermission(event.target.value as PermissionLevelValue)}
                  value={invitePermission}
                >
                  {permissionLevels.map((permission) => (
                    <option key={permission} value={permission}>
                      {permissionLabel(permission)}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-button"
                  disabled={inviteBusy || !inviteEmail.trim()}
                  onClick={handleInviteCollaborator}
                  type="button"
                >
                  {inviteBusy ? "Inviting..." : "Invite by email"}
                </button>
              </div>
            </div>

            <div className="share-modal-section">
              <h3>People with access</h3>
              <div className="member-list">
                {members.length === 0 ? (
                  <p className="muted-copy">No direct collaborators yet.</p>
                ) : (
                  members.map((member) => (
                    <div className="member-row" key={member.id}>
                      <div>
                        <strong>{member.user.name}</strong>
                        <span>{member.user.email}</span>
                      </div>
                      <span className="permission-pill">{permissionLabel(member.permission)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="share-modal-section">
              <h3>Share links</h3>
              <div className="share-actions">
                {permissionLevels.map((permission) => (
                  <button
                    className="ghost-button"
                    disabled={creatingLink === permission}
                    key={permission}
                    onClick={() => handleCreateShareLink(permission)}
                    type="button"
                  >
                    {creatingLink === permission ? "Creating..." : `New ${permission.toLowerCase()} link`}
                  </button>
                ))}
              </div>

              <div className="share-link-list">
                {shareLinks.length === 0 ? (
                  <p className="muted-copy">No active share links yet.</p>
                ) : (
                  shareLinks.map((link) => {
                    const path = `/share/${link.token}`;

                    return (
                      <div className="share-link-row" key={link.id}>
                        <div>
                          <strong>{permissionLabel(link.permission)}</strong>
                          <span>{path}</span>
                        </div>
                        <div className="share-link-actions">
                          <button
                            className="ghost-button"
                            onClick={() =>
                              navigator.clipboard.writeText(`${window.location.origin}${path}`)
                            }
                            type="button"
                          >
                            Copy
                          </button>
                          <button
                            className="ghost-button danger-button"
                            onClick={() => handleRevokeShareLink(link.id)}
                            type="button"
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
