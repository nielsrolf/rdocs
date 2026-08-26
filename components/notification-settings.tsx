"use client";

import { useState } from "react";

type Settings = {
  commentSlackNotifications: boolean;
  documentShareSlackNotifications: boolean;
  forumShareSlackNotifications: boolean;
};

type SharedDocument = {
  id: string;
  title: string;
  commentSlackNotifications: boolean | null;
};

export function NotificationSettings({
  initialSettings,
  sharedDocuments: initialDocuments,
  slackLinked
}: {
  initialSettings: Settings;
  sharedDocuments: SharedDocument[];
  slackLinked: boolean;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [documents, setDocuments] = useState(initialDocuments);
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

  async function updateDocument(documentId: string, enabled: boolean | null) {
    const previous = documents.find((document) => document.id === documentId)?.commentSlackNotifications ?? null;
    setDocuments((current) =>
      current.map((document) =>
        document.id === documentId ? { ...document, commentSlackNotifications: enabled } : document
      )
    );
    if (!(await patch({ documentCommentPreference: { documentId, enabled } }))) {
      setDocuments((current) =>
        current.map((document) =>
          document.id === documentId ? { ...document, commentSlackNotifications: previous } : document
        )
      );
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
      title: "Comments and replies",
      description: "Use this as the default for documents I own or can access."
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

      {documents.length > 0 ? (
        <div className="share-modal-section">
          <h3>Comment notifications by document</h3>
          <p className="muted-copy">Override the comments default for documents you do not own.</p>
          {documents.map((document) => (
            <label className="quicktake-visibility-select" key={document.id}>
              <span>{document.title || "Untitled document"}</span>
              <select
                disabled={saving || !slackLinked}
                onChange={(event) =>
                  void updateDocument(
                    document.id,
                    event.target.value === "default" ? null : event.target.value === "on"
                  )
                }
                value={
                  document.commentSlackNotifications === null
                    ? "default"
                    : document.commentSlackNotifications
                      ? "on"
                      : "off"
                }
              >
                <option value="default">Use default ({settings.commentSlackNotifications ? "on" : "off"})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          ))}
        </div>
      ) : null}

      {!slackLinked ? <p className="muted-copy">Connect your Slack account first to enable notifications.</p> : null}
      {saving ? <p className="muted-copy">Saving…</p> : null}
      {saved && !saving ? <p className="muted-copy">Saved.</p> : null}
      {error ? <p className="muted-copy forum-settings-error">{error}</p> : null}
    </section>
  );
}
