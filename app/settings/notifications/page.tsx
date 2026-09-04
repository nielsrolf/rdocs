import { redirect } from "next/navigation";

import { NotificationSettings } from "@/components/notification-settings";
import { SettingsNav } from "@/components/settings-nav";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { userDefaultCommentScope } from "@/lib/notification-preferences";
import { listSlackInstallations, slackOAuthConfig } from "@/lib/slack/installations";

// Notifications section of the settings screen: Slack DM comment notifications.
export default async function NotificationSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: {
      commentSlackNotifications: true,
      commentNotificationScope: true,
      documentShareSlackNotifications: true,
      forumShareSlackNotifications: true,
      forumPostSlackNotifications: true,
      notificationSlackTeamId: true,
      slackLinks: { select: { slackTeamId: true }, orderBy: { createdAt: "asc" } }
    }
  });

  // "Add claudex to another Slack workspace" — only when the server has OAuth
  // client credentials (lib/slack/installations.ts). Unlisted: whoever has this
  // page can start an install, Slack still asks the target workspace to approve.
  const slackOAuth = slackOAuthConfig();
  const installations = await listSlackInstallations().catch(() => []);
  const installationNames = new Map(installations.map((entry) => [entry.teamId, entry.teamName]));
  // Workspaces this user's Slack account is linked in — the DM target picker
  // only appears when there is more than one.
  const linkedWorkspaces = (row?.slackLinks ?? []).map((link) => ({
    teamId: link.slackTeamId,
    teamName: installationNames.get(link.slackTeamId) ?? null
  }));

  return (
    <main className="slack-connect-shell">
      <div className="settings-page">
        <SettingsNav />
        <div className="slack-connect-card">
          <section className="credentials-section slack-connect-success">
            <strong className="credentials-section-title">Notifications</strong>
            <p>How you get notified about activity on your documents.</p>
          </section>
          <NotificationSettings
            initialSettings={{
              commentNotificationScope: userDefaultCommentScope(row ?? {}),
              documentShareSlackNotifications: row?.documentShareSlackNotifications ?? false,
              forumShareSlackNotifications: row?.forumShareSlackNotifications ?? false,
              forumPostSlackNotifications: row?.forumPostSlackNotifications ?? true,
              notificationSlackTeamId: row?.notificationSlackTeamId ?? null
            }}
            linkedWorkspaces={linkedWorkspaces}
            slackLinked={linkedWorkspaces.length > 0}
          />
          {slackOAuth ? (
            <section className="credentials-section">
              <strong className="credentials-section-title">Slack workspaces</strong>
              <p className="muted-copy">
                claudex is installed in{" "}
                {installations.length === 0
                  ? "no Slack workspace yet"
                  : installations.map((installation) => installation.teamName ?? installation.teamId).join(", ")}
                . To use it in another workspace, install it there — a workspace admin has to approve the
                install on the Slack side. Members then link their Slack account on first mention, as usual.
              </p>
              <p>
                {/* Goes through /api/slack/install (not the raw slack.com authorize URL) so
                    the signed state token + server-side redirect_uri/scopes stay in effect. */}
                <a href="/api/slack/install" title="Add claudex to another Slack workspace">
                  <img
                    alt="Add to Slack"
                    height={40}
                    width={139}
                    src="https://platform.slack-edge.com/img/add_to_slack.png"
                    srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
                  />
                </a>
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
