import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { GroupsManager } from "@/components/groups-manager";
import { SettingsNav } from "@/components/settings-nav";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Groups — r-docs" };

export const dynamic = "force-dynamic";

// Groups section of the settings screen: create/rename/delete groups and
// manage members. Sharing a document WITH a group still happens in the
// document's share menu. (Moved here from the old standalone /groups page,
// which now redirects.)
export default async function GroupsSettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const groups = await db.group.findMany({
    where: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      ownerId: true,
      members: {
        orderBy: { createdAt: "asc" },
        select: { userId: true, role: true, user: { select: { name: true, email: true } } }
      },
      // Documents shared with this group, so members can see what access it carries.
      documentAccess: {
        orderBy: { createdAt: "asc" },
        select: { permission: true, document: { select: { id: true, title: true } } }
      }
    }
  });

  const initialGroups = groups.map((group) => ({
    id: group.id,
    name: group.name,
    isOwner: group.ownerId === user.id,
    members: group.members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role
    })),
    documents: group.documentAccess.map((g) => ({
      id: g.document.id,
      title: g.document.title,
      permission: g.permission
    }))
  }));

  return (
    <main className="slack-connect-shell">
      <div className="settings-page">
        <SettingsNav />
        <div className="slack-connect-card">
          <section className="credentials-section slack-connect-success">
            <strong className="credentials-section-title">Groups</strong>
            <p>
              Create groups of collaborators, then share documents with a whole group at once from
              any document&apos;s share menu.
            </p>
          </section>
          <GroupsManager initialGroups={initialGroups} />
        </div>
      </div>
    </main>
  );
}
