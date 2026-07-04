import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMergedDocument,
  diffDocumentBlocks,
  documentsDiffer,
  type DocNode
} from "../lib/document-merge";

function para(text: string): DocNode {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function doc(...blocks: DocNode[]): DocNode {
  return { type: "doc", content: blocks };
}

test("identical documents produce only unchanged hunks and do not differ", () => {
  const a = doc(para("one"), para("two"));
  const b = doc(para("one"), para("two"));
  const hunks = diffDocumentBlocks(a, b);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].kind, "unchanged");
  assert.equal(documentsDiffer(a, b), false);
});

test("a changed middle block is a conflict flanked by unchanged hunks", () => {
  const server = doc(para("intro"), para("SERVER body"), para("outro"));
  const local = doc(para("intro"), para("LOCAL body"), para("outro"));
  const hunks = diffDocumentBlocks(server, local);

  assert.deepEqual(
    hunks.map((h) => h.kind),
    ["unchanged", "conflict", "unchanged"]
  );
  assert.equal(documentsDiffer(server, local), true);

  const conflict = hunks[1];
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") {
    assert.deepEqual(conflict.server, [para("SERVER body")]);
    assert.deepEqual(conflict.local, [para("LOCAL body")]);
  }
});

test("resolving 'server' / 'local' / 'both' assembles the expected document", () => {
  const server = doc(para("intro"), para("SERVER"), para("outro"));
  const local = doc(para("intro"), para("LOCAL"), para("outro"));
  const hunks = diffDocumentBlocks(server, local);
  const conflictIndex = hunks.find((h) => h.kind === "conflict")!.index;

  assert.deepEqual(
    buildMergedDocument(hunks, { [conflictIndex]: "server" }),
    doc(para("intro"), para("SERVER"), para("outro"))
  );
  assert.deepEqual(
    buildMergedDocument(hunks, { [conflictIndex]: "local" }),
    doc(para("intro"), para("LOCAL"), para("outro"))
  );
  assert.deepEqual(
    buildMergedDocument(hunks, { [conflictIndex]: "both" }),
    doc(para("intro"), para("SERVER"), para("LOCAL"), para("outro"))
  );
});

test("unresolved conflicts default to 'local'", () => {
  const server = doc(para("SERVER"));
  const local = doc(para("LOCAL"));
  const hunks = diffDocumentBlocks(server, local);
  assert.deepEqual(buildMergedDocument(hunks, {}), doc(para("LOCAL")));
});

test("resolving every conflict to 'local' reconstructs the local doc; 'server' the server doc", () => {
  const server = doc(para("a"), para("S1"), para("b"), para("S2"));
  const local = doc(para("L0"), para("a"), para("b"), para("L2"), para("L3"));
  const hunks = diffDocumentBlocks(server, local);

  const allLocal: Record<number, "local"> = {};
  const allServer: Record<number, "server"> = {};
  for (const h of hunks) {
    if (h.kind === "conflict") {
      allLocal[h.index] = "local";
      allServer[h.index] = "server";
    }
  }
  assert.deepEqual(buildMergedDocument(hunks, allLocal), local);
  assert.deepEqual(buildMergedDocument(hunks, allServer), server);
});

test("pure insertion (server-only / local-only) is a conflict with one empty side", () => {
  const server = doc(para("a"), para("b"));
  const local = doc(para("a"), para("INSERTED"), para("b"));
  const hunks = diffDocumentBlocks(server, local);
  const conflict = hunks.find((h) => h.kind === "conflict");
  assert.ok(conflict && conflict.kind === "conflict");
  if (conflict && conflict.kind === "conflict") {
    assert.deepEqual(conflict.server, []);
    assert.deepEqual(conflict.local, [para("INSERTED")]);
  }
  // Accepting the insertion ("local") keeps it; rejecting ("server") drops it.
  assert.deepEqual(buildMergedDocument(hunks, { [conflict!.index]: "server" }), server);
});

test("an emptied merge falls back to a single empty paragraph", () => {
  const server = doc(para("only"));
  const local = doc({ type: "paragraph" });
  const hunks = diffDocumentBlocks(server, local);
  // Resolve the conflict to 'server' but imagine both sides empty: force it by
  // building from a synthetic all-empty hunk set.
  const merged = buildMergedDocument(
    [{ index: 0, kind: "conflict", server: [], local: [] }],
    {}
  );
  assert.deepEqual(merged, doc({ type: "paragraph" }));
  // Sanity: the real hunks still build a non-empty doc.
  assert.ok((buildMergedDocument(hunks, {}).content ?? []).length >= 1);
});

test("handles non-doc / malformed input without throwing", () => {
  assert.deepEqual(diffDocumentBlocks({} as DocNode, {} as DocNode), []);
  assert.equal(documentsDiffer({ type: "doc" }, { type: "doc" }), false);
});
