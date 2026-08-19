import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { GroupsManager } from "@/components/groups-manager";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Groups — r-docs" };

export const dynamic = "force-dynamic";

// Dedicated group-management page: create/rename/delete groups and manage
// members outside the share modal. Sharing a document WITH a group still
// happens in the document's share menu.
export default async function GroupsPage() {
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
    <main className="dashboard-shell">
      <section className="dashboard-header">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1>Groups</h1>
          <p>
            Create groups of collaborators, then share documents with a whole group at once from
            any document&apos;s share menu.
          </p>
        </div>
        <div className="dashboard-header-actions">
          <Link className="ghost-button" href="/dashboard">
            Dashboard
          </Link>
          <Link className="ghost-button" href="/forum">
            Forum
          </Link>
        </div>
      </section>

      <GroupsManager initialGroups={initialGroups} />
    </main>
  );
}
