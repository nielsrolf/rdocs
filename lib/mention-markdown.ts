import MarkdownIt from "markdown-it";

import { addLatexSupport } from "@/lib/latex-markdown";
import type { MentionCandidate } from "@/lib/mentions";

// Renders comment markdown with recognized @mentions wrapped in styled spans:
//   <span class="mention mention-self|mention-other" data-mention-user-id="…">@Name</span>
// "Recognized" = the @handle matches a known document member by name or email.
// Self-mentions (the viewer) get `mention-self` so they can be highlighted
// differently from mentions of other people. Pure + dependency-light so the
// rule is unit-testable by rendering strings.

export type MentionViewer = {
  members: MentionCandidate[];
  currentUserId: string | null;
};

type MentionToken = { id: string; token: string; isSelf: boolean };

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildTokens(viewer: MentionViewer): MentionToken[] {
  const tokens: MentionToken[] = [];
  for (const member of viewer.members) {
    const isSelf = member.id === viewer.currentUserId;
    for (const handle of [member.name, member.email]) {
      const value = typeof handle === "string" ? handle.trim() : "";
      if (value) tokens.push({ id: member.id, token: value, isSelf });
    }
  }
  // Longest handle first so "@Ada Lovelace" wins over "@Ada".
  return tokens.sort((a, b) => b.token.length - a.token.length);
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
addLatexSupport(md);

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Inline rule: at an `@` that begins a recognized member handle, emit a mention
// token. The `@` must start the text or follow whitespace/an opening bracket,
// and the handle must not be followed by a word char (so partial names don't
// match). Tokens come from env.mentionTokens (set by renderCommentHtml).
md.inline.ruler.before("emphasis", "mention", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;
  const tokens = (state.env as { mentionTokens?: MentionToken[] })?.mentionTokens;
  if (!tokens || tokens.length === 0) return false;

  const prev = state.pos > 0 ? state.src[state.pos - 1] : "";
  if (prev && !/\s|[([{>"']/.test(prev)) return false;

  const rest = state.src.slice(state.pos + 1);
  const restLower = rest.toLowerCase();
  let best: MentionToken | null = null;
  for (const candidate of tokens) {
    if (!restLower.startsWith(candidate.token.toLowerCase())) continue;
    const after = rest[candidate.token.length] ?? "";
    if (/\w/.test(after)) continue; // longer handle present — not a match here
    if (!best || candidate.token.length > best.token.length) best = candidate;
  }
  if (!best) return false;

  if (!silent) {
    const token = state.push("mention", "span", 0);
    token.content = "@" + rest.slice(0, best.token.length);
    token.meta = { userId: best.id, isSelf: best.isSelf };
  }
  state.pos += 1 + best.token.length;
  return true;
});

md.renderer.rules.mention = (tokens, idx) => {
  const meta = (tokens[idx].meta ?? {}) as { userId?: string; isSelf?: boolean };
  const cls = meta.isSelf ? "mention mention-self" : "mention mention-other";
  const userId = escapeHtmlAttr(meta.userId ?? "");
  const label = escapeHtmlAttr(tokens[idx].content);
  return `<span class="${cls}" data-mention-user-id="${userId}">${label}</span>`;
};

/** Render a comment body to HTML, highlighting recognized @mentions. */
export function renderCommentHtml(body: string, viewer: MentionViewer): string {
  const mentionTokens = buildTokens(viewer);
  return md.render(body.trim() || "", { mentionTokens });
}
