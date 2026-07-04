// Pure, framework-free block-level diff/merge for ProseMirror document JSON.
//
// Used by the manual-merge recovery path: when a tab's local document has
// diverged so far from the server that prosemirror-collab can no longer rebase
// (see applyCollaborationPayload's catch in document-workspace.tsx) AND another
// client is connected (so the sole-client force-push is refused), we present a
// git-mergetool-style side-by-side resolution. This module computes the diff and
// assembles the resolved document; it has no editor/React/prosemirror deps so it
// is exhaustively unit-testable with plain JSON (tests/document-merge.test.ts).

export type DocNode = {
  type?: string;
  content?: DocNode[];
  [key: string]: unknown;
};

export type DocBlock = DocNode;

// A contiguous region of the merged document. "unchanged" blocks are identical
// on both sides and pass straight through; "conflict" regions differ (one side
// may be empty — a pure insertion or deletion is still a resolvable conflict).
export type MergeHunk =
  | { index: number; kind: "unchanged"; blocks: DocBlock[] }
  | { index: number; kind: "conflict"; server: DocBlock[]; local: DocBlock[] };

// How a single conflict hunk is resolved. "local" (this tab's copy) is the
// default — it is the work the user was actively editing.
export type HunkResolution = "server" | "local" | "both";

function topLevelBlocks(doc: DocNode | null | undefined): DocBlock[] {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) {
    return [];
  }
  return doc.content.filter((block): block is DocBlock => Boolean(block) && typeof block === "object");
}

// Stable identity key for a block. Both inputs originate from the same
// ProseMirror JSON serialization (editor.getJSON() and the server's
// parseDocumentContent), so JSON.stringify yields consistent key ordering and a
// byte-identical key for byte-identical blocks.
function blockKey(block: DocBlock): string {
  return JSON.stringify(block);
}

// Classic LCS over the two block-key sequences. Block counts are small (tens,
// occasionally a few hundred) so the O(n*m) DP table is fine. Returns the
// matched index pairs in ascending order.
function lcsPairs(a: string[], b: string[]): Array<{ ai: number; bi: number }> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<{ ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

// Diff the server document against the local (this-tab) document at the
// top-block level. Emits an ordered list of unchanged/conflict hunks that
// reconstructs the local document when every conflict is resolved to "local",
// and the server document when every conflict is resolved to "server".
export function diffDocumentBlocks(serverDoc: DocNode, localDoc: DocNode): MergeHunk[] {
  const serverBlocks = topLevelBlocks(serverDoc);
  const localBlocks = topLevelBlocks(localDoc);
  const serverKeys = serverBlocks.map(blockKey);
  const localKeys = localBlocks.map(blockKey);

  const matches = lcsPairs(serverKeys, localKeys);

  const hunks: MergeHunk[] = [];
  let si = 0;
  let li = 0;
  let index = 0;

  const flushConflict = (server: DocBlock[], local: DocBlock[]) => {
    if (server.length === 0 && local.length === 0) return;
    hunks.push({ index: index++, kind: "conflict", server, local });
  };

  for (const match of matches) {
    // Everything before this matched block on either side is a conflict region.
    if (match.ai > si || match.bi > li) {
      flushConflict(serverBlocks.slice(si, match.ai), localBlocks.slice(li, match.bi));
    }
    // The matched block is identical on both sides. Coalesce runs of matched
    // blocks into one unchanged hunk.
    const last = hunks[hunks.length - 1];
    if (last && last.kind === "unchanged") {
      last.blocks.push(serverBlocks[match.ai]);
    } else {
      hunks.push({ index: index++, kind: "unchanged", blocks: [serverBlocks[match.ai]] });
    }
    si = match.ai + 1;
    li = match.bi + 1;
  }

  // Trailing region after the last match.
  flushConflict(serverBlocks.slice(si), localBlocks.slice(li));

  return hunks;
}

// True when the two documents differ at the block level (i.e. there is at least
// one conflict hunk). When false an auto-merge would have succeeded and no manual
// resolution is needed.
export function documentsDiffer(serverDoc: DocNode, localDoc: DocNode): boolean {
  return diffDocumentBlocks(serverDoc, localDoc).some((hunk) => hunk.kind === "conflict");
}

// Assemble the merged document from the hunks and the user's per-conflict
// resolutions. Unresolved conflicts default to "local". Always returns a doc with
// at least one block (an empty merge falls back to a single empty paragraph) so
// the result satisfies the editor schema's `block+` content requirement.
export function buildMergedDocument(
  hunks: MergeHunk[],
  resolutions: Record<number, HunkResolution>
): DocNode {
  const content: DocBlock[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "unchanged") {
      content.push(...hunk.blocks);
      continue;
    }
    const choice = resolutions[hunk.index] ?? "local";
    if (choice === "server") {
      content.push(...hunk.server);
    } else if (choice === "both") {
      content.push(...hunk.server, ...hunk.local);
    } else {
      content.push(...hunk.local);
    }
  }

  if (content.length === 0) {
    content.push({ type: "paragraph" });
  }

  return { type: "doc", content };
}
