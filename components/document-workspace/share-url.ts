// Shared helpers for making agent-asset URLs (widgets, repo images, attachments)
// work for guests viewing a document through a view/comment-only share link.
//
// Share tokens are bearer capabilities. They must come from the current page
// access context and must never be trusted from document content: persisted
// nodes are visible to every viewer and may outlive/reach users with a weaker
// link. The attr argument is retained only while old documents are migrated.

// Resolve the share token to use for an asset request from the live page only.
export function resolveShareToken(_attrToken: string | null | undefined, search: string): string | null {
  return new URLSearchParams(search || "").get("share");
}

// Ensure a same-origin app asset URL carries the given share token as `?share=`.
// Absolute URLs (data:, blob:, https:) and already-tokened URLs are left alone —
// only relative `/api/...` paths (which is what all our asset routes are) get it.
export function withShareToken(rawUrl: string, token: string | null): string {
  if (!rawUrl.startsWith("/")) return rawUrl;
  const [path, query = ""] = rawUrl.split("?");
  const params = new URLSearchParams(query);
  // Scrub any capability baked by an older client, then add only the viewer's
  // current token. This also safely cleans legacy nodes for signed-in viewers.
  params.delete("share");
  if (token) params.set("share", token);
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}
