import fs from "node:fs/promises";
import path from "node:path";

import { findAnchorMatch } from "./anchor-text";

// Node-safe helpers for validating and normalizing an agent's edit_selection
// submission. Extracted from the ai-edit route so the guard logic (which decides
// whether an error is reported back to the AI for a retry vs. surfaced to the
// user) is unit-testable. The route still owns the async widget BUILD step;
// these are the pure/filesystem checks.

export function buildRepoFileUrl(
  documentId: string,
  filePath: string,
  _shareToken: string | null,
  aiRunId: string | null
) {
  const params = new URLSearchParams({ path: filePath });
  if (aiRunId) {
    params.set("run", aiRunId);
  }
  return `/api/documents/${documentId}/repo-files?${params.toString()}`;
}

export type NormalizedAgentImage = {
  path: string;
  src: string;
  alt: string;
  caption: string | null;
};

export function normalizeAgentImages(
  images: unknown,
  documentId: string,
  shareToken: string | null,
  aiRunId: string | null
): NormalizedAgentImage[] {
  if (!Array.isArray(images)) {
    return [];
  }

  return images
    .map((image) => {
      if (!image || typeof image !== "object") {
        return null;
      }
      const typed = image as { path?: unknown; alt?: unknown; caption?: unknown };
      if (typeof typed.path !== "string" || !typed.path.trim()) {
        return null;
      }
      const filePath = typed.path.trim();
      return {
        path: filePath,
        src: buildRepoFileUrl(documentId, filePath, shareToken, aiRunId),
        alt: typeof typed.alt === "string" ? typed.alt : filePath,
        caption: typeof typed.caption === "string" ? typed.caption : null
      };
    })
    .filter((image): image is NormalizedAgentImage => image != null);
}

export function hasMarkdownImage(text: string) {
  return /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.test(text);
}

// A legacy [Interactive widget: <label>](src) link — the old serialization form.
// Agents should place widgets via the ![widget: <label>](widget://<id>) placeholder
// (existing widgets they were shown) or the widgets array (new widgets); echoing
// the legacy prose form is what put literal widget metadata into documents.
const LEGACY_WIDGET_LINK = /\[Interactive widget:[^\]]*\]\([^)]*\)/i;

// Chat-mode openers we reject at the START of a replacement. The list is kept
// tight (each anchored, high-signal phrase) to avoid tripping on legitimate prose
// that merely contains "changed"/"updated" mid-sentence.
const META_COMMENTARY_PREFIX =
  /^\s*(?:as (?:requested|instructed|asked)|here(?:'s| is) (?:the|your|an? )|i(?:'ve| have)? (?:changed|updated|revised|rewrote|rewritten|removed|added|made|replaced|adjusted|reworded)|i (?:changed|updated|revised|removed|added|replaced|adjusted|reworded)|unlike (?:before|the (?:previous|original))|per your (?:request|instruction))\b/i;

export type NormalizedSubmittedWidget = {
  label: string;
  buildCmd: string;
  embedSource: string;
};

export function normalizeSubmittedWidget(widget: unknown): NormalizedSubmittedWidget | null {
  if (!widget || typeof widget !== "object") return null;
  const typed = widget as {
    label?: unknown;
    build_cmd?: unknown;
    buildCmd?: unknown;
    embed_source?: unknown;
    embedSource?: unknown;
  };
  const label =
    typeof typed.label === "string" && typed.label.trim() ? typed.label.trim() : "Interactive widget";
  const buildCmd =
    typeof typed.build_cmd === "string"
      ? typed.build_cmd.trim()
      : typeof typed.buildCmd === "string"
        ? typed.buildCmd.trim()
        : "";
  const embedSource =
    typeof typed.embed_source === "string"
      ? typed.embed_source.trim()
      : typeof typed.embedSource === "string"
        ? typed.embedSource.trim()
        : "";
  if (!buildCmd || !embedSource) return null;
  return { label, buildCmd, embedSource };
}

// True only if `embedSource` resolves to an existing file INSIDE `workspace`.
// Rejects path traversal (e.g. "../../etc/passwd") because the resolved path
// must stay under the workspace root.
export async function embedSourceExists(workspace: string, embedSource: string): Promise<boolean> {
  const resolved = path.resolve(workspace, embedSource);
  const workspaceRoot = path.resolve(workspace);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    return false;
  }
  try {
    const stat = await fs.stat(resolved);
    return stat.isFile();
  } catch {
    return false;
  }
}

export type EditAssetIntent = {
  requiresAnyAsset: boolean;
  requiresImage: boolean;
  requiresWidget: boolean;
};

