import { redirect } from "next/navigation";

import { SettingsNav } from "@/components/settings-nav";
import { SlackConnectConfig } from "@/components/slack-connect-config";
import { getCurrentUser } from "@/lib/auth";
import { freeLocalAgentModel } from "@/lib/user-credentials";

// "AI & credentials" section of the settings screen (AI credentials, default
// model, MCP tokens, skill library, self-hosted worker). Same component as
// the post-Slack-connect landing page, with a neutral banner. Linked from the
// topbar "Settings" button — this page replaced the old topbar
// "AI credentials" popup. Sibling sections live under /settings/<section>
// (see components/settings-nav.tsx).
export default async function AgentSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  return (
    <main className="slack-connect-shell">
      <div className="settings-page">
        <SettingsNav />
        <SlackConnectConfig
          email={user.email}
          localModel={freeLocalAgentModel()}
          variant="settings"
        />
      </div>
    </main>
  );
}
