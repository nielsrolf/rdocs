// Host dev mode: lets an allowlisted Slack channel drive an agent that runs
// UNSANDBOXED in the live deployment directory (process.cwd()) — real repo,
// real DB, real .env — so rdocs can be developed via the Slack bot itself
// (the claudex-dev pattern).
//
// This is a deliberate hole in the trust model, so it is doubly gated by env
// config: the channel id must be allowlisted AND the triggering user's rdocs
// email must be allowlisted. Anyone else in the same channel gets a normal
// sandboxed run. Nothing here activates unless BOTH env vars are set.

function parseList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isHostDevRun(
  channelId: string,
  userEmail: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  const channels = parseList(env.SLACK_DEV_CHANNEL_IDS);
  const emails = parseList(env.SLACK_DEV_ALLOWED_EMAILS);
  if (channels.length === 0 || emails.length === 0) return false;
  if (!channels.includes(channelId.trim().toLowerCase())) return false;
  return Boolean(userEmail && emails.includes(userEmail.trim().toLowerCase()));
}
