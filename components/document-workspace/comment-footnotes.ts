export type FootnoteThreadLike = {
  id?: string;
  position?: number;
  tags?: string[];
};

export function isFootnoteThread(thread: FootnoteThreadLike): boolean {
  return (thread.tags ?? []).some((tag) => tag.toLowerCase() === "footnote");
}

export function footnoteNumberByThreadId<T extends FootnoteThreadLike & { id: string; position: number }>(
  threads: T[]
): Map<string, number> {
  const ordered = threads
    .filter(isFootnoteThread)
    .slice()
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  return new Map(ordered.map((thread, index) => [thread.id, index + 1]));
}
