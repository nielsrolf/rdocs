import { redirect } from "next/navigation";

import { AgentSetupClient } from "./agent-setup-client";
import { DEFAULT_AGENT_EFFORT, DEFAULT_AGENT_MODEL } from "@/agent-core/agent-config";
import { listAgentPresets } from "@/lib/agent-presets";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { runCredentialChoices } from "@/lib/run-credential-policy";
import { getUserCredentialsMasked } from "@/lib/user-credentials";
import { listBudgetProvisioners } from "@/lib/workspace-budget";

export default async function AgentSetupPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const get = (key: string) => typeof query[key] === "string" ? query[key] as string : "";
  const user = await getCurrentUser();
  if (!user) {
    const setupQuery = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") setupQuery.set(key, value);
    }
    redirect(`/sign-in?next=${encodeURIComponent(`/agent-setup?${setupQuery}`)}`);
  }
  const sourceUrl = get("source_url").replace(/\/$/, "");
  // `credentials=choose`: the integration runs third-party instructions, so the
  // user picks here which of their keys the new channel may ever use.
  const credentialChoices = get("credentials") === "choose"
    ? runCredentialChoices(await getUserCredentialsMasked(user!.id))
    : null;
  const [provisioners, presets, librarySkills, account] = await Promise.all([
    listBudgetProvisioners(user!.id),
    listAgentPresets(user!.id),
    db.userSkill.findMany({ where: { userId: user!.id }, orderBy: { name: "asc" }, select: { name: true, description: true } }),
    db.user.findUnique({ where: { id: user!.id }, select: { defaultAgentModel: true, defaultAgentEffort: true } })
  ]);
  return <AgentSetupClient
    manifestUrl={get("manifest_url") || sourceUrl}
    credentialChoices={credentialChoices}
    budgetProvisioners={provisioners}
    presets={presets.map(({ id, name, config }) => ({ id, name, config }))}
    librarySkills={librarySkills}
    defaults={{
      model: account?.defaultAgentModel || DEFAULT_AGENT_MODEL,
      effort: account?.defaultAgentEffort || DEFAULT_AGENT_EFFORT
    }}
  />;
}
