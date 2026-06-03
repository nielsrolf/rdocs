import fs from "node:fs/promises";
import path from "node:path";

// Node-safe helpers for validating and normalizing an agent's edit_selection
// submission. Extracted from the ai-edit route so the guard logic (which decides
// whether an error is reported back to the AI for a retry vs. surfaced to the
// user) is unit-testable. The route still owns the async widget BUILD step;
// these are the pure/filesystem checks.

export function buildRepoFileUrl(
  documentId: string,
  filePath: string,
  shareToken: string | null,
  aiRunId: string | null
) {
  const params = new URLSearchParams({ path: filePath });
  if (shareToken) {
    params.set("share", shareToken);
  }
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
