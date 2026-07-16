// Pure tag-filtering logic for the cross-document comment inbox, kept free of
// React so it can be unit-tested directly. Tags are compared case-insensitively
// to match the normalization in `normalizeThreadTags`.

export type FilterableThread = {
  status: string;
  tags: string[];
};

const RESOLVED_TAG = "resolved";

function hasTag(thread: FilterableThread, tag: string): boolean {
  const needle = tag.toLowerCase();
  return thread.tags.some((t) => t.toLowerCase() === needle);
}

function isResolved(thread: FilterableThread): boolean {
  return thread.status === "RESOLVED" || hasTag(thread, RESOLVED_TAG);
}

// Multi-select tags act as AND: a thread must carry every selected tag. With no
// tags selected, all threads pass. Resolved threads are hidden unless
// "Resolved" is one of the selected tags (an explicit opt-in).
export function filterInboxThreads<T extends FilterableThread>(
  threads: T[],
  selectedTags: string[]
): T[] {
  const resolvedSelected = selectedTags.some((tag) => tag.toLowerCase() === RESOLVED_TAG);
  return threads.filter((thread) => {
    if (isResolved(thread) && !resolvedSelected) {
      return false;
    }
    return selectedTags.every((tag) => hasTag(thread, tag));
  });
}
