"use client";

import { useEffect, useState } from "react";

import { RichCommentEditor } from "@/components/rich-comment-editor";
import type { MentionCandidate } from "@/lib/mentions";

let candidateCache: MentionCandidate[] | null = null;

// Forum composer (comments, replies, quicktakes): the rich comment editor
// with forum-wide mention candidates. Cmd/Ctrl+Enter submits the enclosing
// form. `maxLength` is enforced by the API (the editor stores markdown, whose
// length the user does not see directly).
export function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows,
  disabled
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
  disabled?: boolean;
  maxLength?: number;
}) {
  const [candidates, setCandidates] = useState<MentionCandidate[]>(candidateCache ?? []);

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
    return () => {
      alive = false;
    };
  }, []);

  return (
    <RichCommentEditor
      className="forum-mention-input"
      disabled={disabled}
      members={candidates}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      value={value}
    />
  );
}
