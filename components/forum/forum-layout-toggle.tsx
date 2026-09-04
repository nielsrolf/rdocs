"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ForumLayout } from "@/lib/forum-layout";

const OPTIONS: Array<{ value: ForumLayout; label: string; title: string }> = [
  { value: "unified", label: "Feed", title: "Posts and quick takes in one ranked feed" },
  { value: "split", label: "Sections", title: "Quick takes above, posts below" }
];

// Segmented control for the forum frontpage layout. Persists via
// PATCH /api/user/forum-layout (cookie for everyone, account setting when
// signed in) and re-renders the server page.
export function ForumLayoutToggle({ value }: { value: ForumLayout }) {
  const router = useRouter();
  const [current, setCurrent] = useState<ForumLayout>(value);
  const [saving, setSaving] = useState(false);

  async function choose(next: ForumLayout) {
    if (next === current || saving) return;
    const previous = current;
    setCurrent(next);
    setSaving(true);
    try {
      const response = await fetch("/api/user/forum-layout", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: next })
      });
      if (!response.ok) {
        setCurrent(previous);
        return;
      }
      router.refresh();
    } catch {
      setCurrent(previous);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="forum-layout-toggle" role="radiogroup" aria-label="Forum layout">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={current === option.value}
          title={option.title}
          className={
            current === option.value
              ? "forum-layout-toggle-option forum-layout-toggle-option-active"
              : "forum-layout-toggle-option"
          }
          disabled={saving}
          onClick={() => choose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