// Tracked-change edit suggestions the agent proposes via submit_response. Each is
// an anchored find/replace: `findText` must locate a UNIQUE match in the
// document's flattened anchor text (lib/suggestion-content.flattenDocumentAnchorText)
// via the tolerant matcher in ./anchor-text — the same basis and matcher the
// client resolves against, so what passes validation here resolves to exactly
// one range there.
export type AgentSuggestion = {
  findText: string;
  replacementText: string;
  reason?: string;
};

const MAX_SUGGESTIONS = 50;
const MAX_SUGGESTION_FIELD_LENGTH = 20_000;

export function normalizeSuggestions(value: unknown): AgentSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: AgentSuggestion[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const cast = entry as { findText?: unknown; replacementText?: unknown; reason?: unknown };
    if (typeof cast.findText !== "string" || !cast.findText) continue;
    if (typeof cast.replacementText !== "string") continue;
    const suggestion: AgentSuggestion = {
      findText: cast.findText.slice(0, MAX_SUGGESTION_FIELD_LENGTH),
      replacementText: cast.replacementText.slice(0, MAX_SUGGESTION_FIELD_LENGTH)
    };
    if (typeof cast.reason === "string" && cast.reason) {
      suggestion.reason = cast.reason.slice(0, 2_000);
    }
    out.push(suggestion);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

// A standalone comment an agent anchors on a section of the document (distinct
// from its reply to the triggering thread). `findText` must locate a unique
// match in the anchor text (same tolerant matching as suggestions); `body` is
// the comment text.
export type AgentComment = {
  findText: string;
  body: string;
};

const MAX_AGENT_COMMENTS = 50;

export function normalizeAgentComments(value: unknown): AgentComment[] {
  if (!Array.isArray(value)) return [];
  const out: AgentComment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const cast = entry as { findText?: unknown; body?: unknown };
    if (typeof cast.findText !== "string" || !cast.findText) continue;
    if (typeof cast.body !== "string" || !cast.body.trim()) continue;
    out.push({
      findText: cast.findText.slice(0, MAX_SUGGESTION_FIELD_LENGTH),
      body: cast.body.slice(0, 4000)
    });
    if (out.length >= MAX_AGENT_COMMENTS) break;
  }
  return out;
}

// Comments the agent left mid-run via the add_comment tool that were NOT
// delivered live (no onComment handler in scope) are buffered and merged into
// the final output here, skipping any the agent also repeated in
// submit_response's comments array.
export function mergeBufferedComments(
  submitted: AgentComment[],
  buffered: AgentComment[]
): AgentComment[] {
  const fresh = buffered.filter(
    (comment) =>
      !submitted.some((other) => other.findText === comment.findText && other.body === comment.body)
  );
  return [...fresh, ...submitted];
}

// Shared anchor check for one findText. Returns null when it matches exactly one
// place, else an actionable error line the agent can act on. Uses the tolerant
// tiered matcher (exact → newline-normalized → markdown-stripped) so an anchor
// faithfully copied from the prompt's plain-text view or a markdown rendition
// still validates — see ./anchor-text.
function anchorError(label: string, findText: string, documentText: string): string | null {
  const match = findAnchorMatch(documentText, findText);
  if (match.count === 1) return null;
  if (match.count === 0) {
    return `${label}: findText ${JSON.stringify(
      findText.slice(0, 120)
    )} was not found in the document. Matching runs against the document's plain text (formatting like links and bold is stripped, blocks are separated by single newlines). Anchor on a short, distinctive snippet of visible text — ideally within one paragraph or list item.`;
  }
  return `${label}: findText ${JSON.stringify(
    findText.slice(0, 120)
  )} matches ${match.count} places — extend it with surrounding words until it identifies exactly one location.`;
}

// Joins per-item anchor errors so the agent can fix EVERYTHING in one resubmission
// instead of burning one attempt per broken anchor.
function combineAnchorErrors(errors: string[]): string | null {
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0];
  return `${errors.length} anchors failed — fix ALL of them, then resubmit once:\n${errors.join("\n")}`;
}

