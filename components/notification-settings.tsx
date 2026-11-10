"use client";

import { useState } from "react";

import type { CommentNotificationScope } from "@/lib/notification-preferences";

type Settings = {
  commentNotificationScope: CommentNotificationScope;
  documentShareSlackNotifications: boolean;
  forumShareSlackNotifications: boolean;
  forumPostSlackNotifications: boolean;
  // Which linked Slack workspace receives the DMs; null = the oldest link.
  notificationSlackTeamId: string | null;
};

type LinkedWorkspace = { teamId: string; teamName: string | null };

type ToggleKey = Exclude<keyof Settings, "commentNotificationScope" | "notificationSlackTeamId">;

const SCOPE_OPTIONS: Array<{ value: CommentNotificationScope; label: string }> = [
  { value: "participating", label: "Only threads I'm involved in" },
  { value: "all", label: "Every comment I can see" },
  { value: "none", label: "None" }
];

export function NotificationSettings({
  initialSettings,
  linkedWorkspaces = [],
  slackLinked
}: {
  initialSettings: Settings;
  /** Oldest link first — the first entry is the default DM target. */
  linkedWorkspaces?: LinkedWorkspace[];
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

  async function updateWorkspace(teamId: string) {
    const previous = settings.notificationSlackTeamId;
    setSettings((current) => ({ ...current, notificationSlackTeamId: teamId }));
    if (!(await patch({ notificationSlackTeamId: teamId }))) {
      setSettings((current) => ({ ...current, notificationSlackTeamId: previous }));
    }
  }

  const effectiveWorkspaceTeamId =
    linkedWorkspaces.find((workspace) => workspace.teamId === settings.notificationSlackTeamId)?.teamId ??
    linkedWorkspaces[0]?.teamId ??
    null;

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

  const status = error ? (
    <span className="notification-settings-status forum-settings-error">{error}</span>
  ) : saving ? (
    <span className="notification-settings-status">Saving…</span>
  ) : saved ? (
    <span className="notification-settings-status">Saved</span>
  ) : null;

  return (
    <section className="credentials-section notification-settings">
      <div className="notification-settings-header">
        <strong className="credentials-section-title">Slack direct messages</strong>
        <span aria-live="polite">{status}</span>
      </div>
      <p className="muted-copy notification-settings-intro">
        {slackLinked
          ? "Choose which activity should send you a Slack DM."
          : "Connect your Slack account first to enable notifications."}
      </p>

      <div className="notification-settings-list">
        <label className="notification-setting-row">
          <span className="notification-setting-text">
            <strong>Comments</strong>
            <span className="muted-copy">
              The default for documents and quick takes. The bell on an item overrides it for that item.
              {settings.commentNotificationScope === "participating"
                ? " Involved means comments on my own items, threads I started or replied in, and mentions of me."
                : ""}
            </span>
          </span>
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
          <label className="notification-setting-row" key={toggle.key}>
            <span className="notification-setting-text">
              <strong>{toggle.title}</strong>
              <span className="muted-copy">{toggle.description}</span>
            </span>
            <input
              checked={settings[toggle.key]}
              disabled={saving || !slackLinked}
              onChange={(event) => void updateSetting(toggle.key, event.target.checked)}
              type="checkbox"
            />
          </label>
        ))}

        {linkedWorkspaces.length > 1 ? (
          <div
            aria-labelledby="notification-workspace-title"
            className="notification-setting-row notification-setting-row-stacked"
            role="radiogroup"
          >
            <span className="notification-setting-text">
              <strong id="notification-workspace-title">Send my DMs in</strong>
              <span className="muted-copy">
                Your Slack account is linked in several workspaces where claudex is installed. Notifications go to
                exactly one of them.
              </span>
            </span>
            <div className="notification-workspace-options">
              {linkedWorkspaces.map((workspace) => (
                <label className="notification-workspace-option" key={workspace.teamId}>
                  <input
                    checked={effectiveWorkspaceTeamId === workspace.teamId}
                    disabled={saving}
                    name="notification-slack-workspace"
                    onChange={() => void updateWorkspace(workspace.teamId)}
                    type="radio"
                  />
                  <span>{workspace.teamName ?? `Workspace ${workspace.teamId}`}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
