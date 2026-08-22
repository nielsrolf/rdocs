"use client";

import { useEffect, useState } from "react";

import { permissionLevels, type PermissionLevelValue } from "@/lib/contracts";
import { permissionLabel } from "@/lib/utils";

type GroupSummary = {
  id: string;
  name: string;
  isOwner: boolean;
  members: { userId: string; name: string; email: string; role: string }[];
};

type GroupGrant = {
  groupId: string;
  groupName: string;
  permission: PermissionLevelValue;
  memberCount: number;
};

// Self-contained "Groups" + "Forum" blocks for the share modal. Fetches its
// own data on mount so the 5k-line document workspace doesn't have to thread
// yet more state/handlers through to the modal.
export function ShareGroupsSection({
  documentId,
  initialForumPostedAt,
  initialForumPublic = false
}: {
  documentId: string;
  initialForumPostedAt: string | null;
  initialForumPublic?: boolean;
}) {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [grants, setGrants] = useState<GroupGrant[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [grantPermission, setGrantPermission] = useState<PermissionLevelValue>("VIEW");
  const [newGroupName, setNewGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [managingGroupId, setManagingGroupId] = useState<string | null>(null);
  const [memberEmail, setMemberEmail] = useState("");

  const [forumPostedAt, setForumPostedAt] = useState<string | null>(initialForumPostedAt);
  const [forumPublic, setForumPublic] = useState(initialForumPublic);
  const [forumBusy, setForumBusy] = useState(false);

  async function refresh() {
    try {
      const [groupsRes, grantsRes] = await Promise.all([
        fetch("/api/groups", { cache: "no-store" }),
        fetch(`/api/documents/${documentId}/groups`, { cache: "no-store" })
      ]);
      if (groupsRes.ok) {
        const data = (await groupsRes.json()) as { groups: GroupSummary[] };
        setGroups(data.groups);
      }
      if (grantsRes.ok) {
        const data = (await grantsRes.json()) as { grants: GroupGrant[] };
        setGrants(data.grants);
      }
      setLoaded(true);
    } catch {
      setError("Could not load groups.");
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, [documentId]);

  async function createGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    setError(null);
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!response.ok) {
        setError("Could not create the group.");
        return;
      }
      const data = (await response.json()) as { group: GroupSummary };
      setNewGroupName("");
      setSelectedGroupId(data.group.id);
      await refresh();
    } finally {
      setCreatingGroup(false);
    }
  }

  async function grantAccess() {
    if (!selectedGroupId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: selectedGroupId, permission: grantPermission })
      });
      if (!response.ok) {
        setError("Could not share with that group.");
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revokeAccess(groupId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/groups`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId })
      });
      if (!response.ok) {
        setError("Could not remove the group.");
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function addMember(groupId: string) {
    const email = memberEmail.trim();
    if (!email) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (!response.ok) {
        setError(
          response.status === 404
            ? "No user with that email."
            : "Could not add the member."
        );
        return;
      }
      setMemberEmail("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(groupId: string, userId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId })
      });
      if (!response.ok) {
        setError("Could not remove the member.");
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleForum(posted: boolean, isPublic?: boolean) {
    setForumBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/forum`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isPublic === undefined ? { posted } : { posted, isPublic })
      });
      if (!response.ok) {
        setError("Could not update the forum flag.");
        return;
      }
      const data = (await response.json()) as {
        forumPostedAt: string | null;
        forumPublic: boolean;
      };
      setForumPostedAt(data.forumPostedAt);
      setForumPublic(data.forumPublic);
    } finally {
      setForumBusy(false);
    }
  }

  const grantedIds = new Set(grants.map((g) => g.groupId));
  const grantable = groups.filter((g) => !grantedIds.has(g.id));
  const managingGroup = managingGroupId
    ? groups.find((g) => g.id === managingGroupId) ?? null
    : null;

  return (
    <>
      <div className="share-modal-section">
        <div className="share-modal-header">
          <h3>Groups</h3>
          <a className="ghost-button" href="/settings/groups" rel="noreferrer" target="_blank">
            Manage groups
          </a>
        </div>
        {!loaded ? <p className="muted-copy">Loading groups…</p> : null}
        {error ? <p className="muted-copy share-groups-error">{error}</p> : null}

        <div className="member-list">
          {loaded && grants.length === 0 ? (
            <p className="muted-copy">Not shared with any groups yet.</p>
          ) : (
            grants.map((grant) => (
              <div className="member-row" key={grant.groupId}>
                <div>
                  <strong>{grant.groupName}</strong>
                  <span>
                    {grant.memberCount} member{grant.memberCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="share-link-actions">
                  <span className="permission-pill">{permissionLabel(grant.permission)}</span>
                  <button
                    className="ghost-button danger-button"
                    disabled={busy}
                    onClick={() => revokeAccess(grant.groupId)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {grantable.length > 0 ? (
          <div className="comment-composer-actions share-groups-grant">
            <select
              onChange={(event) => setSelectedGroupId(event.target.value)}
              value={selectedGroupId}
            >
              <option value="">Select a group…</option>
              {grantable.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <select
              onChange={(event) => setGrantPermission(event.target.value as PermissionLevelValue)}
              value={grantPermission}
            >
              {permissionLevels.map((permission) => (
                <option key={permission} value={permission}>
                  {permissionLabel(permission)}
                </option>
              ))}
            </select>
            <button
              className="primary-button"
              disabled={busy || !selectedGroupId}
              onClick={grantAccess}
              type="button"
            >
              Share
            </button>
          </div>
        ) : null}

        <div className="comment-composer-actions share-groups-create">
          <input
            onChange={(event) => setNewGroupName(event.target.value)}
            placeholder="New group name (e.g. My team)"
            type="text"
            value={newGroupName}
          />
          <button
            className="ghost-button"
            disabled={creatingGroup || !newGroupName.trim()}
            onClick={createGroup}
            type="button"
          >
            {creatingGroup ? "Creating..." : "Create group"}
          </button>
        </div>

        {groups.length > 0 ? (
          <div className="share-groups-manage">
            <div className="comment-composer-actions">
              <select
                onChange={(event) => setManagingGroupId(event.target.value || null)}
                value={managingGroupId ?? ""}
              >
                <option value="">Manage group members…</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            {managingGroup ? (
              <div className="member-list">
                {managingGroup.members.map((member) => (
                  <div className="member-row" key={member.userId}>
                    <div>
                      <strong>{member.name}</strong>
                      <span>{member.email}</span>
                    </div>
                    <div className="share-link-actions">
                      <span className="permission-pill">{member.role}</span>
                      {managingGroup.isOwner && member.role !== "owner" ? (
                        <button
                          className="ghost-button danger-button"
                          disabled={busy}
                          onClick={() => removeMember(managingGroup.id, member.userId)}
                          type="button"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {managingGroup.isOwner ? (
                  <div className="comment-composer-actions">
                    <input
                      onChange={(event) => setMemberEmail(event.target.value)}
                      placeholder="Member email"
                      type="email"
                      value={memberEmail}
                    />
                    <button
                      className="ghost-button"
                      disabled={busy || !memberEmail.trim()}
                      onClick={() => addMember(managingGroup.id)}
                      type="button"
                    >
                      Add member
                    </button>
                  </div>
                ) : (
                  <p className="muted-copy">Only the group owner can manage members.</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="share-modal-section">
        <h3>Forum</h3>
        {forumPostedAt ? (
          <>
            <div className="member-row">
              <div>
                <strong>{forumPublic ? "Posted publicly" : "Posted to the forum"}</strong>
                <span>
                  {forumPublic
                    ? "Anyone can read this post — no account needed."
                    : "Visible to everyone with access to this document."}
                </span>
              </div>
              <div className="share-link-actions">
                <a className="ghost-button" href={`/forum/${documentId}`}>
                  View post
                </a>
                <button
                  className="ghost-button danger-button"
                  disabled={forumBusy}
                  onClick={() => toggleForum(false)}
                  type="button"
                >
                  Unpost
                </button>
              </div>
            </div>
            <div className="member-row">
              <div>
                <strong>Public access</strong>
                <span>
                  {forumPublic
                    ? "Logged-out visitors can read this post and see it on the frontpage."
                    : "Make the post readable by everyone, including logged-out visitors."}
                </span>
              </div>
              <button
                className={forumPublic ? "ghost-button danger-button" : "primary-button"}
                disabled={forumBusy}
                onClick={() => toggleForum(true, !forumPublic)}
                type="button"
              >
                {forumBusy ? "Saving..." : forumPublic ? "Make private" : "Make public"}
              </button>
            </div>
          </>
        ) : (
          <div className="member-row">
            <div>
              <strong>Not on the forum</strong>
              <span>Posting shows this document on the forum frontpage for everyone with access.</span>
            </div>
            <div className="share-link-actions">
              <button
                className="ghost-button"
                disabled={forumBusy}
                onClick={() => toggleForum(true, true)}
                type="button"
              >
                {forumBusy ? "Posting..." : "Post publicly"}
              </button>
              <button
                className="primary-button"
                disabled={forumBusy}
                onClick={() => toggleForum(true)}
                type="button"
              >
                {forumBusy ? "Posting..." : "Post to forum"}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
