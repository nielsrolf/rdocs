"use client";

import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState, type RefObject } from "react";

type HeadingInfo = {
  pos: number;
  level: number;
  slug: string;
  text: string;
};

type OverlayState = {
  slug: string;
  text: string;
  left: number;
  top: number;
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

export function HeadingCopyOverlay({
  editor,
  containerRef
}: {
  editor: Editor | null;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const headingsRef = useRef<HeadingInfo[]>([]);
  const [hovered, setHovered] = useState<OverlayState | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!editor) return;

    function refresh() {
      if (!editor) return;
      const next: HeadingInfo[] = [];
      const counts = new Map<string, number>();
      let index = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "heading") return;
        const level = typeof node.attrs.level === "number" ? node.attrs.level : 1;
        const text = node.textContent.trim();
        const base = slugify(text) || `section-${index + 1}`;
        const seen = counts.get(base) ?? 0;
        counts.set(base, seen + 1);
        const slug = seen === 0 ? base : `${base}-${seen + 1}`;
        next.push({ pos, level, slug, text: text || "Untitled section" });
        index += 1;
      });
      headingsRef.current = next;
    }

    refresh();
    editor.on("update", refresh);
    editor.on("transaction", refresh);
    return () => {
      editor.off("update", refresh);
      editor.off("transaction", refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || !containerRef.current) return;
    const root = containerRef.current.querySelector(".gdocs-prosemirror") as HTMLElement | null;
    if (!root) return;

    function findHeadingFor(el: Element): HTMLElement | null {
      const heading = el.closest("h1, h2, h3, h4, h5, h6");
      if (!heading) return null;
      if (!root!.contains(heading)) return null;
      return heading as HTMLElement;
    }

    function handleMove(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        setHovered(null);
        return;
      }
      const headingEl = findHeadingFor(target);
      if (!headingEl || !containerRef.current || !editor) {
        return;
      }
      let pos: number | null = null;
      try {
        const result = editor.view.posAtDOM(headingEl, 0);
        pos = typeof result === "number" ? result : null;
      } catch {
        pos = null;
      }
      if (pos == null) return;

      let match: HeadingInfo | null = null;
      for (const h of headingsRef.current) {
        if (h.pos <= pos && pos <= h.pos + 1 + (h.text.length + 1)) {
          match = h;
          break;
        }
      }
      if (!match) {
        // fallback: closest by pos
        let best: HeadingInfo | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const h of headingsRef.current) {
          const delta = Math.abs(h.pos - pos);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = h;
          }
        }
        match = best;
      }
      if (!match) return;

      const pageRect = containerRef.current.getBoundingClientRect();
      const headingRect = headingEl.getBoundingClientRect();
      setHovered({
        slug: match.slug,
        text: match.text,
        left: headingRect.right - pageRect.left + 8,
        top: headingRect.top - pageRect.top + headingRect.height / 2 - 12
      });
    }

    function handleLeave(event: MouseEvent) {
      const next = event.relatedTarget as Node | null;
      if (next && (root!.contains(next) || containerRef.current?.contains(next))) {
        return;
      }
      setHovered(null);
    }

    root.addEventListener("mousemove", handleMove);
    root.addEventListener("mouseleave", handleLeave);
    return () => {
      root.removeEventListener("mousemove", handleMove);
      root.removeEventListener("mouseleave", handleLeave);
    };
  }, [editor, containerRef]);

  if (!hovered || !editor) return null;

  async function handleCopy() {
    if (!hovered || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${hovered.slug}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy heading link:", url);
    }
    setCopiedSlug(hovered.slug);
    window.setTimeout(() => {
      setCopiedSlug((current) => (current === hovered.slug ? null : current));
    }, 1500);
  }

  const isCopied = copiedSlug === hovered.slug;

  return (
    <button
      aria-label={`Copy link to ${hovered.text}`}
      className="heading-copy-button"
      onClick={handleCopy}
      onMouseEnter={() => setHovered(hovered)}
      style={{ left: hovered.left, top: hovered.top }}
      title={isCopied ? "Copied!" : "Copy link to heading"}
      type="button"
    >
      {isCopied ? (
        <svg aria-hidden="true" focusable="false" height="14" viewBox="0 0 16 16" width="14">
          <path
            d="M3.5 8.5l3 3 6-6.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      ) : (
        <svg aria-hidden="true" focusable="false" height="14" viewBox="0 0 16 16" width="14">
          <path
            d="M6.5 9.5L9.5 6.5M6 4.5h-1a3 3 0 100 6h1m4-6h1a3 3 0 110 6h-1"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      )}
    </button>
  );
}
