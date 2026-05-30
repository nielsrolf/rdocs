"use client";

import { useRef } from "react";

export function ExportMenu({
  documentId,
  shareToken
}: {
  documentId: string;
  shareToken: string | null;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const base = `/api/documents/${documentId}/export`;
  const shareSuffix = shareToken ? `&share=${encodeURIComponent(shareToken)}` : "";
  const markdownHref = `${base}?format=markdown${shareSuffix}`;
  const overleafHref = `${base}?format=latex${shareSuffix}`;

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <details className="header-menu header-menu-export" ref={detailsRef}>
      <summary>Export</summary>
      <div className="header-menu-panel file-menu-panel">
        <a className="file-menu-item" download href={markdownHref} onClick={close}>
          <span className="file-menu-item-label">Markdown</span>
          <span className="file-menu-item-hint">.md</span>
        </a>
        <a className="file-menu-item" download href={overleafHref} onClick={close}>
          <span className="file-menu-item-label">Overleaf</span>
          <span className="file-menu-item-hint">LaTeX .zip</span>
        </a>
      </div>
    </details>
  );
}
