// Operator flow for the /agent-setup integration: provision an integration's agent
// document for an existing user straight from the host, without the browser consent
// page (same steps: lib/agent-setup.ts). Use it to script setups an integration
// would otherwise hand to a human as a setup link.
//
//   set -a && . ./.env && set +a && npx tsx scripts/provision-agent.ts \
//     --email someone@example.com --manifest-url <url> --credential <one-time credential>
//
// A setup link `…/agent-setup?manifest_url=<url>#credential=<c>` carries both values.

import { agentSetupSchema, provisionAgentSetup } from "../lib/agent-setup";
import { isAllowedAgentSetupUrl } from "../lib/agent-setup-origins";
import { db } from "../lib/db";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const email = arg("email");
  const manifestUrl = arg("manifest-url");
  const credential = arg("credential");
  if (!isAllowedAgentSetupUrl(manifestUrl)) throw new Error("manifest origin is not in AGENT_SETUP_ALLOWED_ORIGINS");

  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`no r-docs user with email ${email}`);

  const response = await fetch(manifestUrl, {
    headers: { authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`manifest fetch failed: ${response.status} ${await response.text()}`);
  const manifest = await response.json();
  const input = agentSetupSchema.parse({
    title: manifest.title,
    markdown: manifest.markdown,
    environment: manifest.environment,
    skillMarkdown: manifest.skill_markdown,
    skillName: manifest.skill_name,
    channelLabel: manifest.channel_label,
    callbackUrl: manifest.callback_url,
    callbackCredential: credential,
    callbackBody: manifest.callback_body,
    mcpServers: manifest.mcp_servers
  });
  const result = await provisionAgentSetup(user.id, input);
  // The trigger token went to the integration's callback; do not print it.
  console.log(JSON.stringify({ documentId: result.documentId, documentUrl: result.documentUrl, triggerId: result.triggerId }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
