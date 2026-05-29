import type { WidgetDraft } from "./types";
import { useDialogDismiss } from "./use-dialog-dismiss";

export function WidgetDialog({
  busy,
  draft,
  onClose,
  onChange,
  onSubmit
}: {
  busy: boolean;
  draft: WidgetDraft;
  onClose: () => void;
  onChange: (next: WidgetDraft) => void;
  onSubmit: () => void;
}) {
  const dialogRef = useDialogDismiss<HTMLFormElement>(() => {
    if (!busy) {
      onClose();
    }
  });
  return (
    <div
      className="share-modal-backdrop"
      onClick={() => {
        if (!busy) {
          onClose();
        }
      }}
      role="presentation"
    >
      <form
        aria-labelledby="widget-dialog-title"
        aria-modal="true"
        className="widget-config-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="share-modal-header">
          <div>
            <h2 id="widget-dialog-title">Insert widget</h2>
            <p>Create an embedded widget from a build command and generated HTML file.</p>
          </div>
          <button
            className="ghost-button"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="widget-config-fields">
          <label>
            <span>Label</span>
            <input
              onChange={(event) => onChange({ ...draft, label: event.target.value })}
              placeholder="Short name shown above the widget"
              value={draft.label}
            />
          </label>
          <label>
            <span>Build command</span>
            <textarea
              onChange={(event) => onChange({ ...draft, buildCmd: event.target.value })}
              placeholder="e.g. python widgets/build_<name>.py --output assets/<name>.html"
              rows={3}
              value={draft.buildCmd}
            />
          </label>
          <label>
            <span>Embed source</span>
            <input
              onChange={(event) => onChange({ ...draft, embedSource: event.target.value })}
              placeholder="e.g. assets/<name>.html"
              value={draft.embedSource}
            />
          </label>
        </div>

        <div className="comment-composer-actions">
          <button className="ghost-button" disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || !draft.buildCmd.trim() || !draft.embedSource.trim()}
            type="submit"
          >
            {busy ? "Creating..." : "Insert widget"}
          </button>
        </div>
      </form>
    </div>
  );
}
