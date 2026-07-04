import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

import {
  aiEditSelectionIdsAttributeSpec,
  attachmentChipAttributesSpec,
  commentThreadIdsAttributeSpec
} from "@/lib/document-schema-nodes";

import { resolveShareToken, withShareToken } from "./share-url";

function formatAttachmentSize(bytes: number) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function EmbeddedWidgetView({ deleteNode, editor, node, selected, updateAttributes }: NodeViewProps) {
  const [refreshing, setRefreshing] = useState(false);
  // The persisted attribute only distinguishes minimized vs. inline. Full-screen
  // is a transient viewing mode kept in local state — we don't want a document to
  // reopen with a widget covering the whole viewport.
  const collapsed = node.attrs.collapsed !== false;
  const inlineExpanded = !collapsed;
  const [fullscreen, setFullscreen] = useState(false);
  // The iframe is mounted whenever the widget is showing (inline or full-screen);
  // autosize only applies to the inline frame (full-screen fills via CSS).
  const showFrame = inlineExpanded || fullscreen;
  const showInlineFrame = inlineExpanded && !fullscreen;
  const mode = fullscreen ? "fullscreen" : inlineExpanded ? "inline" : "minimized";
  const [frameHeight, setFrameHeight] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastSelfResizeAtRef = useRef(0);
  const lastAppliedHeightRef = useRef(0);
  const widgetId = node.attrs.widgetId as string;
  const documentId = node.attrs.documentId as string;
  const label = (node.attrs.label as string) || "Interactive widget";
  const buildCmd = (node.attrs.buildCmd as string) || "";
  const embedSource = (node.attrs.embedSource as string) || "";
  // Prefer the node's baked shareToken; fall back to the page's ?share param so a
  // guest on a view/comment-only link can load a widget the owner created (whose
  // baked token is empty). Parity with RepoImageView / AttachmentChipView.
  const shareToken = resolveShareToken(
    node.attrs.shareToken as string | null,
    typeof window !== "undefined" ? window.location.search : ""
  );
  const src = withShareToken(
    (node.attrs.src as string) || `/api/documents/${documentId}/widgets/${widgetId}/source`,
    shareToken
  );

  useEffect(() => {
    window.requestAnimationFrame(resizeFrame);
  }, [showInlineFrame, src]);

  // Lock body scroll and wire Escape to exit while full-screen.
  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!showInlineFrame) return;
    const frame = iframeRef.current;
    if (!frame) return;

    let observer: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    function attachObservers() {
      const doc = frame?.contentDocument;
      if (!doc?.body) return;
      observer = new ResizeObserver(() => resizeFrame());
      observer.observe(doc.body);
      if (doc.documentElement) observer.observe(doc.documentElement);
      mutationObserver = new MutationObserver(() => resizeFrame());
      mutationObserver.observe(doc.body, { childList: true, subtree: true, attributes: true });
    }

    attachObservers();
    const onLoad = () => {
      observer?.disconnect();
      mutationObserver?.disconnect();
      attachObservers();
      resizeFrame();
    };
    frame.addEventListener("load", onLoad);

    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [showInlineFrame, src]);

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
    if (!showInlineFrame) {
      lastAppliedHeightRef.current = 0;
      setFrameHeight(0);
      return;
    }

    const frame = iframeRef.current;
    const body = frame?.contentDocument?.body;
    const documentElement = frame?.contentDocument?.documentElement;
    if (!frame || !body) return;

    // Suppress observer ticks that fire as a direct echo of our own resize.
    // Plotly/D3/etc. with autosize redraw to fill the iframe, which causes
    // scrollHeight to creep up by a few px on every tick — that feedback loop
    // is what was making widgets grow unboundedly over hundreds of frames.
    const sinceSelfResize = Date.now() - lastSelfResizeAtRef.current;

    const contentHeight = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      documentElement?.scrollHeight ?? 0,
      documentElement?.offsetHeight ?? 0
    );
    if (contentHeight <= 0) return;

    const frameClient = frame.clientHeight;
    const currentApplied = lastAppliedHeightRef.current;
    // If the body is just filling the iframe (i.e. content uses height:100% /
    // autosize), scrollHeight ~= clientHeight. Don't keep growing in that case.
    const realOverflow = contentHeight - frameClient;

    // Within ~400ms of our own resize, only accept changes that look like real
    // new content (a meaningful delta), not small autosize echoes.
    if (sinceSelfResize < 400 && Math.abs(contentHeight - currentApplied) < 32) {
      return;
    }

    // Only grow when there is actual overflow beyond the current iframe size.
    // Allow shrink only when content is clearly smaller than the iframe.
    let nextHeight = currentApplied;
    if (realOverflow > 4) {
      nextHeight = contentHeight + 4;
    } else if (contentHeight + 48 < currentApplied) {
      nextHeight = contentHeight + 4;
    } else if (currentApplied === 0) {
      // First measurement after mount/expand.
      nextHeight = contentHeight + 4;
    } else {
      return;
    }

    nextHeight = Math.max(0, Math.min(nextHeight, 8000));
    if (nextHeight === currentApplied) return;

    lastSelfResizeAtRef.current = Date.now();
    lastAppliedHeightRef.current = nextHeight;
    setFrameHeight(nextHeight);
  }

  function setMode(next: "minimized" | "inline" | "fullscreen") {
    if (next === "fullscreen") {
      setFullscreen(true);
      return;
    }
    setFullscreen(false);
    if ((next === "inline") === inlineExpanded) {
      // Persisted state already matches — just make sure the frame is sized.
      window.requestAnimationFrame(resizeFrame);
      return;
    }
    updateAttributes({ collapsed: next === "minimized" });
    window.requestAnimationFrame(resizeFrame);
  }

  return (
    <NodeViewWrapper
      className={`embedded-widget-node ${inlineExpanded ? "embedded-widget-node-expanded" : ""} ${
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
          <div className="embedded-widget-modes" role="group" aria-label="Widget view mode">
            <button
              className={`ghost-button ${mode === "minimized" ? "is-active" : ""}`}
              onClick={() => setMode("minimized")}
              type="button"
            >
              Minimize
            </button>
            <button
              className={`ghost-button ${mode === "inline" ? "is-active" : ""}`}
              onClick={() => setMode("inline")}
              type="button"
            >
              Inline
            </button>
            <button
              className={`ghost-button ${mode === "fullscreen" ? "is-active" : ""}`}
              onClick={() => setMode("fullscreen")}
              type="button"
            >
              Full screen
            </button>
          </div>
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
      {showFrame ? (
        <div className={`embedded-widget-stage ${fullscreen ? "embedded-widget-stage-fullscreen" : ""}`}>
          {fullscreen ? (
            <div className="embedded-widget-fullscreen-bar">
              <strong>{label}</strong>
              <div className="embedded-widget-actions">
                <button
                  className="ghost-button"
                  disabled={refreshing || !editor.isEditable}
                  onClick={refreshWidget}
                  type="button"
                >
                  {refreshing ? "Refreshing..." : "Refresh"}
                </button>
                <button className="ghost-button" onClick={() => setFullscreen(false)} type="button">
                  Exit full screen
                </button>
              </div>
            </div>
          ) : null}
          <iframe
            className="embedded-widget-frame"
            onLoad={resizeFrame}
            ref={iframeRef}
            sandbox="allow-scripts allow-same-origin"
            src={src}
            scrolling={fullscreen ? "auto" : "no"}
            style={fullscreen ? undefined : { height: frameHeight }}
            title={label}
          />
          {error ? <div className="embedded-widget-error">{error}</div> : null}
          {!fullscreen ? (
            <details className="embedded-widget-details">
              <summary>Build command</summary>
              <code>{buildCmd}</code>
            </details>
          ) : null}
        </div>
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
  // Fall back to the page's ?share param so a guest on a view/comment-only link
  // can load a repo image the owner created (whose baked URL has no token).
  const shareToken = resolveShareToken(null, typeof window !== "undefined" ? window.location.search : "");
  const src = withShareToken(rawSrc, shareToken);

  return (
    <NodeViewWrapper className="repo-image-node">
      <img alt={alt} src={src} title={caption ?? alt} />
      {caption ? <div className="repo-image-caption">{caption}</div> : null}
    </NodeViewWrapper>
  );
}

export const RepoImage = Node.create({
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
      },
      ...commentThreadIdsAttributeSpec,
      ...aiEditSelectionIdsAttributeSpec
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

function AttachmentChipView({ deleteNode, editor, node, selected }: NodeViewProps) {
  const attachmentId = (node.attrs.attachmentId as string | null) || null;
  const documentId = (node.attrs.documentId as string | null) || null;
  const fileName = (node.attrs.fileName as string) || "Attachment";
  const size = typeof node.attrs.size === "number" ? node.attrs.size : 0;
  const sizeLabel = formatAttachmentSize(size);

  // Prefer the explicit shareToken attr; fall back to the page's ?share param so
  // a guest viewing a shared link can still download (parity with RepoImageView).
  const shareToken = resolveShareToken(
    node.attrs.shareToken as string | null,
    typeof window !== "undefined" ? window.location.search : ""
  );

  const href =
    attachmentId && documentId
      ? `/api/documents/${documentId}/attachments/${attachmentId}${
          shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""
        }`
      : undefined;

  return (
    <NodeViewWrapper
      className={`attachment-chip-node ${selected ? "attachment-chip-node-selected" : ""}`}
      contentEditable={false}
      draggable
    >
      <a
        className="attachment-chip"
        download={fileName}
        href={href}
        rel="noreferrer"
        target="_blank"
        title={`Download ${fileName}`}
      >
        <span className="attachment-chip-icon" aria-hidden="true">
          📎
        </span>
        <span className="attachment-chip-body">
          <span className="attachment-chip-name">{fileName}</span>
          {sizeLabel ? <span className="attachment-chip-meta">{sizeLabel}</span> : null}
        </span>
      </a>
      {editor.isEditable ? (
        <button
          className="attachment-chip-remove"
          onClick={deleteNode}
          title="Remove attachment"
          type="button"
        >
          ×
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}

export const AttachmentChip = Node.create({
  name: "attachmentChip",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      ...attachmentChipAttributesSpec,
      ...commentThreadIdsAttributeSpec,
      ...aiEditSelectionIdsAttributeSpec
    };
  },
  parseHTML() {
    return [{ tag: "div[data-attachment-chip]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-attachment-chip": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentChipView);
  }
});

function TabBreakView({ node }: NodeViewProps) {
  const title = (node.attrs.title as string) || "Untitled tab";
  return (
    <NodeViewWrapper className="tab-break-node" contentEditable={false} data-tab-break>
      <div className="tab-break-marker">
        <span className="tab-break-label">Tab: {title}</span>
      </div>
    </NodeViewWrapper>
  );
}

export const TabBreak = Node.create({
  name: "tabBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  defining: true,
  addAttributes() {
    return {
      tabId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-tab-id") || "",
        renderHTML: (attributes) => {
          const id = typeof attributes.tabId === "string" ? attributes.tabId : "";
          return id ? { "data-tab-id": id } : {};
        }
      },
      title: {
        default: "Untitled tab",
        parseHTML: (element) => element.getAttribute("data-tab-title") || "Untitled tab",
        renderHTML: (attributes) => {
          const title = typeof attributes.title === "string" ? attributes.title : "Untitled tab";
          return { "data-tab-title": title };
        }
      }
    };
  },
  parseHTML() {
    return [{ tag: "div[data-tab-break]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-tab-break": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TabBreakView);
  }
});

export const EmbeddedWidget = Node.create({
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
      },
      ...commentThreadIdsAttributeSpec,
      ...aiEditSelectionIdsAttributeSpec
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
