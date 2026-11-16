"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";

import { formatDateTime } from "@/lib/utils";

import {
  suggestionAuthorKey,
  suggestionAuthors,
  type SuggestionOverview
} from "./suggestions";

function when(createdAt: string | null) {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "" : formatDateTime(date);
}

/**
 * The pending suggestions of a document: who suggested what. Author chips on
 * top filter the list; a row jumps to the suggestion in the text. Accept /
 * reject only for people with edit access.
 */
export function SuggestionReviewList({
  suggestions,
  canResolve,
  onAccept,
  onReject,
  onJump
}: {
  suggestions: SuggestionOverview[];
  canResolve: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onJump: (suggestion: SuggestionOverview) => void;
}) {
  const authors = useMemo(() => suggestionAuthors(suggestions), [suggestions]);
  const [authorKey, setAuthorKey] = useState<string | null>(null);
  // A filter whose author has no suggestions left falls back to everyone.
  const activeKey = authorKey && authors.some((author) => author.key === authorKey) ? authorKey : null;
  const visible = activeKey
    ? suggestions.filter((suggestion) => suggestionAuthorKey(suggestion.author) === activeKey)
    : suggestions;

  return (
    <>
      {authors.length > 1 ? (
        <div className="suggestion-review-authors" role="group" aria-label="Filter by author">
          <button
            aria-pressed={activeKey === null}
            className={`suggestion-author-chip${activeKey === null ? " is-active" : ""}`}
            onClick={() => setAuthorKey(null)}
            type="button"
          >
            Everyone ({suggestions.length})
          </button>
          {authors.map((author) => (
            <button
              aria-pressed={activeKey === author.key}
              className={`suggestion-author-chip${activeKey === author.key ? " is-active" : ""}`}
              key={author.key}
              onClick={() => setAuthorKey(activeKey === author.key ? null : author.key)}
              type="button"
            >
              {author.label} ({author.count})
            </button>
          ))}
        </div>
      ) : null}
      <ul className="suggestion-review-list">
        {visible.map((suggestion) => (
          <li className="suggestion-review-item" key={suggestion.id}>
            <button
              className="suggestion-review-jump"
              onClick={() => onJump(suggestion)}
              title="Show in the document"
              type="button"
            >
              <span className="suggestion-review-meta">
                <strong>{suggestion.author.authorLabel || "Unknown"}</strong>
                {` · ${suggestion.label}`}
                {when(suggestion.createdAt) ? ` · ${when(suggestion.createdAt)}` : ""}
              </span>
              <span className="suggestion-review-text">
                {suggestion.deletedText ? <del>{suggestion.deletedText}</del> : null}
                {suggestion.deletedText && suggestion.insertedText ? " → " : null}
                {suggestion.insertedText ? <ins>{suggestion.insertedText}</ins> : null}
              </span>
            </button>
            {canResolve ? (
              <span className="suggestion-review-actions">
                <button className="ghost-button" onClick={() => onAccept(suggestion.id)} type="button">
                  Accept
                </button>
                <button className="ghost-button" onClick={() => onReject(suggestion.id)} type="button">
                  Reject
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Hovering tracked-change text shows who suggested it. Reads the data
 * attributes the suggestion marks render, so it works for every viewer
 * (including read-only ones, who never get a caret inside a suggestion).
 */
export function SuggestionHoverLabel({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const [label, setLabel] = useState<{ text: string; left: number; top: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function onOver(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const mark = target?.closest<HTMLElement>("[data-suggestion-id]");
      if (!mark || !container?.contains(mark)) {
        setLabel(null);
        return;
      }
      const author = mark.getAttribute("data-suggestion-author-label") || "Unknown";
      const verb = mark.hasAttribute("data-suggested-deletion") ? "Deletion suggested" : "Suggested";
      const date = when(mark.getAttribute("data-suggestion-created"));
      const rect = mark.getClientRects()[0] ?? mark.getBoundingClientRect();
      setLabel({
        text: `${verb} by ${author}${date ? ` · ${date}` : ""}`,
        left: rect.left,
        top: rect.top
      });
    }
    const hide = () => setLabel(null);
    container.addEventListener("mouseover", onOver);
    container.addEventListener("mouseleave", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      container.removeEventListener("mouseover", onOver);
      container.removeEventListener("mouseleave", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [containerRef]);

  if (!label) return null;
  return (
    <div className="suggestion-hover-label" role="tooltip" style={{ left: label.left, top: label.top }}>
      {label.text}
    </div>
  );
}
