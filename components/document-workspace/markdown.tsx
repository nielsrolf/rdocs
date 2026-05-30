import MarkdownIt from "markdown-it";
import { useMemo } from "react";

import { renderCommentHtml, type MentionViewer } from "@/lib/mention-markdown";
import { getSourceLabel } from "@/lib/sources";

import { escapeHtml } from "./utils";

export const aiEditMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

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
  const renderedHtml = trimmed ? aiEditMarkdown.render(trimmed) : "<p></p>";

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
