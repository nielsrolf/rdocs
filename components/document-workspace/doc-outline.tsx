import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

type OutlineEntry = {
  id: string;
  level: number;
  text: string;
  pos: number;
};

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
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "heading") {
          return;
        }
        const level = typeof node.attrs.level === "number" ? node.attrs.level : 1;
        const text = node.textContent.trim();
        next.push({
          id: `${pos}-${level}`,
          level,
          text: text || "Untitled section",
          pos
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

    const inside = Math.min(entry.pos + 1, editor.state.doc.content.size);
    editor.commands.focus();
    editor.commands.setTextSelection(inside);

    try {
      const coords = editor.view.coordsAtPos(inside);
      const targetY = window.scrollY + coords.top - 96;
      window.scrollTo({ top: targetY, behavior: "smooth" });
    } catch {
      // Position may be stale if doc just changed.
    }
  }

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
              <li key={entry.id} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 0.85}rem` }}>
                <button
                  className={`doc-outline-item doc-outline-item-level-${Math.min(entry.level, 6)}`}
                  onClick={() => scrollToHeading(entry)}
                  title={entry.text}
                  type="button"
                >
                  {entry.text}
                </button>
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
