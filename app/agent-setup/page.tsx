import { redirect } from "next/navigation";

import { AgentSetupClient } from "./agent-setup-client";
import { getCurrentUser } from "@/lib/auth";

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
  return <AgentSetupClient
    manifestUrl={get("manifest_url") || sourceUrl}
  />;
}
