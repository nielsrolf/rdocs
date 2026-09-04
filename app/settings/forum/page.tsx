import { redirect } from "next/navigation";

import { ForumLayoutToggle } from "@/components/forum/forum-layout-toggle";
import { ForumSettings } from "@/components/forum-settings";
import { SettingsNav } from "@/components/settings-nav";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeForumLayout } from "@/lib/forum-layout";
import { getQuicktakeVisibility } from "@/lib/quicktakes";

// Forum section of the settings screen: frontpage layout + default quicktake audience.
export default async function ForumSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const [visibility, groups, userRow] = await Promise.all([
    getQuicktakeVisibility(user.id),
    db.group.findMany({
      where: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    }),
    db.user.findUnique({ where: { id: user.id }, select: { forumLayout: true } })
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
          <section className="credentials-section">
            <strong className="credentials-section-title">Frontpage layout</strong>
            <p className="muted-copy">
              Show posts and quick takes as one ranked feed, or keep quick takes in their own
              section above the post list. Also switchable from the forum page itself.
            </p>
            <ForumLayoutToggle value={normalizeForumLayout(userRow?.forumLayout)} />
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
