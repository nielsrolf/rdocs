import MarkdownIt from "markdown-it";
import { useMemo } from "react";

import { addLatexSupport } from "@/lib/latex-markdown";
import { renderCommentHtml, type MentionViewer } from "@/lib/mention-markdown";
import { getSourceLabel } from "@/lib/sources";

import { escapeHtml } from "./utils";

export const aiEditMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});
addLatexSupport(aiEditMarkdown);

// Instance for HTML that is parsed back into document nodes (AI-edit apply,
// MCP edits). Latex must stay literal $...$ text here — the editor renders
// math as decorations over that text; KaTeX HTML would be flattened to junk.
// The rule still has to run so markdown-it doesn't mangle the equation body
// (e.g. `_` inside $\mu_0$ becoming <em>).
const aiEditInsertMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});
addLatexSupport(aiEditInsertMarkdown, { output: "source" });

const defaultLinkOpenRenderer =
  aiEditMarkdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

aiEditMarkdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

export function MarkdownBody({
  body,
  className,
  viewer
}: {
  body: string;
  className: string;
  // When provided, recognized @mentions are highlighted (self vs. other).
  viewer?: MentionViewer;
}) {
  const renderedHtml = useMemo(
    () => (viewer ? renderCommentHtml(body, viewer) : aiEditMarkdown.render(body.trim() || "")),
    [body, viewer]
  );

  return <div className={className} dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
}

export function buildAiEditHtml(replacementText: string, sourceLinks: string[]) {
  const trimmed = replacementText.trim();
  const renderedHtml = trimmed ? aiEditInsertMarkdown.render(trimmed) : "<p></p>";

  if (sourceLinks.length > 0) {
    return `${renderedHtml}<p><strong>Sources:</strong> ${sourceLinks
        .map(
          (sourceLink, index) =>
            `<a href="${escapeHtml(sourceLink)}" target="_blank" rel="noopener noreferrer">[${index + 1}] ${escapeHtml(getSourceLabel(sourceLink))}</a>`
        )
        .join(", ")}</p>`;
  }

  return renderedHtml;
}
