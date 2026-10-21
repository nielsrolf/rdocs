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
addTaskListSupport(aiEditInsertMarkdown);

const TASK_PREFIX = /^\[([ xX])\][ \t]+/;

// GitHub-style task lists ("- [ ] todo", "- [x] done", which getDocumentMarkdown
// emits for taskList) → the HTML TipTap's TaskList/TaskItem parse. Without it an
// agent echoing a checklist turned it into bullets reading "[ ] todo". A list
// converts only when EVERY direct item starts with a checkbox.
function addTaskListSupport(md: MarkdownIt) {
  md.core.ruler.after("inline", "task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type !== "bullet_list_open") continue;
      const level = tokens[i].level;
      const items: Array<{ item: number; inline: number }> = [];
      let convertible = true;
      for (let j = i + 1; j < tokens.length; j += 1) {
        const token = tokens[j];
        if (token.type === "bullet_list_close" && token.level === level) break;
        if (token.type !== "list_item_open" || token.level !== level + 1) continue;
        const inline = tokens[j + 2];
        if (inline?.type !== "inline" || !TASK_PREFIX.test(inline.content)) {
          convertible = false;
          break;
        }
        items.push({ item: j, inline: j + 2 });
      }
      if (!convertible || items.length === 0) continue;
      tokens[i].attrSet("data-type", "taskList");
      for (const { item, inline } of items) {
        const prefix = TASK_PREFIX.exec(tokens[inline].content)!;
        tokens[item].attrSet("data-type", "taskItem");
        tokens[item].attrSet("data-checked", prefix[1] === " " ? "false" : "true");
        tokens[inline].content = tokens[inline].content.slice(prefix[0].length);
        // markdown-it may have split "[ ] todo" across several text children.
        let remaining = prefix[0].length;
        for (const child of tokens[inline].children ?? []) {
          if (remaining <= 0) break;
          if (child.type !== "text") break;
          const cut = Math.min(remaining, child.content.length);
          child.content = child.content.slice(cut);
          remaining -= cut;
        }
      }
    }
  });
}

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
