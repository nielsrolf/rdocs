import { RichCommentEditor } from "@/components/rich-comment-editor";
import type { MentionCandidate } from "@/lib/mentions";

// Comment composer used by the comment rail (new thread, replies, inline
// edits) and the selection popover. Despite the historical name it is a
// rich-text editor whose value is markdown — see RichCommentEditor. Mentions
// are stored as plain "@Name" text (detected server-side by
// extractMentionedUserIds, highlighted on render by renderCommentHtml).
export function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  rows = 3,
  autoFocus,
  className,
  onSubmit
}: {
  value: string;
  onChange: (value: string) => void;
  members: MentionCandidate[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
  // Called on Cmd/Ctrl+Enter (the dropdown intercepts a bare Enter when open).
  onSubmit?: () => void;
}) {
  return (
    <RichCommentEditor
      autoFocus={autoFocus}
      className={className}
      members={members}
      onChange={onChange}
      onSubmit={onSubmit}
      placeholder={placeholder}
      rows={rows}
      value={value}
    />
  );
}
