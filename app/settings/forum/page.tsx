import { redirect } from "next/navigation";

import { ForumSettings } from "@/components/forum-settings";
import { SettingsNav } from "@/components/settings-nav";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getQuicktakeVisibility } from "@/lib/quicktakes";

// Forum section of the settings screen: default quicktake audience.
export default async function ForumSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const [visibility, groups] = await Promise.all([
    getQuicktakeVisibility(user.id),
    db.group.findMany({
      where: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    })
  ]);

  return (
    <main className="slack-connect-shell">
      <div className="settings-page">
        <SettingsNav />
        <div className="slack-connect-card">
          <section className="credentials-section slack-connect-success">
            <strong className="credentials-section-title">Forum</strong>
            <p>Preferences for the forum reading mode.</p>
          </section>
          <ForumSettings
            groups={groups}
            initialGroupId={visibility.groupId}
            initialGroupName={visibility.groupName}
          />
        </div>
      </div>
    </main>
  );
}
