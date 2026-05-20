"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

type Layout = {
  cellLeft: number;
  cellRight: number;
  cellCenterX: number;
  rowTop: number;
  rowBottom: number;
  rowCenterY: number;
  tableTop: number;
  tableLeft: number;
};

export function TableInlineControls({
  editor,
  containerRef,
  enabled
}: {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!editor || !enabled) {
      setLayout(null);
      return;
    }

    const activeEditor = editor;

    function compute() {
      rafRef.current = null;
      const container = containerRef.current;
      if (!container || !activeEditor.isActive("table")) {
        setLayout(null);
        return;
      }

      const { from } = activeEditor.state.selection;
      const $from = activeEditor.state.doc.resolve(from);
      let cellPos: number | null = null;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
          cellPos = $from.before(depth);
          break;
        }
      }
      if (cellPos == null) {
        setLayout(null);
        return;
      }

      const cellDom = activeEditor.view.nodeDOM(cellPos) as HTMLElement | null;
      if (!cellDom) {
        setLayout(null);
        return;
      }
      const rowDom = cellDom.closest("tr");
      const tableDom = cellDom.closest("table");
      if (!rowDom || !tableDom) {
        setLayout(null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const cellRect = cellDom.getBoundingClientRect();
      const rowRect = rowDom.getBoundingClientRect();
      const tableRect = tableDom.getBoundingClientRect();

      setLayout({
        cellLeft: cellRect.left - containerRect.left,
        cellRight: cellRect.right - containerRect.left,
        cellCenterX: cellRect.left + cellRect.width / 2 - containerRect.left,
        rowTop: rowRect.top - containerRect.top,
        rowBottom: rowRect.bottom - containerRect.top,
        rowCenterY: rowRect.top + rowRect.height / 2 - containerRect.top,
        tableTop: tableRect.top - containerRect.top,
        tableLeft: tableRect.left - containerRect.left
      });
    }

    function schedule() {
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(compute);
    }

    schedule();
    activeEditor.on("selectionUpdate", schedule);
    activeEditor.on("update", schedule);
    activeEditor.on("focus", schedule);
    activeEditor.on("blur", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      activeEditor.off("selectionUpdate", schedule);
      activeEditor.off("update", schedule);
      activeEditor.off("focus", schedule);
      activeEditor.off("blur", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [editor, enabled, containerRef]);

  if (!editor || !enabled || !layout) return null;

  function run(action: () => void) {
    return (event: React.MouseEvent) => {
      event.preventDefault();
      action();
    };
  }

  return (
    <div className="table-inline-controls" aria-hidden="false">
      <button
        className="table-inline-btn table-inline-btn-del"
        style={{ left: layout.cellCenterX - 10, top: layout.tableTop - 24 }}
        onMouseDown={run(() => editor.chain().focus().deleteColumn().run())}
        title="Delete this column"
        aria-label="Delete column"
        type="button"
      >
        ×
      </button>
      <button
        className="table-inline-btn table-inline-btn-add"
        style={{ left: layout.cellRight - 9, top: layout.tableTop - 24 }}
        onMouseDown={run(() => editor.chain().focus().addColumnAfter().run())}
        title="Add column to the right"
        aria-label="Add column to the right"
        type="button"
      >
        +
      </button>
      <button
        className="table-inline-btn table-inline-btn-del"
        style={{ left: layout.tableLeft - 24, top: layout.rowCenterY - 10 }}
        onMouseDown={run(() => editor.chain().focus().deleteRow().run())}
        title="Delete this row"
        aria-label="Delete row"
        type="button"
      >
        ×
      </button>
      <button
        className="table-inline-btn table-inline-btn-add"
        style={{ left: layout.tableLeft - 24, top: layout.rowBottom - 9 }}
        onMouseDown={run(() => editor.chain().focus().addRowAfter().run())}
        title="Add row below"
        aria-label="Add row below"
        type="button"
      >
        +
      </button>
    </div>
  );
}