export function validateAgentComments(
  comments: AgentComment[] | undefined,
  documentText: string
): string | null {
  if (!comments || comments.length === 0) return null;
  if (comments.length > MAX_AGENT_COMMENTS) {
    return `Too many comments (${comments.length}). Leave at most ${MAX_AGENT_COMMENTS}.`;
  }
  const errors: string[] = [];
  for (let i = 0; i < comments.length; i += 1) {
    const { findText, body } = comments[i];
    const label = `Comment #${i + 1}`;
    if (!findText) {
      errors.push(`${label}: findText is empty. Provide a substring of the document to anchor the comment on.`);
      continue;
    }
    if (!body.trim()) {
      errors.push(`${label}: body is empty. Provide the comment text.`);
      continue;
    }
    const error = anchorError(label, findText, documentText);
    if (error) errors.push(error);
  }
  return combineAnchorErrors(errors);
}

// Pure guard mirroring validateAiEditAssets: returns an error STRING handed back
// to the agent (so it can fix anchors and resubmit) or null. Never throws.
export function validateSuggestions(
  suggestions: AgentSuggestion[] | undefined,
  documentText: string
): string | null {
  if (!suggestions || suggestions.length === 0) return null;
  if (suggestions.length > MAX_SUGGESTIONS) {
    return `Too many suggestions (${suggestions.length}). Submit at most ${MAX_SUGGESTIONS} focused edits.`;
  }
  const errors: string[] = [];
  for (let i = 0; i < suggestions.length; i += 1) {
    const { findText, replacementText } = suggestions[i];
    const label = `Suggestion #${i + 1}`;
    if (!findText) {
      errors.push(`${label}: findText is empty. Provide a substring of the document to anchor the edit.`);
      continue;
    }
    const error = anchorError(label, findText, documentText);
    if (error) {
      errors.push(error);
      continue;
    }
    if (replacementText === findText) {
      errors.push(`${label}: replacementText is identical to findText — no change. Edit the text or drop this suggestion.`);
    }
  }
  return combineAnchorErrors(errors);
}

// Pure guard: returns an error STRING (which the route hands back to the agent
// via the submit_response tool so it can fix and resubmit) or null when the
// submission is acceptable. These checks must NOT throw — throwing surfaces the
// error to the human user instead of giving the agent a chance to retry.
export function validateAiEditAssets(input: {
  replacementText: string | undefined;
  selectedText: string;
  hasImage: boolean;
  hasWidget: boolean;
  assetIntent: EditAssetIntent;
}): string | null {
  const replacement = typeof input.replacementText === "string" ? input.replacementText : "";
  const trimmedReplacement = replacement.trim();
  const trimmedSelected = input.selectedText.trim();

  if (!trimmedReplacement && !input.hasImage && !input.hasWidget) {
    return "Your submission has no replacementText (and no images or widgets). Provide the new Markdown for the selection in replacementText and resubmit.";
  }
  if (trimmedReplacement && trimmedReplacement === trimmedSelected) {
    return "Your replacementText is identical to the user's selected text — no change was made. Apply the requested edit to the text and resubmit, or return the modified Markdown that reflects the instruction.";
  }
  if (LEGACY_WIDGET_LINK.test(replacement)) {
    return (
      "Your replacementText contains literal widget-metadata prose in the form " +
      "[Interactive widget: ...](...). That is NOT how widgets are placed and it renders as broken text in the document. " +
      "To place an EXISTING widget, echo its placeholder unchanged: ![widget: <label>](widget://<widgetId>) (the widgetId is shown in the document context). " +
      "To place a NEW widget, add it to the widgets array and reference it inline with ![widget: <label>](widget://new). " +
      "Remove the literal [Interactive widget: ...] text and resubmit."
    );
  }
  if (META_COMMENTARY_PREFIX.test(replacement)) {
    return (
      "Your replacementText begins with chat-style meta-commentary (e.g. \"As requested\", \"I changed…\", \"Here is…\"). " +
      "replacementText is spliced verbatim into the document in place of the selection — write ONLY the finished document prose a reader should see. " +
      "Do not address the user, announce or describe the change, or reference the instruction or the previous version. Rewrite the replacement as drop-in document content and resubmit."
    );
  }
  if (input.assetIntent.requiresAnyAsset && !input.hasImage && !input.hasWidget) {
    return "The edit request asked for a figure or widget, but the submission included neither. Add an image (via the images array, after committing the file to the repo) or a widget (via the widgets array) and resubmit.";
  }
  if (input.assetIntent.requiresImage && !input.hasImage) {
    return "The edit request asked for a figure or visual. Generate the image, commit it to the repo, and include it in the images array (or as a Markdown image in replacementText). Then resubmit.";
  }
  if (input.assetIntent.requiresWidget && !input.hasWidget) {
    return "The edit request asked for an interactive widget. Build the HTML widget and include it in the widgets array (with label, build_cmd, embed_source). Then resubmit.";
  }
  return null;
}
