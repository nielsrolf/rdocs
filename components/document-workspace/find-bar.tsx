import { useEffect, useReducer, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";

import {
  getSearchState,
  replaceAllMatches,
  replaceCurrentMatch,
  setSearchQuery,
  stepSearch
} from "./search";

// In-document find & replace bar. Replacements go through the editor's normal
// transactions, so they persist via the collaboration pipeline like any edit.
export function FindBar({
  editor,
  canReplace,
  onClose
}: {
  editor: Editor;
  canReplace: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [, forceTick] = useReducer((n: number) => n + 1, 0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-render on editor transactions so the match count stays current.
  useEffect(() => {
    const handler = () => forceTick();
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);

  // Push the query into the search plugin whenever it changes.
  useEffect(() => {
    setSearchQuery(editor.state, editor.view.dispatch, query, false);
  }, [editor, query]);

  // Focus on open; clear the highlights on close.
  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      setSearchQuery(editor.state, editor.view.dispatch, "", false);
    };
  }, [editor]);

  const search = getSearchState(editor.state);
  const matchCount = search?.matches.length ?? 0;
  const activeLabel = matchCount === 0 ? "0/0" : `${(search?.activeIndex ?? 0) + 1}/${matchCount}`;

  return (
    <div
      className="find-bar"
      role="dialog"
      aria-label="Find and replace"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="find-bar-row">
        <input
          ref={inputRef}
          className="find-bar-input"
          placeholder="Find"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              stepSearch(editor.state, editor.view.dispatch, event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="find-bar-count" aria-live="polite">
          {activeLabel}
        </span>
        <button
          className="ghost-button"
          disabled={matchCount === 0}
          onClick={() => stepSearch(editor.state, editor.view.dispatch, -1)}
          type="button"
          aria-label="Previous match"
        >
          ↑
        </button>
        <button
          className="ghost-button"
          disabled={matchCount === 0}
          onClick={() => stepSearch(editor.state, editor.view.dispatch, 1)}
          type="button"
          aria-label="Next match"
        >
          ↓
        </button>
        <button className="ghost-button" onClick={onClose} type="button" aria-label="Close find">
          ✕
        </button>
      </div>

      {canReplace ? (
        <div className="find-bar-row">
          <input
            className="find-bar-input"
            placeholder="Replace"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
          <button
            className="ghost-button"
            disabled={matchCount === 0}
            onClick={() => replaceCurrentMatch(editor.state, editor.view.dispatch, replacement)}
            type="button"
          >
            Replace
          </button>
          <button
            className="ghost-button"
            disabled={matchCount === 0}
            onClick={() => replaceAllMatches(editor.state, editor.view.dispatch, replacement)}
            type="button"
          >
            All
          </button>
        </div>
      ) : null}
    </div>
  );
}
