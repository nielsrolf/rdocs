import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";

export type CommentView = {
  id: string;
  body: string;
  aiModel: string | null;
  sourceLinks: string[];
  commitSha: string | null;
  commitUrl: string | null;
  aiRunId: string | null;
  createdAt: string | Date;
  author: {
    id: string;
    name: string;
  } | null;
};

export type ThreadView = {
  id: string;
  anchorText: string;
  anchorContext: string | null;
  fromPos: number | null;
  toPos: number | null;
  status: ThreadStatusValue;
  tags: string[];
  createdAt: string | Date;
  createdBy: {
    id: string;
    name: string;
  };
  comments: CommentView[];
};

export type ShareLinkView = {
  id: string;
  token: string;
  permission: PermissionLevelValue;
  createdAt: string | Date;
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
  initialDocumentUpdatedAt: string;
  initialPermission: PermissionLevelValue;
  initialMembers: MemberView[];
  initialThreads: ThreadView[];
  initialShareLinks: ShareLinkView[];
  initialRepoUrl: string | null;
  initialRepoBranch: string | null;
  isAuthenticated: boolean;
  isOwner: boolean;
  shareToken: string | null;
  viaShareLink: boolean;
};

export type VersionView = {
  id: string;
  title: string;
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
  fromPos: number | null;
  toPos: number | null;
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
