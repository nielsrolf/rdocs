// Shared helpers for making agent-asset URLs (widgets, repo images, attachments)
// work for guests viewing a document through a view/comment-only share link.
//
// The problem these solve: a node's `shareToken` attribute (and any baked asset
// URL) is captured at *creation* time from the creator's session. When the owner
// (or an owner-triggered AI run) creates a widget/image, that token is empty. A
// later guest opening the doc via `?share=<token>` therefore has no token on the
// node, and the asset request hits the access-gated API route without `?share=`
// → 404. The fix is to fall back to the page URL's `?share` param at render time.

// Resolve the share token to use for an asset request: prefer an explicit token
// baked into the node, else fall back to the current page's `?share` param.
export function resolveShareToken(attrToken: string | null | undefined, search: string): string | null {
  if (attrToken) return attrToken;
  return new URLSearchParams(search || "").get("share");
}

// Ensure a same-origin app asset URL carries the given share token as `?share=`.
// Absolute URLs (data:, blob:, https:) and already-tokened URLs are left alone —
// only relative `/api/...` paths (which is what all our asset routes are) get it.
export function withShareToken(rawUrl: string, token: string | null): string {
  if (!token || !rawUrl.startsWith("/")) return rawUrl;
  const [path, query = ""] = rawUrl.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("share")) {
    params.set("share", token);
  }
  return `${path}?${params.toString()}`;
}
