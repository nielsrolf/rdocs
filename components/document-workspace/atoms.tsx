import { Fragment } from "@tiptap/pm/model";
import type { useEditor } from "@tiptap/react";

import { CLAUDE_COMMENT_ICON_SRC } from "./types";
import type { ActiveAiRunView, CommentView } from "./types";
import { getAiRunProgressLabel, getInitials } from "./utils";

export type ToolbarButtonProps = {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
};

export function ToolbarButton({ active = false, disabled = false, label, onClick }: ToolbarButtonProps) {
  return (
    <button
      className={`editor-toolbar-button ${active ? "editor-toolbar-button-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

export function CommentAvatar({ comment }: { comment: Pick<CommentView, "aiModel" | "author"> }) {
  const authorName = comment.author?.name ?? "Claude";

  if (comment.aiModel) {
    return <img alt="" className="avatar-dot avatar-dot-image" src={CLAUDE_COMMENT_ICON_SRC} />;
  }

  return <span className="avatar-dot">{getInitials(authorName)}</span>;
}

export function ClaudeWorkingInline({
  activeAiRun,
  compact = false
}: {
  activeAiRun: ActiveAiRunView | null;
  compact?: boolean;
}) {
  const progressLabel = getAiRunProgressLabel(activeAiRun);

  return (
    <div
      aria-label={`Claude is working. ${progressLabel}`}
      className={`claude-working-inline ${compact ? "claude-working-inline-compact" : ""}`}
      role="status"
    >
      <div className="claude-working-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <img alt="" className="claude-working-icon" src="/claude/investigating_no_outline.png" />
      <span className="claude-working-tool">{progressLabel}</span>
    </div>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Image read failed."));
    };
    reader.onerror = () => reject(new Error("Image read failed."));
    reader.readAsDataURL(file);
  });
}

export async function insertImagesAtPosition(
  view: NonNullable<NonNullable<ReturnType<typeof useEditor>>["view"]>,
  files: File[],
  dropCoordinates?: { left: number; top: number }
) {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    return false;
  }

  const imageType = view.state.schema.nodes.image;
  if (!imageType) {
    return false;
  }

  const paragraphType = view.state.schema.nodes.paragraph;
  const targetPosition =
    dropCoordinates != null ? view.posAtCoords(dropCoordinates)?.pos ?? view.state.selection.from : view.state.selection.from;

  const dataUrls = await Promise.all(imageFiles.map((file) => readFileAsDataUrl(file)));
  const nodes = dataUrls.flatMap((src, index) => {
    const imageNode = imageType.create({
      src,
      alt: imageFiles[index]?.name || "Pasted image"
    });

    return paragraphType ? [imageNode, paragraphType.create()] : [imageNode];
  });

  const transaction = view.state.tr.insert(targetPosition, Fragment.fromArray(nodes));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return true;
}
