import { redirect } from "next/navigation";

import { NotificationSettings } from "@/components/notification-settings";
import { SettingsNav } from "@/components/settings-nav";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

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
      documentShareSlackNotifications: true,
      forumShareSlackNotifications: true,
      slackLinks: { select: { id: true }, take: 1 }
    }
  });

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
              commentSlackNotifications: row?.commentSlackNotifications ?? true,
              documentShareSlackNotifications: row?.documentShareSlackNotifications ?? false,
              forumShareSlackNotifications: row?.forumShareSlackNotifications ?? false
            }}
            slackLinked={(row?.slackLinks.length ?? 0) > 0}
          />
        </div>
      </div>
    </main>
  );
}
