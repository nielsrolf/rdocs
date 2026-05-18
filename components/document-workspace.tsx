"use client";

import { Extension, Node, mergeAttributes } from "@tiptap/core";
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
import { formatDateTime, permissionLabel, truncate } from "@/lib/utils";

type CommentView = {
  id: string;
  body: string;
  aiModel: string | null;
  sourceLinks: string[];
  commitSha: string | null;
  commitUrl: string | null;
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

type HighlightThread = {
  id: string;
  fromPos: number | null;
  toPos: number | null;
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
                if (
                  thread.fromPos == null ||
                  thread.toPos == null ||
                  thread.fromPos >= thread.toPos ||
                  thread.toPos > state.doc.content.size
                ) {
                  return [];
                }

                const isActive = thread.id === activeThreadIdRef.current;
                return [
                  Decoration.inline(thread.fromPos, thread.toPos, {
                    class: isActive
                      ? "comment-anchor-highlight comment-anchor-highlight-active"
                      : "comment-anchor-highlight"
                  })
                ];
              });

              return DecorationSet.create(state.doc, decorations);
            },
            handleClick(_view, pos) {
              const thread = threadsRef.current.find(
                (candidate) =>
                  candidate.fromPos != null &&
                  candidate.toPos != null &&
                  pos >= candidate.fromPos &&
                  pos <= candidate.toPos
              );

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
  const [activeAiRun, setActiveAiRun] = useState<ActiveAiRunView | null>(null);
  const [activeAiRuns, setActiveAiRuns] = useState<ActiveAiRunView[]>([]);
  const [aiRuns, setAiRuns] = useState<ActiveAiRunView[]>([]);
  const [activeAiTarget, setActiveAiTarget] = useState<ActiveAiTarget | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null);
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

  function requestAgentNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }

  function notifyAgentDone(run: ActiveAiRunView) {
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

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
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
          const top =
            thread.fromPos != null ? editor.view.coordsAtPos(thread.fromPos).top - pageRect.top : 0;
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
    if (!selection || !composerBody.trim()) {
      return;
    }

    setCommentBusy(true);
    setGlobalError(null);

    const response = await fetch(`/api/documents/${documentId}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body: composerBody.trim(),
        anchorText: selection.text,
        anchorContext: selection.context,
        fromPos: selection.from,
        toPos: selection.to,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.thread) {
      setGlobalError(data?.error ?? "Unable to create thread.");
      setCommentBusy(false);
      return;
    }

    setThreads((current) => [data.thread, ...current]);
    setActiveThreadId(data.thread.id);
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
    requestAgentNotificationPermission();
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
    requestAgentNotificationPermission();
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
  }

  async function handleAgentConversation() {
    const message = agentMessage.trim();
    if (!message) {
      return;
    }

    setAgentBusy(true);
    setGlobalError(null);
    setAgentPanelOpen(true);
    requestAgentNotificationPermission();

    const pendingRun: ActiveAiRunView = {
      id: `pending-conversation-${Date.now()}`,
      triggerType: "CONVERSATION",
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

    const response = await fetch(`/api/documents/${documentId}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.aiRun) {
      setGlobalError(data?.error ?? "Agent message failed.");
      setAgentBusy(false);
      return;
    }

    syncAiRuns([data.aiRun, ...aiRuns.filter((run) => run.id !== pendingRun.id && run.id !== data.aiRun.id)]);
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

    if (editor && thread.fromPos != null && thread.toPos != null) {
      try {
        editor.commands.setTextSelection({ from: thread.fromPos, to: thread.toPos });
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

  const orderedThreads = useMemo(() => {
    const inactiveThreads = threads.filter((thread) => thread.id !== activeThreadId);
    const activeThread = threads.find((thread) => thread.id === activeThreadId);
    return activeThread ? [...inactiveThreads, activeThread] : inactiveThreads;
  }, [activeThreadId, threads]);
  const selectedVersion =
    historyVersions.find((version) => version.id === selectedVersionId) ?? historyVersions[0] ?? null;
  const selectedAgentRun = useMemo(
    () => aiRuns.find((run) => run.id === selectedAgentRunId) ?? aiRuns[0] ?? null,
    [aiRuns, selectedAgentRunId]
  );

  useEffect(() => {
    if (!selectedAgentRunId && aiRuns[0]) {
      setSelectedAgentRunId(aiRuns[0].id);
      return;
    }

    if (selectedAgentRunId && aiRuns.length > 0 && !aiRuns.some((run) => run.id === selectedAgentRunId)) {
      setSelectedAgentRunId(aiRuns[0].id);
    }
  }, [aiRuns, selectedAgentRunId]);

  return (
    <section className="workspace-shell">
      {globalError ? <div className="error-banner">{globalError}</div> : null}

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

            {activeAiRun && activeAiTarget?.type === "selection-edit" ? (
              <div
                className="claude-working-selection"
                style={{
                  left: activeAiTarget.left,
                  top: activeAiTarget.top,
                  width: activeAiTarget.width,
                  minHeight: activeAiTarget.height
                }}
              >
                <ClaudeWorkingInline activeAiRun={activeAiRun} />
              </div>
            ) : null}

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
          ) : (
            orderedThreads.map((thread) => {
              const isActive = activeThread?.id === thread.id;
              const latestComment = thread.comments[thread.comments.length - 1];
              const isThreadAiBusy =
                aiBusyThreadId === thread.id ||
                (activeAiRun?.triggerType === "COMMENT_THREAD" &&
                  activeAiTarget?.type === "comment-thread" &&
                  activeAiTarget.threadId === thread.id);

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

                  {!isActive ? (
                    <div className="comment-thread-preview">
                      {isThreadAiBusy ? (
                        <ClaudeWorkingInline activeAiRun={activeAiRun} compact />
                      ) : (
                        <>
                          <div className="comment-author-chip">
                            <span className="avatar-dot">
                              {getInitials(latestComment?.author?.name ?? "Claude")}
                            </span>
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
                                <span className="avatar-dot">
                                  {getInitials(comment.author?.name ?? "Claude")}
                                </span>
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

                      {isThreadAiBusy ? <ClaudeWorkingInline activeAiRun={activeAiRun} /> : null}

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

      {agentPanelOpen ? (
        <div className="agent-panel">
          <div className="agent-panel-header">
            <div>
              <h2>Agents</h2>
              <p>
                {activeAiRuns.length > 0
                  ? `${activeAiRuns.length} running`
                  : `${aiRuns.length} conversation${aiRuns.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <button className="ghost-button" onClick={() => setAgentPanelOpen(false)} type="button">
              Close
            </button>
          </div>

          <div className="agent-workspace">
            <aside className="agent-conversation-list" aria-label="Agent conversations">
              {aiRuns.length === 0 ? (
                <div className="empty-state">Message an agent to inspect the document or linked repo.</div>
              ) : (
                aiRuns.map((run) => (
                  <button
                    className={`agent-conversation-item ${selectedAgentRun?.id === run.id ? "agent-conversation-item-active" : ""}`}
                    key={run.id}
                    onClick={() => setSelectedAgentRunId(run.id)}
                    type="button"
                  >
                    <div>
                      <strong>{run.triggerType.replace("_", " ").toLowerCase()}</strong>
                      <span>{formatDateTime(run.startedAt)}</span>
                    </div>
                    <span className={`agent-status agent-status-${run.status.toLowerCase()}`}>
                      {run.status.toLowerCase()}
                    </span>
                    <p>{truncate(run.instruction, 120)}</p>
                  </button>
                ))
              )}
            </aside>

            <section className="agent-conversation-detail" aria-label="Selected agent history">
              {selectedAgentRun ? (
                <>
                  <div className="agent-detail-header">
                    <div>
                      <span className={`agent-status agent-status-${selectedAgentRun.status.toLowerCase()}`}>
                        {selectedAgentRun.status.toLowerCase()}
                      </span>
                      <h3>{selectedAgentRun.triggerType.replace("_", " ").toLowerCase()}</h3>
                      <p>{selectedAgentRun.instruction}</p>
                    </div>
                    <div className="agent-run-meta">
                      {selectedAgentRun.branchName ? <span>{selectedAgentRun.branchName}</span> : null}
                      {selectedAgentRun.workspacePath ? <span>{selectedAgentRun.workspacePath}</span> : null}
                      {selectedAgentRun.commitUrl ? (
                        <a href={selectedAgentRun.commitUrl} rel="noopener noreferrer" target="_blank">
                          Commit {selectedAgentRun.commitSha?.slice(0, 7)}
                        </a>
                      ) : selectedAgentRun.commitSha ? (
                        <span>Commit {selectedAgentRun.commitSha.slice(0, 7)}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="agent-event-timeline">
                    {(selectedAgentRun.events ?? []).length === 0 ? (
                      <div className="agent-event agent-event-agent">
                        {selectedAgentRun.progress ?? "Waiting for progress."}
                      </div>
                    ) : (
                      (selectedAgentRun.events ?? []).map((event) => (
                        <div className={`agent-event agent-event-${event.role}`} key={event.id}>
                          <div className="agent-event-meta">
                            <span>{event.role.replace("_", " ")}</span>
                            <span>{formatDateTime(event.createdAt)}</span>
                          </div>
                          <pre>{event.message}</pre>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-state">No agent conversation selected.</div>
              )}
            </section>
          </div>

          {canWriteComments ? (
            <div className="agent-compose">
              <textarea
                onChange={(event) => setAgentMessage(event.target.value)}
                placeholder="Message an agent about the document or linked repository"
                rows={3}
                value={agentMessage}
              />
              <button
                className="primary-button"
                disabled={agentBusy || !agentMessage.trim()}
                onClick={handleAgentConversation}
                type="button"
              >
                {agentBusy ? "Sending..." : "Send to agent"}
              </button>
            </div>
          ) : null}
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
