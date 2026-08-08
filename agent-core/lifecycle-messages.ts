// The run-lifecycle progress protocol, in one place.
//
// agent-core emits these as `system` progress events; the agent panel
// (components/document-workspace/agent-timeline.tsx) renders any event matching
// one of them as a quiet step row rather than agent prose, and the final-reply
// badge keys off the submit step. That used to be a verbatim-string contract
// duplicated across producers (agent.ts, codex-agent.ts), the API routes that
// seed AiRun.progress, and the client matcher — reword one copy and the client
// silently stops recognising the step.
//
// This module is the single source. It must stay dependency-free: it is
// imported both by agent-core (which runs inside the container, framework-free)
// and by client components.

export const RUN_STARTED_CLAUDE = "Starting Claude research agent.";
export const RUN_STARTED_CODEX = "Starting Codex research agent.";
export const RUN_STARTED_LOCAL_FALLBACK =
  "Starting free local model agent (no credential connected — this is slow).";
export const RUN_STARTED_SLACK = "Starting Claude research agent from Slack.";
export const RUN_RETRYING = "Retrying research agent.";
export const SUBMITTING_FINAL_RESPONSE = "Submitting final response.";
export const PREPARING_DOCUMENT_UPDATE = "Preparing document update.";

export function submissionRejectedMessage(error: string): string {
  return `Submission rejected: ${error}`;
}

/**
 * The label the agent panel shows for a lifecycle event, or null when the
 * message is ordinary agent output. Producers and this recogniser live in the
 * same file so they cannot drift; the trailing period is optional and a
 * "… from Slack" suffix still counts as a run start.
 */
export function lifecycleStepLabel(message: string): string | null {
  const t = message.trim();
  if (/^Starting (?:Claude|Codex) research agent(?: from Slack)?\.?$/.test(t)) return "Run started";
  if (/^Starting free local model agent\b.*$/.test(t)) return "Run started";
  if (/^Retrying (?:Claude )?research agent\.?$/.test(t)) return "Run started";
  if (/^Submitting final response\.?$/.test(t)) return "Submitting final response";
  if (/^Preparing document update\.?$/.test(t)) return "Finishing up";
  return null;
}

/** Matches the step label the final-reply badge keys off. */
export const SUBMIT_STEP_LABEL = "Submitting final response";
