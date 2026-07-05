import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/react";

import type { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";
import type { MentionCandidate } from "@/lib/mentions";
import type { ReactionSummary } from "@/lib/reactions";

export type CommentView = {
  id: string;
  body: string;
  aiModel: string | null;
  // Display name for anonymous share-link commenters (author is null).
  guestName?: string | null;
  sourceLinks: string[];
  commitSha: string | null;
  commitUrl: string | null;
  aiRunId: string | null;
  createdAt: string | Date;
  author: {
    id: string;
    name: string;
  } | null;
  reactions?: ReactionSummary[];
};

export type ThreadView = {
  id: string;
  anchorText: string;
  anchorContext: string | null;
  status: ThreadStatusValue;
  tags: string[];
  createdAt: string | Date;
  createdBy: {
    id: string;
    name: string;
  } | null;
  lastReadAt: string | Date | null;
  comments: CommentView[];
};

export type ShareLinkView = {
  id: string;
  token: string;
  permission: PermissionLevelValue;
  createdAt: string | Date;
  // Absolute, canonical share URL built server-side (prefers APP_URL) so the
  // copied link points at the public domain regardless of the current host.
  url: string;
};

export type MemberView = {
  id: string;
  permission: PermissionLevelValue;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export type DocumentWorkspaceProps = {
  currentUserId: string | null;
  currentUserName: string;
  documentId: string;
  initialTitle: string;
  initialContent: unknown;
  initialCollaborationVersion: number;
  initialDocumentUpdatedAt: string;
  initialPermission: PermissionLevelValue;
  initialMembers: MemberView[];
  // Everyone who can be @mentioned (owner + collaborators), for autocomplete and
  // highlighting — passed to all viewers, unlike the owner-only initialMembers.
  mentionMembers: MentionCandidate[];
  // Comment ids that @mention the current user and are still unacknowledged,
  // captured server-side before acknowledgement; used to flash-highlight the
  // mentioning comment when arriving from a dashboard notification.
  initialMentionedCommentIds: string[];
  initialThreads: ThreadView[];
  initialShareLinks: ShareLinkView[];
  initialRepoUrl: string | null;
  initialRepoBranch: string | null;
  initialAgentModel: string | null;
  initialAgentEffort: string | null;
  initialHasOpenRouterKey: boolean;
  initialHasLiteLlmKey: boolean;
  /** Whether the document OWNER has a per-user key for the provider — env-menu
   * edits can't change these, so they keep the model groups unlocked. */
  ownerHasOpenRouterKey: boolean;
  ownerHasLiteLlmKey: boolean;
  isAuthenticated: boolean;
  isOwner: boolean;
  shareToken: string | null;
  viaShareLink: boolean;
};

export type VersionView = {
  id: string;
  title: string;
  content: JSONContent;
  plainText: string;
  sourceLinks: string[];
  commitSha: string | null;
  commitUrl: string | null;
  createdAt: string | Date;
};

export type AiEditImage = {
  path?: string;
  src: string;
  alt: string;
  caption: string | null;
};

export type AiEditWidget = {
  id: string;
  label: string;
  buildCmd: string;
  embedSource: string;
  src: string;
};

export type AiRunEventView = {
  id: string;
  role: string;
  message: string;
  createdAt: string | Date;
};

export type ActiveAiRunView = {
  id: string;
  triggerType: string;
  triggerId?: string | null;
  selectionId?: string | null;
  parentRunId?: string | null;
  instruction: string;
  status: string;
  progress: string | null;
  model?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  error?: string | null;
  startedAt: string | Date;
  finishedAt?: string | Date | null;
  appliedAt?: string | Date | null;
  events?: AiRunEventView[];
};

export type AgentToast = {
  id: string;
  title: string;
  body: string;
};

export type ActiveAiTarget =
  | {
      type: "selection-edit";
      top: number;
      left: number;
      width: number;
      height: number;
    }
  | {
      type: "comment-thread";
      threadId: string;
    };

export type SelectionState = {
  text: string;
  from: number;
  to: number;
  context: string;
  bubbleTop: number;
  bubbleLeft: number;
};

export type SelectionPopoverMode = "menu" | "comment" | "edit";
export type CommentTagFilterValue = "yes" | "no" | "all";

export type HighlightThread = {
  id: string;
};

export type CommentAnchorRange = {
  threadId: string;
  fromPos: number;
  toPos: number;
};

export type ProseMirrorDocWithDescendants = {
  descendants: ProseMirrorNode["descendants"];
};

export type WidgetDraft = {
  label: string;
  buildCmd: string;
  embedSource: string;
};

export const DEFAULT_COMMENT_TAGS = ["Resolved", "Footnote"];
export const CLAUDE_COMMENT_ICON_SRC = "/claude/happy_no_outline.png";
