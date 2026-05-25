"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useState, type RefObject } from "react";

type PopoverState = {
  href: string;
  left: number;
  top: number;
};

export function LinkPopover({
  editor,
  containerRef,
  canEdit
}: {
  editor: Editor | null;
  containerRef: RefObject<HTMLDivElement | null>;
  canEdit: boolean;
}) {
  const [state, setState] = useState<PopoverState | null>(null);

  useEffect(() => {
    if (!editor) {
      setState(null);
      return;
    }

    function refresh() {
      if (!editor || !containerRef.current) {
        setState(null);
        return;
      }
      const view = editor.view;
      if (!view.hasFocus() && editor.state.selection.empty) {
        // still show when cursor is inside link even without explicit focus,
        // but skip if there's truly nothing to anchor to
      }

      if (!editor.isActive("link")) {
        setState(null);
        return;
      }

      const href = (editor.getAttributes("link") as { href?: string }).href;
      if (!href) {
        setState(null);
        return;
      }

      const { from } = editor.state.selection;
      let coords: { left: number; top: number; bottom: number };
      try {
        coords = view.coordsAtPos(from);
      } catch {
        setState(null);
        return;
      }

      const pageRect = containerRef.current.getBoundingClientRect();
      setState({
        href,
        left: Math.max(8, coords.left - pageRect.left),
        top: coords.bottom - pageRect.top + 6
      });
    }

    refresh();
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    editor.on("focus", refresh);
    editor.on("blur", refresh);

    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
      editor.off("focus", refresh);
      editor.off("blur", refresh);
    };
  }, [editor, containerRef]);

  if (!state || !editor) {
    return null;
  }

  function handleEdit() {
    if (!editor) return;
    const current = (editor.getAttributes("link") as { href?: string }).href ?? "";
    const next = window.prompt("Edit link URL", current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
  }

  function handleRemove() {
    if (!editor) return;
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }

  const display = state.href.length > 48 ? `${state.href.slice(0, 47)}…` : state.href;

  return (
    <div className="link-popover" style={{ left: state.left, top: state.top }}>
      <a
        className="link-popover-url"
        href={state.href}
        rel="noopener noreferrer"
        target="_blank"
        title={state.href}
      >
        {display}
      </a>
      <a
        className="link-popover-button"
        href={state.href}
        rel="noopener noreferrer"
        target="_blank"
        title="Open in new tab"
      >
        Open
      </a>
      {canEdit ? (
        <>
          <button className="link-popover-button" onClick={handleEdit} type="button">
            Edit
          </button>
          <button className="link-popover-button" onClick={handleRemove} type="button">
            Remove
          </button>
        </>
      ) : null}
    </div>
  );
}
