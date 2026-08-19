"use client";

import { useState } from "react";

// Notifications section of the settings page. Currently one setting: Slack DM
// notifications for new comments/replies on documents the user owns or
// collaborates on (User.commentSlackNotifications, read by
// lib/comment-notifications.ts when fanning out a posted comment).
export function NotificationSettings({
  initialEnabled,
  slackLinked
}: {
  initialEnabled: boolean;
  slackLinked: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/user/notification-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentSlackNotifications: next })
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setEnabled(previous);
        setError(data?.error ?? "Could not update the notification setting.");
        return;
      }
      setSaved(true);
    } catch {
      setEnabled(previous);
      setError("Could not update the notification setting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="credentials-section">
      <strong className="credentials-section-title">Comment notifications</strong>
      <p className="muted-copy">
        Get a Slack direct message when someone comments on a document you own or
        collaborate on. Replying in the Slack thread posts your reply into the
        document&apos;s comment thread; mention the bot to bring in the AI.
      </p>
      <label className="quicktake-visibility-select">
        <input
          checked={enabled}
          disabled={saving || !slackLinked}
          onChange={(event) => update(event.target.checked)}
          type="checkbox"
        />{" "}
        Send me Slack DMs for new comments and replies
      </label>
      {!slackLinked ? (
        <p className="muted-copy">
          Connect your Slack account first — open a document&apos;s agent settings or
          use the Slack connect link from your workspace to link it.
        </p>
      ) : null}
      {saving ? <p className="muted-copy">Saving…</p> : null}
      {saved && !saving ? <p className="muted-copy">Saved.</p> : null}
      {error ? <p className="muted-copy forum-settings-error">{error}</p> : null}
    </section>
  );
}
