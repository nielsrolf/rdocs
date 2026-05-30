// Detect @mentions in a comment body by matching against the document's known
// members. Names aren't unique and may contain spaces ("E2E User"), so we can't
// rely on a single regex — instead we test each candidate's literal `@<name>`
// against the text (case-insensitive, not followed by a word character so
// "@Al" doesn't match "@Alice"). Pure + dependency-free for easy unit testing.

export type MentionCandidate = { id: string; name: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the unique ids of candidates whose `@name` appears in `body`.
 * Longer names are matched first so "@Ada Lovelace" wins over a member "Ada".
 */
export function extractMentionedUserIds(body: string, candidates: MentionCandidate[]): string[] {
  if (!body.includes("@")) return [];
  const found = new Set<string>();
  const byLength = [...candidates]
    .filter((c) => c.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  for (const candidate of byLength) {
    const name = candidate.name.trim();
    // `@name` not immediately followed by a word char (so partial names of a
    // longer member don't match). Leading boundary is the literal "@".
    const pattern = new RegExp(`@${escapeRegExp(name)}(?![\\w])`, "i");
    if (pattern.test(body)) {
      found.add(candidate.id);
    }
  }
  return [...found];
}
