import { useEffect, useRef, useState } from "react";

import {
  filterMentionCandidates,
  findActiveMentionQuery,
  mentionHandle,
  type MentionCandidate
} from "@/lib/mentions";

// A controlled <textarea> with @mention autocomplete. Mentions are stored as
// plain "@Name" text (detected server-side by extractMentionedUserIds and
// highlighted on render by renderCommentHtml), so this only helps the user pick
// the right handle — it inserts text, no markup. Used by the comment composer,
// replies, and inline edits.
export function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  rows = 3,
  autoFocus,
  className,
  onSubmit
}: {
  value: string;
  onChange: (value: string) => void;
  members: MentionCandidate[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
  // Called on Cmd/Ctrl+Enter (the dropdown intercepts a bare Enter when open).
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [items, setItems] = useState<MentionCandidate[]>([]);
  const [index, setIndex] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const open = range !== null && items.length > 0;
  const openRef = useRef(open);
  openRef.current = open;

  function refresh(caret: number, text: string) {
    if (members.length === 0) {
      setRange(null);
      return;
    }
    const active = findActiveMentionQuery(text, caret);
    if (!active) {
      setRange(null);
      return;
    }
    const matches = filterMentionCandidates(active.query, members);
    if (matches.length === 0) {
      setRange(null);
      return;
    }
    setItems(matches);
    setRange({ start: active.start, end: active.end });
    setIndex((current) => (current < matches.length ? current : 0));
  }

  function select(candidate: MentionCandidate) {
    if (!range) return;
    const handle = mentionHandle(candidate);
    const next = `${value.slice(0, range.start)}@${handle} ${value.slice(range.end)}`;
    const caret = range.start + handle.length + 2; // after "@handle "
    onChange(next);
    setRange(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  // Keep suggestions in sync when the caret moves without a value change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCaret = () => refresh(el.selectionStart ?? 0, el.value);
    el.addEventListener("keyup", onCaret);
    el.addEventListener("click", onCaret);
    return () => {
      el.removeEventListener("keyup", onCaret);
      el.removeEventListener("click", onCaret);
    };
  }, [members, value, range]);

  return (
    <div className="mention-textarea-wrap">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        className={className}
        placeholder={placeholder}
        rows={rows}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          refresh(event.target.selectionStart ?? event.target.value.length, event.target.value);
        }}
        onKeyDown={(event) => {
          if (openRef.current) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => (current + 1) % items.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => (current - 1 + items.length) % items.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              select(items[index]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setRange(null);
              return;
            }
          }
          if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        onBlur={() => {
          // Let a click on an option register before closing.
          window.setTimeout(() => setRange(null), 120);
        }}
      />
      {open ? (
        <div className="mention-suggest mention-suggest-textarea" role="listbox">
          {items.map((candidate, itemIndex) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={itemIndex === index}
              className={`mention-suggest-item${itemIndex === index ? " mention-suggest-item-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                select(candidate);
              }}
              onMouseEnter={() => setIndex(itemIndex)}
            >
              <span className="mention-suggest-name">{candidate.name || candidate.email}</span>
              {candidate.name && candidate.email ? (
                <span className="mention-suggest-email">{candidate.email}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
