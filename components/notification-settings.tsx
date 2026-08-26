"use client";

import { useState } from "react";

type Settings = {
  commentSlackNotifications: boolean;
  documentShareSlackNotifications: boolean;
  forumShareSlackNotifications: boolean;
};

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

  async function updateSetting(key: keyof Settings, enabled: boolean) {
    const previous = settings[key];
    setSettings((current) => ({ ...current, [key]: enabled }));
    if (!(await patch({ [key]: enabled }))) {
      setSettings((current) => ({ ...current, [key]: previous }));
    }
  }

  const toggles: Array<{ key: keyof Settings; title: string; description: string }> = [
    {
      key: "forumShareSlackNotifications",
      title: "Forum posts and quick takes",
      description: "Notify me when a new forum post or quick take is shared with a group I belong to."
    },
    {
      key: "documentShareSlackNotifications",
      title: "Documents shared with me",
      description: "Notify me when someone gives me direct or group access to a document."
    },
    {
      key: "commentSlackNotifications",
      title: "Default for document comments",
      description: "Choose whether the notification button starts on or off for documents without an override."
    }
  ];

  return (
    <section className="credentials-section">
      <strong className="credentials-section-title">Slack direct messages</strong>
      <p className="muted-copy">Choose which activity should send you a Slack DM.</p>
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
