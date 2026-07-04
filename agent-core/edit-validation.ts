// Submission validation for edit_selection runs, expressed as a SERIALIZABLE
// spec rather than an app-side closure, so the exact same validator can run
// in-process (InProcessRunner) or inside the container (entrypoint, from the
// job's `validation` field). The untrusted half — building the agent's widget
// and checking its embed_source — runs wherever the validator runs, which means
// it runs IN-SANDBOX when the container runner is used. The rules themselves are
// not secret, so shipping them into the container is fine and avoids a callback
// channel during the run.

import type { ClaudeAgentSubmissionValidator } from "./agent";
import {
  embedSourceExists,
  hasMarkdownImage,
  normalizeSubmittedWidget,
  validateAgentComments,
  validateAiEditAssets,
  validateSuggestions,
  type EditAssetIntent,
  type NormalizedSubmittedWidget
} from "./ai-edit-submission";
import { runWidgetBuild } from "./widget-build";

// `documentText` is the flattened text-node basis (lib/suggestion-content.
// flattenDocumentTextNodes) the client resolves anchors against — present on
// every kind so suggestion anchors can be validated wherever the agent runs.
export type SubmissionValidationSpec =
  | {
      kind: "edit_selection";
      selectedText: string;
      assetIntent: EditAssetIntent;
      documentText: string;
    }
  | { kind: "comment_reply"; documentText: string }
  | { kind: "conversation"; documentText: string };

/** Build the agent's widget, then confirm it produced its embed_source. */
export async function buildAndVerifyWidget(
  widget: NormalizedSubmittedWidget,
  workspace: string
): Promise<{ ok: true; lastBuiltAt: Date } | { ok: false; error: string }> {
  const result = await runWidgetBuild(widget.buildCmd, workspace);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const exists = await embedSourceExists(workspace, widget.embedSource);
  if (!exists) {
    return {
      ok: false,
      error: `Build command succeeded but embed_source "${widget.embedSource}" was not produced in the workspace.`
    };
  }
  return { ok: true, lastBuiltAt: new Date() };
}

/** Reconstruct the edit-selection submission validator from its serializable spec. */
export function buildSubmissionValidator(
  spec: SubmissionValidationSpec,
  ctx: { workspacePath: string | null }
): ClaudeAgentSubmissionValidator {
  return async (submission) => {
    // Suggestion anchors are validated in every mode (edit_selection, comment_reply,
    // conversation) — agents may propose tracked-change edits anywhere.
    const suggestionError = validateSuggestions(submission.suggestions, spec.documentText);
    if (suggestionError) {
      return suggestionError;
    }
    const commentError = validateAgentComments(submission.comments, spec.documentText);
    if (commentError) {
      return commentError;
    }

    // The remaining checks (replacement no-op, required assets, widget build) only
    // apply to the selection-edit replacement payload.
    if (spec.kind !== "edit_selection") {
      return null;
    }

    const submittedImages = Array.isArray(submission.images) ? submission.images : [];
    const submittedWidgets = Array.isArray(submission.widgets) ? submission.widgets : [];
    const hasImage =
      submittedImages.length > 0 || hasMarkdownImage(submission.replacementText ?? "");
    const hasWidget = submittedWidgets.length > 0;
    const assetError = validateAiEditAssets({
      replacementText: submission.replacementText,
      selectedText: spec.selectedText,
      hasImage,
      hasWidget,
      assetIntent: spec.assetIntent
    });
    if (assetError) {
      return assetError;
    }
    if (hasWidget) {
      const workspace = ctx.workspacePath;
      if (!workspace) {
        return "You submitted a widget but no isolated workspace is available. Remove the widget from the submission.";
      }
      for (let i = 0; i < submittedWidgets.length; i += 1) {
        const normalized = normalizeSubmittedWidget(submittedWidgets[i]);
        if (!normalized) {
          return `Widget #${i + 1} is missing label, build_cmd, or embed_source. Provide all three and resubmit.`;
        }
        const result = await buildAndVerifyWidget(normalized, workspace);
        if (!result.ok) {
          const truncated =
            result.error.length > 4000 ? `${result.error.slice(0, 4000)}…` : result.error;
          return (
            `Widget "${normalized.label}" (build_cmd: ${normalized.buildCmd}, embed_source: ${normalized.embedSource}) is not ready:\n` +
            `${truncated}\n\n` +
            `Fix the cause — create or repair the build script under widgets/, run it from the repo root (cwd is the workspace), confirm it writes ${normalized.embedSource}, then resubmit.`
          );
        }
      }
    }
    return null;
  };
}
