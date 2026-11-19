import { readFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";

// Operator switch: stop agent runs of specific accounts without a deploy.
//
// One email per line in `.agent-paused-emails` in the deployment directory
// (override the path with AGENT_PAUSED_EMAILS_FILE); `#` starts a comment.
// The file is read on every run start, so adding or removing a line takes
// effect at once. Every kind of run (web, Slack, schedule, API channel) goes
// through withAgentRunLifecycle, which asks here first.
function pausedEmailsFile(): string {
  return process.env.AGENT_PAUSED_EMAILS_FILE || path.join(process.cwd(), ".agent-paused-emails");
}

export function parsePausedEmails(text: string): Set<string> {
  const emails = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim().toLowerCase();
    if (line) emails.add(line);
  }
  return emails;
}

export async function pausedRunMessage(createdById: string | null | undefined): Promise<string | null> {
  if (!createdById) return null;
  let text: string;
  try {
    text = await readFile(pausedEmailsFile(), "utf8");
  } catch {
    return null; // no file: nobody is paused
  }
  const paused = parsePausedEmails(text);
  if (paused.size === 0) return null;
  const user = await db.user.findUnique({ where: { id: createdById }, select: { email: true } }).catch(() => null);
  if (!user?.email || !paused.has(user.email.toLowerCase())) return null;
  return `Agent runs for ${user.email} are paused by the administrator for now. Nothing was run. Please ask Niels before retrying.`;
}
