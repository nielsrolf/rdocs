import { permissionLevels, type PermissionLevelValue } from "@/lib/contracts";
import { permissionLabel } from "@/lib/utils";

import type { MemberView, ShareLinkView } from "./types";
import { useDialogDismiss } from "./use-dialog-dismiss";

export function ShareModal({
  members,
  shareLinks,
  inviteEmail,
  invitePermission,
  inviteBusy,
  creatingLink,
  onChangeInviteEmail,
  onChangeInvitePermission,
  onInvite,
  onCreateShareLink,
  onRevokeShareLink,
  onClose
}: {
  members: MemberView[];
  shareLinks: ShareLinkView[];
  inviteEmail: string;
  invitePermission: PermissionLevelValue;
  inviteBusy: boolean;
  creatingLink: PermissionLevelValue | null;
  onChangeInviteEmail: (value: string) => void;
  onChangeInvitePermission: (value: PermissionLevelValue) => void;
  onInvite: () => void;
  onCreateShareLink: (permission: PermissionLevelValue) => void;
  onRevokeShareLink: (id: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogDismiss<HTMLDivElement>(onClose);
  return (
    <div className="share-modal-backdrop" onClick={onClose} role="presentation">
      <div
        aria-labelledby="share-modal-title"
        aria-modal="true"
        className="share-modal"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="share-modal-header">
          <div>
            <h2 id="share-modal-title">Share document</h2>
            <p>Add collaborators or create permissioned links.</p>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className="member-invite-form">
          <input
            onChange={(event) => onChangeInviteEmail(event.target.value)}
            placeholder="Collaborator email"
            type="email"
            value={inviteEmail}
          />
          <div className="comment-composer-actions">
            <select
              onChange={(event) => onChangeInvitePermission(event.target.value as PermissionLevelValue)}
              value={invitePermission}
            >
              {permissionLevels.map((permission) => (
                <option key={permission} value={permission}>
                  {permissionLabel(permission)}
                </option>
              ))}
            </select>
            <button
              className="primary-button"
              disabled={inviteBusy || !inviteEmail.trim()}
              onClick={onInvite}
              type="button"
            >
              {inviteBusy ? "Inviting..." : "Invite by email"}
            </button>
          </div>
        </div>

        <div className="share-modal-section">
          <h3>People with access</h3>
          <div className="member-list">
            {members.length === 0 ? (
              <p className="muted-copy">No direct collaborators yet.</p>
            ) : (
              members.map((member) => (
                <div className="member-row" key={member.id}>
                  <div>
                    <strong>{member.user.name}</strong>
                    <span>{member.user.email}</span>
                  </div>
                  <span className="permission-pill">{permissionLabel(member.permission)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="share-modal-section">
          <h3>Share links</h3>
          <div className="share-actions">
            {permissionLevels.map((permission) => (
              <button
                className="ghost-button"
                disabled={creatingLink === permission}
                key={permission}
                onClick={() => onCreateShareLink(permission)}
                type="button"
              >
                {creatingLink === permission ? "Creating..." : `New ${permission.toLowerCase()} link`}
              </button>
            ))}
          </div>

          <div className="share-link-list">
            {shareLinks.length === 0 ? (
              <p className="muted-copy">No active share links yet.</p>
            ) : (
              shareLinks.map((link) => {
                const path = `/share/${link.token}`;

                return (
                  <div className="share-link-row" key={link.id}>
                    <div>
                      <strong>{permissionLabel(link.permission)}</strong>
                      <span>{path}</span>
                    </div>
                    <div className="share-link-actions">
                      <button
                        className="ghost-button"
                        onClick={() =>
                          navigator.clipboard.writeText(`${window.location.origin}${path}`)
                        }
                        type="button"
                      >
                        Copy
                      </button>
                      <button
                        className="ghost-button danger-button"
                        onClick={() => onRevokeShareLink(link.id)}
                        type="button"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
