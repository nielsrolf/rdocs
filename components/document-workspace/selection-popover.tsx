import { truncate } from "@/lib/utils";

import type { SelectionPopoverMode, SelectionState } from "./types";

export function SelectionPopover({
  selection,
  mode,
  canWriteComments,
  canWriteDocument,
  composerBody,
  commentBusy,
  editInstruction,
  onModeChange,
  onComposerBodyChange,
  onEditInstructionChange,
  onSubmitComment,
  onSubmitEdit,
  onCancel
}: {
  selection: SelectionState;
  mode: SelectionPopoverMode;
  canWriteComments: boolean;
  canWriteDocument: boolean;
  composerBody: string;
  commentBusy: boolean;
  editInstruction: string;
  onModeChange: (next: SelectionPopoverMode) => void;
  onComposerBodyChange: (value: string) => void;
  onEditInstructionChange: (value: string) => void;
  onSubmitComment: () => void;
  onSubmitEdit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="selection-bubble-wrap"
      style={{
        left: selection.bubbleLeft,
        top: selection.bubbleTop
      }}
    >
      {mode === "menu" ? (
        <div className="selection-bubble-menu">
          {canWriteComments ? (
            <button
              className="selection-bubble"
              onClick={() => onModeChange("comment")}
              type="button"
            >
              Add comment
            </button>
          ) : null}
          {canWriteDocument ? (
            <button
              className="selection-bubble selection-bubble-secondary"
              onClick={() => onModeChange("edit")}
              type="button"
            >
              Edit with AI
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === "comment" ? (
        <div className="comment-composer-popover">
          <div className="composer-selection-preview">“{truncate(selection.text, 80)}”</div>
          <textarea
            onChange={(event) => onComposerBodyChange(event.target.value)}
            placeholder="Add a comment"
            rows={4}
            value={composerBody}
          />
          <div className="comment-composer-actions">
            <button className="ghost-button" onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={!composerBody.trim() || commentBusy}
              onClick={onSubmitComment}
              type="button"
            >
              {commentBusy ? "Posting..." : "Comment"}
            </button>
          </div>
        </div>
      ) : null}

      {mode === "edit" ? (
        <div className="comment-composer-popover">
          <div className="composer-selection-preview">“{truncate(selection.text, 80)}”</div>
          <textarea
            onChange={(event) => onEditInstructionChange(event.target.value)}
            placeholder="Tell AI how to rewrite the selection"
            rows={4}
            value={editInstruction}
          />
          <div className="comment-composer-actions">
            <button className="ghost-button" onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={!editInstruction.trim()}
              onClick={onSubmitEdit}
              type="button"
            >
              Apply edit
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
