"use client";

import Link from "next/link";
import { useState } from "react";

import { permissionLabel } from "@/lib/utils";

type GroupMemberView = { userId: string; name: string; email: string; role: string };
type GroupDocumentView = { id: string; title: string; permission: string };
type GroupView = {
  id: string;
  name: string;
  isOwner: boolean;
  members: GroupMemberView[];
  documents: GroupDocumentView[];
};

// Client half of /groups: full CRUD on groups + members against the existing
// /api/groups routes. Server-rendered initial state, then local refreshes.
export function GroupsManager({ initialGroups }: { initialGroups: GroupView[] }) {
  const [groups, setGroups] = useState<GroupView[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newGroupName, setNewGroupName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [memberEmails, setMemberEmails] = useState<Record<string, string>>({});

  async function refresh() {
    // The list route doesn't include shared documents; keep the server-rendered
    // ones and merge fresh names/members over them.
    const response = await fetch("/api/groups", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as {
      groups: { id: string; name: string; isOwner: boolean; members: GroupMemberView[] }[];
    };
    setGroups((previous) => {
      const documentsById = new Map(previous.map((g) => [g.id, g.documents]));
      return data.groups.map((g) => ({ ...g, documents: documentsById.get(g.id) ?? [] }));
    });
  }

  async function run(action: () => Promise<boolean>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      const ok = await action();
      if (!ok) {
        setError(failure);
        return;
      }
      await refresh();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  function createGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    void run(async () => {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (response.ok) setNewGroupName("");
      return response.ok;
    }, "Could not create the group.");
  }

  function renameGroup(groupId: string) {
    const name = renameValue.trim();
    if (!name) return;
    void run(async () => {
      const response = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (response.ok) setRenamingId(null);
      return response.ok;
    }, "Could not rename the group.");
  }

  function deleteGroup(group: GroupView) {
    if (!window.confirm(`Delete the group "${group.name}"? Documents shared with it lose that access.`)) {
      return;
    }
    void run(async () => {
      const response = await fetch(`/api/groups/${group.id}`, { method: "DELETE" });
      return response.ok;
    }, "Could not delete the group.");
  }

  function addMember(groupId: string) {
    const email = (memberEmails[groupId] ?? "").trim();
    if (!email) return;
    void run(async () => {
      const response = await fetch(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (response.ok) setMemberEmails((prev) => ({ ...prev, [groupId]: "" }));
      else if (response.status === 404) {
        setError("No user with that email.");
        return true; // handled: keep the specific message, skip the generic one
      }
      return response.ok;
    }, "Could not add the member.");
  }

  function removeMember(groupId: string, userId: string) {
    void run(async () => {
      const response = await fetch(`/api/groups/${groupId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId })
      });
      return response.ok;
    }, "Could not remove the member.");
  }

  return (
    <section className="groups-page">
      {error ? <p className="muted-copy share-groups-error">{error}</p> : null}

      <div className="share-modal-section groups-create-card">
        <h3>New group</h3>
        <div className="comment-composer-actions share-groups-create">
          <input
            onChange={(event) => setNewGroupName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createGroup();
            }}
            placeholder="Group name (e.g. My team)"
            type="text"
            value={newGroupName}
          />
          <button
            className="primary-button"
            disabled={busy || !newGroupName.trim()}
            onClick={createGroup}
            type="button"
          >
            Create group
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="muted-copy">
          No groups yet. Create one above, add members by email, then share documents with it from
          any document&apos;s share menu.
        </p>
      ) : null}

      {groups.map((group) => (
        <div className="share-modal-section groups-card" key={group.id}>
          <div className="member-row groups-card-header">
            {renamingId === group.id ? (
              <div className="comment-composer-actions">
                <input
                  autoFocus
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") renameGroup(group.id);
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                  type="text"
                  value={renameValue}
                />
                <button
                  className="primary-button"
                  disabled={busy || !renameValue.trim()}
                  onClick={() => renameGroup(group.id)}
                  type="button"
                >
                  Save
                </button>
                <button className="ghost-button" onClick={() => setRenamingId(null)} type="button">
                  Cancel
                </button>
              </div>
            ) : (
              <div>
                <h3>{group.name}</h3>
                <span className="muted-copy">
                  {group.members.length} member{group.members.length === 1 ? "" : "s"}
                  {group.isOwner ? "" : " · shared with you"}
                </span>
              </div>
            )}
            {group.isOwner && renamingId !== group.id ? (
              <div className="share-link-actions">
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => {
                    setRenamingId(group.id);
                    setRenameValue(group.name);
                  }}
                  type="button"
                >
                  Rename
                </button>
                <button
                  className="ghost-button danger-button"
                  disabled={busy}
                  onClick={() => deleteGroup(group)}
                  type="button"
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>

          <div className="member-list">
            {group.members.map((member) => (
              <div className="member-row" key={member.userId}>
                <div>
                  <strong>{member.name}</strong>
                  <span>{member.email}</span>
                </div>
                <div className="share-link-actions">
                  <span className="permission-pill">{member.role}</span>
                  {group.isOwner && member.role !== "owner" ? (
                    <button
                      className="ghost-button danger-button"
                      disabled={busy}
                      onClick={() => removeMember(group.id, member.userId)}
                      type="button"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {group.isOwner ? (
            <div className="comment-composer-actions">
              <input
                onChange={(event) =>
                  setMemberEmails((prev) => ({ ...prev, [group.id]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") addMember(group.id);
                }}
                placeholder="Member email"
                type="email"
                value={memberEmails[group.id] ?? ""}
              />
              <button
                className="ghost-button"
                disabled={busy || !(memberEmails[group.id] ?? "").trim()}
                onClick={() => addMember(group.id)}
                type="button"
              >
                Add member
              </button>
            </div>
          ) : (
            <p className="muted-copy">Only the group owner can manage members.</p>
          )}

          {group.documents.length > 0 ? (
            <div className="groups-doc-list">
              <h4>Shared documents</h4>
              {group.documents.map((doc) => (
                <div className="member-row" key={doc.id}>
                  <Link href={`/documents/${doc.id}`}>{doc.title || "Untitled"}</Link>
                  <span className="permission-pill">{permissionLabel(doc.permission)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
