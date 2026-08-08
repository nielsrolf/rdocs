"use client";

import { useState } from "react";

type GroupOption = { id: string; name: string };

// Forum preferences section of the settings page. Currently one setting: the
// default audience for quicktakes (User.quicktakeGroupId) — the same setting
// exposed inline in the quicktake composer; changing it here retroactively
// re-shares all existing quicktakes too (see lib/quicktakes.ts).
export function ForumSettings({
  groups,
  initialGroupId,
  initialGroupName
}: {
  groups: GroupOption[];
  initialGroupId: string | null;
  initialGroupName: string | null;
}) {
  const [groupId, setGroupId] = useState<string | null>(initialGroupId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A configured group the user can no longer see (deleted / removed from it)
  // still renders, so the current state is never silently misrepresented.
  const dangling =
    groupId !== null && !groups.some((group) => group.id === groupId);

  async function updateVisibility(next: string | null) {
    const previous = groupId;
    setGroupId(next);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/user/quicktake-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: next })
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setGroupId(previous);
        setError(data?.error ?? "Could not update the quicktake audience.");
        return;
      }
      setSaved(true);
    } catch {
      setGroupId(previous);
      setError("Could not update the quicktake audience.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="credentials-section">
      <strong className="credentials-section-title">Quicktakes</strong>
      <p className="muted-copy">
        Who sees the quick takes you publish on the forum. This applies to all your
        quicktakes — past and future — so switching to a group also unpublishes your
        older public takes.
      </p>
      <label className="quicktake-visibility-select">
        Publish quicktakes to
        <select
          disabled={saving}
          onChange={(event) => updateVisibility(event.target.value || null)}
          value={dangling ? "" : groupId ?? ""}
        >
          <option value="">Everyone (public)</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              Group: {group.name}
            </option>
          ))}
        </select>
      </label>
      {dangling ? (
        <p className="muted-copy">
          Currently restricted to a group you no longer belong to
          {initialGroupName ? ` (${initialGroupName})` : ""} — your quicktakes are
          visible only to you until you pick a new audience.
        </p>
      ) : null}
      {groups.length === 0 ? (
        <p className="muted-copy">
          You are not in any groups yet — create one from a document&apos;s Share dialog
          or on the <a href="/groups">groups page</a> to publish to a team.
        </p>
      ) : null}
      {saving ? <p className="muted-copy">Saving…</p> : null}
      {saved && !saving ? <p className="muted-copy">Saved.</p> : null}
      {error ? <p className="muted-copy forum-settings-error">{error}</p> : null}
    </section>
  );
}
