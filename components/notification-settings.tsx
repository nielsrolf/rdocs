"use client";

import { useState } from "react";

import type { CommentNotificationScope } from "@/lib/notification-preferences";

type Settings = {
  commentNotificationScope: CommentNotificationScope;
  documentShareSlackNotifications: boolean;
  forumShareSlackNotifications: boolean;
  forumPostSlackNotifications: boolean;
};

type ToggleKey = Exclude<keyof Settings, "commentNotificationScope">;

const SCOPE_OPTIONS: Array<{ value: CommentNotificationScope; label: string }> = [
  { value: "participating", label: "Only threads I'm involved in" },
  { value: "all", label: "Every comment I can see" },
  { value: "none", label: "None" }
];

export function NotificationSettings({
  initialSettings,
  slackLinked
}: {
  initialSettings: Settings;
  slackLinked: boolean;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(payload: Record<string, unknown>) {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/user/notification-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not update notification settings.");
        return false;
      }
      setSaved(true);
      return true;
    } catch {
      setError("Could not update notification settings.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function updateSetting(key: ToggleKey, enabled: boolean) {
    const previous = settings[key];
    setSettings((current) => ({ ...current, [key]: enabled }));
    if (!(await patch({ [key]: enabled }))) {
      setSettings((current) => ({ ...current, [key]: previous }));
    }
  }

  async function updateScope(scope: CommentNotificationScope) {
    const previous = settings.commentNotificationScope;
    setSettings((current) => ({ ...current, commentNotificationScope: scope }));
    if (!(await patch({ commentNotificationScope: scope }))) {
      setSettings((current) => ({ ...current, commentNotificationScope: previous }));
    }
  }

  const toggles: Array<{ key: ToggleKey; title: string; description: string }> = [
    {
      key: "forumPostSlackNotifications",
      title: "New forum posts and quick takes",
      description: "Notify me when someone posts a new forum post or quick take I can read."
    },
    {
      key: "forumShareSlackNotifications",
      title: "Forum items shared with a group",
      description: "Notify me when an existing document is shared to the forum with a group I belong to."
    },
    {
      key: "documentShareSlackNotifications",
      title: "Documents shared with me",
      description: "Notify me when someone gives me direct or group access to a document."
    }
  ];

  return (
    <section className="credentials-section">
      <strong className="credentials-section-title">Slack direct messages</strong>
      <p className="muted-copy">Choose which activity should send you a Slack DM.</p>

      <label className="quicktake-visibility-select">
        <span>
          <strong>Default for comments</strong>
          <br />
          <span className="muted-copy">
            Applies to documents and quick takes without their own setting. &quot;Only threads I&apos;m involved
            in&quot; means comments on my own items, threads I started or replied in, and mentions of me. The bell on a
            document or quick take overrides this for that item.
          </span>
        </span>{" "}
        <select
          disabled={saving || !slackLinked}
          onChange={(event) => void updateScope(event.target.value as CommentNotificationScope)}
          value={settings.commentNotificationScope}
        >
          {SCOPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {toggles.map((toggle) => (
        <label className="quicktake-visibility-select" key={toggle.key}>
          <input
            checked={settings[toggle.key]}
            disabled={saving || !slackLinked}
            onChange={(event) => void updateSetting(toggle.key, event.target.checked)}
            type="checkbox"
          />{" "}
          <span><strong>{toggle.title}</strong><br /><span className="muted-copy">{toggle.description}</span></span>
        </label>
      ))}

      {!slackLinked ? <p className="muted-copy">Connect your Slack account first to enable notifications.</p> : null}
      {saving ? <p className="muted-copy">Saving…</p> : null}
      {saved && !saving ? <p className="muted-copy">Saved.</p> : null}
      {error ? <p className="muted-copy forum-settings-error">{error}</p> : null}
    </section>
  );
}
