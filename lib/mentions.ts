// Detect @mentions in a comment body by matching against the document's known
// members. Names aren't unique and may contain spaces ("E2E User"), so we can't
// rely on a single regex — instead we test each candidate's literal `@<name>`
// against the text (case-insensitive, not followed by a word character so
// "@Al" doesn't match "@Alice"). Pure + dependency-free for easy unit testing.

export type MentionCandidate = { id: string; name: string; email?: string | null };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the unique ids of candidates whose `@name` OR `@email` appears in
 * `body`. People often @mention by typing the address they invited the person
 * with (e.g. `@ada@example.com`), so we match emails too — not just display
 * names. Longer tokens are matched first so "@Ada Lovelace" wins over a member
 * "Ada", and "@ada@example.com" wins over the bare name "ada".
 */
export function extractMentionedUserIds(body: string, candidates: MentionCandidate[]): string[] {
  if (!body.includes("@")) return [];
  const found = new Set<string>();

  // One token per matchable handle (display name + email), tagged with its user
  // id, sorted by length so the most specific match is tested first.
  const tokens = candidates
    .flatMap((candidate) => {
      const handles = [candidate.name, candidate.email]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0);
      return handles.map((token) => ({ id: candidate.id, token }));
    })
    .sort((a, b) => b.token.length - a.token.length);

  for (const { id, token } of tokens) {
    // `@token` not immediately followed by a word char (so partial handles of a
    // longer member don't match). Leading boundary is the literal "@".
    const pattern = new RegExp(`@${escapeRegExp(token)}(?![\\w])`, "i");
    if (pattern.test(body)) {
      found.add(id);
    }
  }
  return [...found];
}

// --- Autocomplete helpers (shared by the comment textarea and the doc editor) ---

export type ActiveMentionQuery = {
  /** Text typed after the `@`, up to the caret (may be empty or contain spaces). */
  query: string;
  /** Index of the triggering `@`. */
  start: number;
  /** The caret index (exclusive end of the query). */
  end: number;
};

/**
 * Detect an in-progress `@mention` immediately before `caret` in `text`. The
 * trigger `@` must sit at the start of the text or follow whitespace/an opening
 * bracket (so `foo@bar.com` typed as a plain email does not trigger), but a
 * leading `@` followed by an email like `@ada@example.com` still works because
 * we skip past mid-word `@`s while scanning back for the real trigger. Returns
 * null when there's no active mention. Pure + unit-testable.
 */
export function findActiveMentionQuery(text: string, caret: number): ActiveMentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  let triggerIndex = -1;
  for (let i = caret - 1; i >= 0 && caret - i <= 80; i -= 1) {
    const ch = text[i];
    if (ch === "\n") break;
    if (ch === "@") {
      const prev = i > 0 ? text[i - 1] : "";
      if (prev === "" || /\s/.test(prev) || /[([{>"']/.test(prev)) {
        triggerIndex = i;
        break;
      }
      // A mid-word `@` (e.g. inside an email) — keep scanning back for the
      // real trigger rather than giving up.
    }
  }
  if (triggerIndex === -1) return null;
  const query = text.slice(triggerIndex + 1, caret);
  if (query.includes("\n")) return null;
  return { query, start: triggerIndex, end: caret };
}

/**
 * Prefix-match candidates against `query` by display name or email
 * (case-insensitive). An empty query returns everyone (typing a bare `@`).
 * Sorted shortest-name-first so exact/short matches surface first; capped.
 */
export function filterMentionCandidates(
  query: string,
  candidates: MentionCandidate[],
  limit = 8
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter((candidate) => {
    const name = (candidate.name ?? "").trim().toLowerCase();
    const email = (candidate.email ?? "").trim().toLowerCase();
    if (!name && !email) return false;
    if (needle === "") return true;
    return name.startsWith(needle) || email.startsWith(needle);
  });
  return matches
    .sort((a, b) => (a.name ?? "").length - (b.name ?? "").length)
    .slice(0, limit);
}

/** The handle inserted for a mention: the display name, or the email if unnamed. */
export function mentionHandle(candidate: MentionCandidate): string {
  const name = (candidate.name ?? "").trim();
  if (name) return name;
  return (candidate.email ?? "").trim();
}
