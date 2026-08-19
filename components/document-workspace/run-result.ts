export type RunArtifactComment = {
  id: string;
  threadId: string;
  anchorText: string;
  body: string;
  createdAt?: string | Date;
};

export type RunArtifactSuggestion = {
  findText: string;
  replacementText: string;
  reason?: string;
};

export type ClassifiedRunArtifacts = {
  finalEdit: string | null;
  finalReplies: RunArtifactComment[];
  standaloneComments: RunArtifactComment[];
  suggestions: RunArtifactSuggestion[];
};

// Keep classification independent from React so the API payload/UI contract is
// regression-testable. A COMMENT_THREAD run's comment on its trigger thread is
// the final reply; comments on any other thread are in-document review notes.
export function classifyRunArtifacts(input: {
  triggerType: string;
  triggerId: string | null;
  replacementText: string | null;
  comments: RunArtifactComment[];
  suggestions: RunArtifactSuggestion[];
}): ClassifiedRunArtifacts {
  const finalReplies =
    input.triggerType === "COMMENT_THREAD" && input.triggerId
      ? input.comments.filter((comment) => comment.threadId === input.triggerId)
      : [];
  const finalReplyIds = new Set(finalReplies.map((comment) => comment.id));
  return {
    finalEdit:
      input.triggerType === "SELECTION_EDIT" && input.replacementText?.trim()
        ? input.replacementText
        : null,
    finalReplies,
    standaloneComments: input.comments.filter((comment) => !finalReplyIds.has(comment.id)),
    suggestions: input.suggestions
  };
}

export function hasRenderableRunArtifacts(artifacts: ClassifiedRunArtifacts): boolean {
  return Boolean(
    artifacts.finalEdit ||
      artifacts.finalReplies.length ||
      artifacts.standaloneComments.length ||
      artifacts.suggestions.length
  );
}
