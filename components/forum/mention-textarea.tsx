"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  filterMentionCandidates,
  findActiveMentionQuery,
  mentionHandle,
  type MentionCandidate
} from "@/lib/mentions";

let candidateCache: MentionCandidate[] | null = null;

export function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows,
  disabled,
  maxLength
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
  disabled?: boolean;
  maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>(candidateCache ?? []);
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (candidateCache) return;
    let alive = true;
    fetch("/api/forum/mention-candidates", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!Array.isArray(data?.candidates)) return;
        candidateCache = data.candidates;
        if (alive) setCandidates(data.candidates);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const active = useMemo(() => findActiveMentionQuery(value, caret), [value, caret]);
  const matches = useMemo(
    () => active ? filterMentionCandidates(active.query, candidates) : [],
    [active, candidates]
  );

  function choose(candidate: MentionCandidate) {
    if (!active) return;
    const next = `${value.slice(0, active.start)}@${mentionHandle(candidate)} ${value.slice(active.end)}`;
    const nextCaret = active.start + mentionHandle(candidate).length + 2;
    onChange(next);
    setCaret(nextCaret);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  return (
    <div className="forum-mention-input">
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setActiveIndex(0);
        }}
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (matches.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            choose(matches[activeIndex] ?? matches[0]);
          } else if (event.key === "Escape") {
            setCaret(-1);
          }
        }}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        maxLength={maxLength}
      />
      {matches.length > 0 ? (
        <div className="forum-mention-menu" role="listbox" aria-label="Tag a person">
          {matches.map((candidate, index) => (
            <button
              className={index === activeIndex ? "active" : ""}
              key={candidate.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(candidate)}
              role="option"
              type="button"
            >
              <strong>{candidate.name || candidate.email}</strong>
              {candidate.email && candidate.name ? <span>{candidate.email}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
