// Host dev mode: lets an allowlisted Slack channel drive an agent that runs
// UNSANDBOXED on the host machine — in the live deployment directory
// (process.cwd()) or in a per-channel configured directory — so services can
// be developed via the Slack bot itself (the claudex-dev pattern).
//
// This is a deliberate hole in the trust model, so it is doubly gated by env
// config: the channel must be allowlisted AND the triggering user's rdocs
// email must be allowlisted. Anyone else in the same channel gets a normal
// sandboxed run. Nothing here activates unless SLACK_DEV_ALLOWED_EMAILS and
// at least one channel allowlist are set.
//
// Env config:
//   SLACK_DEV_ALLOWED_EMAILS = a@x.com,b@y.com        (required gate)
//   SLACK_DEV_CHANNEL_IDS    = C0AA…,C0BB…             → run in process.cwd()
//   SLACK_DEV_CHANNEL_DIRS   = C0CC…=/abs/dir,#name=/abs/dir
//     Entries keyed by channel id, or by "#<channel-name>" (matched against
//     the channel's current Slack name — note a channel rename moves the
//     mapping with it, which is why the email gate stays mandatory).

function parseList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseDirMap(value: string | undefined): Array<{ key: string; dir: string }> {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const eq = entry.indexOf("=");
      if (eq <= 0) return [];
      const key = entry.slice(0, eq).trim().toLowerCase();
      const dir = entry.slice(eq + 1).trim();
      return key && dir ? [{ key, dir }] : [];
    });
}

/**
 * The host directory an allowlisted dev run should execute in, or null for a
 * normal sandboxed run. `channelName` (without "#") is optional — pass it when
 * available so "#name=/dir" mappings can match channels by name.
 */
export function resolveHostDevDir(
  channelId: string,
  channelName: string | null | undefined,
  userEmail: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string | null {
  const emails = parseList(env.SLACK_DEV_ALLOWED_EMAILS);
  if (!userEmail || !emails.includes(userEmail.trim().toLowerCase())) return null;
  const id = channelId.trim().toLowerCase();
  if (parseList(env.SLACK_DEV_CHANNEL_IDS).includes(id)) return process.cwd();
  const name = channelName?.trim().toLowerCase().replace(/^#/, "") || null;
  for (const entry of parseDirMap(env.SLACK_DEV_CHANNEL_DIRS)) {
    if (entry.key === id) return entry.dir;
    if (name && entry.key === `#${name}`) return entry.dir;
  }
  return null;
}

export function isHostDevRun(
  channelId: string,
  userEmail: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  return resolveHostDevDir(channelId, null, userEmail, env) !== null;
}
