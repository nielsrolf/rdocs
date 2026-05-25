import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

type OutlineEntry = {
  index: number;
  level: number;
  text: string;
  slug: string;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const OUTLINE_MIN_WIDTH = 160;
export const OUTLINE_MAX_WIDTH = 420;

export function DocOutline({
  editor,
  collapsed,
  width,
  onToggleCollapsed,
  onWidthChange
}: {
  editor: Editor | null;
  collapsed: boolean;
  width: number;
  onToggleCollapsed: () => void;
  onWidthChange: (next: number) => void;
}) {
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [entries, setEntries] = useState<OutlineEntry[]>([]);

  useEffect(() => {
    if (!editor) {
      setEntries([]);
      return;
    }

    function refresh() {
      if (!editor) {
        return;
      }

      const next: OutlineEntry[] = [];
      const slugCounts = new Map<string, number>();
      let index = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name !== "heading") {
          return;
        }
        const level = typeof node.attrs.level === "number" ? node.attrs.level : 1;
        const text = node.textContent.trim();
        const display = text || "Untitled section";
        const baseSlug = slugify(text) || `section-${index + 1}`;
        const seen = slugCounts.get(baseSlug) ?? 0;
        slugCounts.set(baseSlug, seen + 1);
        const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;
        next.push({
          index: index++,
          level,
          text: display,
          slug
        });
      });
      setEntries(next);
    }

    refresh();
    editor.on("update", refresh);
    editor.on("selectionUpdate", refresh);

    return () => {
      editor.off("update", refresh);
      editor.off("selectionUpdate", refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!dragging) {
      return;
    }

    function handleMove(event: MouseEvent) {
      const state = dragStateRef.current;
      if (!state) {
        return;
      }
      const delta = event.clientX - state.startX;
      const next = Math.min(OUTLINE_MAX_WIDTH, Math.max(OUTLINE_MIN_WIDTH, state.startWidth + delta));
      onWidthChange(next);
    }

    function handleUp() {
      dragStateRef.current = null;
      setDragging(false);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onWidthChange]);

  function handleResizeDown(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    dragStateRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  }

  function handleResizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(Math.max(OUTLINE_MIN_WIDTH, width - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(Math.min(OUTLINE_MAX_WIDTH, width + step));
    }
  }

  function scrollToHeading(entry: OutlineEntry) {
    if (!editor) {
      return;
    }

    let currentPos: number | null = null;
    let seen = 0;
    editor.state.doc.descendants((node, pos) => {
      if (currentPos != null) return false;
      if (node.type.name !== "heading") return;
      if (seen === entry.index) {
        currentPos = pos;
        return false;
      }
      seen += 1;
    });

    if (currentPos == null) {
      return;
    }

    const inside = Math.min(currentPos + 1, editor.state.doc.content.size);
    editor.commands.focus();
    editor.commands.setTextSelection(inside);
    const coords = editor.view.coordsAtPos(inside);
    const targetY = window.scrollY + coords.top - 96;
    window.scrollTo({ top: targetY, behavior: "smooth" });
  }

  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  async function copyHeadingLink(entry: OutlineEntry) {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${entry.slug}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy heading link:", url);
    }
    setCopiedSlug(entry.slug);
    window.setTimeout(() => {
      setCopiedSlug((current) => (current === entry.slug ? null : current));
    }, 1500);
  }

  useEffect(() => {
    if (!editor || typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    if (entries.length === 0) return;
    const match: OutlineEntry | undefined = entries.find((entry) => entry.slug === hash);
    if (!match) return;
    const target: OutlineEntry = match;
    const dedupKey = `${window.location.pathname}#${hash}`;
    const w = window as unknown as { __gdocsLastHashKey?: string };
    if (w.__gdocsLastHashKey === dedupKey) return;
    w.__gdocsLastHashKey = dedupKey;

    // Layout settles after images/widgets load — re-scroll a few times so the
    // user ends up on the right heading even if content above grows.
    const delays = [0, 250, 800, 2000];
    const timers: number[] = [];
    for (const delay of delays) {
      timers.push(window.setTimeout(() => scrollToHeading(target), delay));
    }
    function onWindowLoad() {
      scrollToHeading(target);
    }
    window.addEventListener("load", onWindowLoad, { once: true });
    return () => {
      for (const id of timers) window.clearTimeout(id);
      window.removeEventListener("load", onWindowLoad);
    };
  }, [editor, entries]);

  if (collapsed) {
    return (
      <aside className="doc-outline doc-outline-collapsed" aria-label="Document outline">
        <button
          aria-label="Show document outline"
          className="doc-outline-toggle"
          onClick={onToggleCollapsed}
          title="Show outline"
          type="button"
        >
          <OutlineIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="doc-outline" aria-label="Document outline">
      <div className="doc-outline-inner">
        <header className="doc-outline-header">
          <strong>Outline</strong>
          <button
            aria-label="Hide document outline"
            className="doc-outline-toggle"
            onClick={onToggleCollapsed}
            title="Hide outline"
            type="button"
          >
            <ChevronLeftIcon />
          </button>
        </header>
        {entries.length === 0 ? (
          <p className="doc-outline-empty">Add headings to navigate this document.</p>
        ) : (
          <ul className="doc-outline-list">
            {entries.map((entry) => (
              <li key={`${entry.index}-${entry.level}-${entry.text}`} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 0.85}rem` }}>
                <div className="doc-outline-row">
                  <button
                    className={`doc-outline-item doc-outline-item-level-${Math.min(entry.level, 6)}`}
                    onClick={() => scrollToHeading(entry)}
                    title={entry.text}
                    type="button"
                  >
                    {entry.text}
                  </button>
                  <button
                    aria-label={`Copy link to ${entry.text}`}
                    className="doc-outline-copy"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyHeadingLink(entry);
                    }}
                    title={copiedSlug === entry.slug ? "Copied!" : "Copy link to heading"}
                    type="button"
                  >
                    {copiedSlug === entry.slug ? <CheckIcon /> : <LinkIcon />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        aria-label="Resize outline sidebar"
        aria-valuemax={OUTLINE_MAX_WIDTH}
        aria-valuemin={OUTLINE_MIN_WIDTH}
        aria-valuenow={Math.round(width)}
        className={`doc-outline-resize ${dragging ? "doc-outline-resize-active" : ""}`}
        onKeyDown={handleResizeKey}
        onMouseDown={handleResizeDown}
        role="separator"
        tabIndex={0}
        title="Drag to resize outline"
      />
    </aside>
  );
}

function OutlineIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="16" viewBox="0 0 16 16" width="16">
      <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="13" viewBox="0 0 16 16" width="13">
      <path
        d="M6.5 9.5L9.5 6.5M6 4.5h-1a3 3 0 100 6h1m4-6h1a3 3 0 110 6h-1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="13" viewBox="0 0 16 16" width="13">
      <path
        d="M3.5 8.5l3 3 6-6.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="14" viewBox="0 0 16 16" width="14">
      <path
        d="M10 3l-5 5 5 5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}
