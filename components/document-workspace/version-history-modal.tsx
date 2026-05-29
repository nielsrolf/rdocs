import { getSourceLabel } from "@/lib/sources";
import { formatDateTime } from "@/lib/utils";

import type { VersionView } from "./types";

export function VersionHistoryModal({
  loading,
  versions,
  selectedVersion,
  canRestore,
  restoring,
  onClose,
  onSelectVersion,
  onRestoreVersion
}: {
  loading: boolean;
  versions: VersionView[];
  selectedVersion: VersionView | null;
  canRestore: boolean;
  restoring: boolean;
  onClose: () => void;
  onSelectVersion: (id: string) => void;
  onRestoreVersion: (id: string) => void;
}) {
  return (
    <div className="share-modal-backdrop" onClick={onClose} role="presentation">
      <div
        aria-modal="true"
        className="version-history-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="share-modal-header">
          <div>
            <h2>Version history</h2>
            <p>Past snapshots load only when this panel is opened.</p>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            Close
          </button>
        </div>

        {loading ? (
          <div className="empty-state">Loading versions...</div>
        ) : versions.length === 0 ? (
          <div className="empty-state">No saved versions yet.</div>
        ) : (
          <div className="version-history-layout">
            <div className="version-history-list">
              {versions.map((version) => (
                <button
                  className={`version-history-item ${selectedVersion?.id === version.id ? "version-history-item-active" : ""}`}
                  key={version.id}
                  onClick={() => onSelectVersion(version.id)}
                  type="button"
                >
                  <strong>{version.title}</strong>
                  <span>{formatDateTime(version.createdAt)}</span>
                </button>
              ))}
            </div>

            <div className="version-history-preview">
              {selectedVersion ? (
                <>
                  <div className="version-history-preview-header">
                    <div>
                      <strong>{selectedVersion.title}</strong>
                      <div className="muted-copy">{formatDateTime(selectedVersion.createdAt)}</div>
                    </div>
                    {selectedVersion.sourceLinks.length > 0 ? (
                      <div className="version-source-list">
                        {selectedVersion.sourceLinks.map((sourceLink, index) => (
                          <a
                            href={sourceLink}
                            key={`${selectedVersion.id}-${sourceLink}`}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            [{index + 1}] {getSourceLabel(sourceLink)}
                          </a>
                        ))}
                      </div>
                    ) : null}
                    {selectedVersion.commitUrl ? (
                      <a
                        className="comment-commit-link"
                        href={selectedVersion.commitUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Commit {selectedVersion.commitSha?.slice(0, 7)}
                      </a>
                    ) : selectedVersion.commitSha ? (
                      <span className="subtle-pill">Commit {selectedVersion.commitSha.slice(0, 7)}</span>
                    ) : null}
                    {canRestore ? (
                      <button
                        className="primary-button version-restore-button"
                        disabled={restoring}
                        onClick={() => onRestoreVersion(selectedVersion.id)}
                        type="button"
                      >
                        {restoring ? "Restoring..." : "Restore this version"}
                      </button>
                    ) : null}
                  </div>
                  <pre>{selectedVersion.plainText}</pre>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
