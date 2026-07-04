import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveShareToken, withShareToken } from "../components/document-workspace/share-url";

// Regression for: view/comment-only viewers can't see widgets & repo images.
// An owner-created widget bakes an empty shareToken into the node; the guest
// opens the doc with ?share=TOK. The asset URL must still carry the token.

test("resolveShareToken prefers the node's explicit token", () => {
  assert.equal(resolveShareToken("node-tok", "?share=page-tok"), "node-tok");
});

test("resolveShareToken falls back to the page's ?share param", () => {
  assert.equal(resolveShareToken("", "?share=page-tok"), "page-tok");
  assert.equal(resolveShareToken(null, "?share=page-tok"), "page-tok");
  assert.equal(resolveShareToken(undefined, "?share=page-tok"), "page-tok");
});

test("resolveShareToken returns null when neither source has a token", () => {
  assert.equal(resolveShareToken("", ""), null);
  assert.equal(resolveShareToken(null, "?foo=bar"), null);
});

test("withShareToken adds ?share= to a tokenless widget source URL", () => {
  const rawSrc = "/api/documents/doc1/widgets/w1/source";
  assert.equal(withShareToken(rawSrc, "TOK"), "/api/documents/doc1/widgets/w1/source?share=TOK");
});

test("withShareToken preserves existing query params on repo-file URLs", () => {
  const rawSrc = "/api/documents/doc1/repo-files?path=plots%2Ffig.png&run=r1";
  const result = withShareToken(rawSrc, "TOK");
  const url = new URL(result, "http://x");
  assert.equal(url.searchParams.get("path"), "plots/fig.png");
  assert.equal(url.searchParams.get("run"), "r1");
  assert.equal(url.searchParams.get("share"), "TOK");
});

test("withShareToken does not clobber a token already present on the URL", () => {
  const rawSrc = "/api/documents/doc1/repo-files?path=fig.png&share=EXISTING";
  assert.equal(withShareToken(rawSrc, "TOK"), rawSrc);
});

test("withShareToken is a no-op without a token", () => {
  const rawSrc = "/api/documents/doc1/widgets/w1/source";
  assert.equal(withShareToken(rawSrc, null), rawSrc);
});

test("withShareToken leaves absolute / non-app URLs alone", () => {
  assert.equal(withShareToken("https://cdn.example.com/x.png", "TOK"), "https://cdn.example.com/x.png");
  assert.equal(withShareToken("data:image/png;base64,AAAA", "TOK"), "data:image/png;base64,AAAA");
});

// The end-to-end scenario the user reported: owner-baked widget node, guest view.
test("owner-created widget resolves to a tokened URL for a shared viewer", () => {
  const nodeAttrs = { shareToken: "", src: "/api/documents/doc1/widgets/w1/source" };
  const pageSearch = "?share=GUEST";

  const token = resolveShareToken(nodeAttrs.shareToken, pageSearch);
  const src = withShareToken(nodeAttrs.src || "/api/documents/doc1/widgets/w1/source", token);

  assert.equal(src, "/api/documents/doc1/widgets/w1/source?share=GUEST");
});
