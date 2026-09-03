// Kill-switch for OUTBOUND Slack traffic.
//
// The headless suite (`npm test`) runs against the REAL database and calls real
// production code paths — `createQuicktake`, the comment write path, share
// routes — each of which fires a `void notify…()` DM. With `.env` sourced (which
// is how `deploy/deploy.sh` runs them) `SLACK_BOT_TOKEN` is present, so those
// DMs went to real people: on 2026-09-02 a deploy DM'd fixture text like
// "owner posted a quick take: Count only open comments."
//
// So delivery is disabled by default whenever a test runner is in charge, and
// can be forced either way with SLACK_NOTIFICATIONS_DISABLED=1 / =0.
//
// Note this only covers Slack calls made IN THIS PROCESS. `npm run
// test:integration` drives a running server, which has its own environment —
// set SLACK_NOTIFICATIONS_DISABLED=1 there if you point it at a bot token.

export type SlackDeliveryEnv = Record<string, string | undefined>;

function flag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

/** Human-readable reason Slack delivery is off, or null when it is on. */
export function slackDeliveryDisabledReason(env: SlackDeliveryEnv = process.env): string | null {
  const explicit = flag(env.SLACK_NOTIFICATIONS_DISABLED);
  if (explicit === true) return "SLACK_NOTIFICATIONS_DISABLED=1";
  if (explicit === false) return null; // deliberate opt-in, e.g. a live smoke test
  if (env.NODE_ENV === "test") return "NODE_ENV=test";
  if (env.NODE_TEST_CONTEXT) return "node:test runner";
  if (env.VITEST || env.JEST_WORKER_ID) return "test runner";
  if (env.npm_lifecycle_event?.startsWith("test")) return `npm run ${env.npm_lifecycle_event}`;
  return null;
}

export function isSlackDeliveryDisabled(env: SlackDeliveryEnv = process.env): boolean {
  return slackDeliveryDisabledReason(env) !== null;
}

let warned = false;

export function warnSlackDeliveryDisabledOnce(reason: string) {
  if (warned) return;
  warned = true;
  console.warn("[slack] outbound delivery disabled", { reason });
}
