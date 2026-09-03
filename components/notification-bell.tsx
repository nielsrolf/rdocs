"use client";

import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_COMMENT_NOTIFICATION_SCOPE,
  type CommentNotificationScope
} from "@/lib/notification-preferences";

// The bell used on documents, forum posts and quick takes. It sets a
// PER-ITEM comment-notification override (or clears it, falling back to the
// user's default from /settings/notifications).

async function patchNotificationSettings(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch("/api/user/notification-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch {
    return false;
  }
}

const OPTIONS: Array<{ value: CommentNotificationScope | null; label: string }> = [
  { value: null, label: "Use my default" },
  { value: "all", label: "All comments" },
  { value: "participating", label: "Only threads I'm in" },
  { value: "none", label: "None" }
];

function bellGlyph(effective: CommentNotificationScope) {
  return effective === "none" ? "🔕" : "🔔";
}

export function CommentNotificationBell({
  documentId,
  initialScope,
  defaultScope = DEFAULT_COMMENT_NOTIFICATION_SCOPE,
  compact = false
}: {
  documentId: string;
  /** The per-item override, or null when the item follows the user default. */
  initialScope: CommentNotificationScope | null;
  defaultScope?: CommentNotificationScope;
  compact?: boolean;
}) {
  const [scope, setScope] = useState<CommentNotificationScope | null>(initialScope);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const effective = scope ?? defaultScope;

  async function choose(next: CommentNotificationScope | null) {
    const previous = scope;
    setScope(next);
    setOpen(false);
    setBusy(true);
    const ok = await patchNotificationSettings({
      documentCommentPreference: { documentId, scope: next }
    });
    setBusy(false);
    if (!ok) setScope(previous);
  }

  return (
    <span className="notification-bell" ref={wrapRef}>
      <button
        aria-label="Comment notifications"
        className={compact ? "ghost-button quicktake-action" : "ghost-button header-toggle-button"}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        title={`Comment notifications: ${OPTIONS.find((option) => option.value === scope)?.label ?? "Use my default"}`}
        type="button"
      >
        {bellGlyph(effective)}
      </button>
      {open ? (
        <span className="notification-bell-menu">
          {OPTIONS.map((option) => (
            <button
              className="notification-bell-option"
              key={option.label}
              onClick={() => void choose(option.value)}
              type="button"
            >
              {option.value === scope ? "✓ " : ""}
              {option.label}
              {option.value === null ? ` (${defaultScope === "none" ? "none" : defaultScope === "all" ? "all comments" : "threads I'm in"})` : ""}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

// The bell on the forum / quick-takes index: a plain on-off switch for DMs
// about NEW posts and quick takes.
export function ForumPostNotificationBell({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setBusy(true);
    const ok = await patchNotificationSettings({ forumPostSlackNotifications: next });
    setBusy(false);
    if (!ok) setEnabled(!next);
  }

  return (
    <button
      aria-label="Notifications for new posts"
      className="ghost-button header-toggle-button"
      disabled={busy}
      onClick={() => void toggle()}
      title={
        enabled
          ? "Slack DM when someone posts a new forum post or quick take — click to turn off"
          : "No Slack DM for new posts — click to turn on"
      }
      type="button"
    >
      {enabled ? "🔔" : "🔕"}
    </button>
  );
}
