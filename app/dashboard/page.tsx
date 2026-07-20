import { redirect } from "next/navigation";

import type { InboxThreadView } from "@/components/comment-inbox";
import { DashboardTabs } from "@/components/dashboard-tabs";
import { NewDocumentButton } from "@/components/new-document-button";
import { OnboardingTour, TourRestartButton } from "@/components/onboarding-tour";
import { getCurrentUser } from "@/lib/auth";
import {
  getDocumentCommentStats,
  listAccessibleDocumentsForUser,
  listTaggedThreadsForUser
} from "@/lib/document-data";
import { getDocumentMentionStats } from "@/lib/mention-data";

type DashboardPageProps = {
  searchParams?: Promise<{ tab?: string }>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialTab =
    resolvedSearchParams?.tab === "comments"
      ? ("comments" as const)
      : resolvedSearchParams?.tab === "channels"
        ? ("channels" as const)
        : ("documents" as const);

  const accessibleDocuments = await listAccessibleDocumentsForUser(user.id);
  const docIds = accessibleDocuments.map((d) => d.id);

  // Aggregated in SQL rather than loading every comment for every document.
  const [{ unreadByDoc, lastCommentByDoc }, mentionByDoc, inbox] = await Promise.all([
    getDocumentCommentStats(user.id, docIds),
    getDocumentMentionStats(user.id, docIds),
    listTaggedThreadsForUser(user.id)
  ]);

  const documents = accessibleDocuments.map((d) => ({
    id: d.id,
    title: d.title,
    kind: d.kind,
    updatedAt: d.updatedAt.toISOString(),
    isOwner: d.isOwner,
    ownerId: d.owner.id,
    ownerName: d.owner.name,
    permission: d.permission,
    unreadCount: unreadByDoc.get(d.id) ?? 0,
    mentionCount: mentionByDoc.get(d.id) ?? 0,
    lastCommentAt: lastCommentByDoc.get(d.id)?.toISOString() ?? null
  }));

  // serializeThread returns a loosely-typed `status: string`; the client view
  // expects the ThreadStatusValue union — same cast the document page applies.
  const inboxThreads = inbox.threads as unknown as InboxThreadView[];

  return (
    <main className="dashboard-shell">
      <section className="dashboard-header">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1>Your documents</h1>
          <p>Create new docs, open shared work, and manage collaboration from a single dashboard.</p>
        </div>
        <div className="dashboard-header-actions">
          <TourRestartButton />
          <NewDocumentButton />
        </div>
      </section>

      <DashboardTabs
        documents={documents}
        inboxThreads={inboxThreads}
        inboxTags={inbox.tags}
        initialTab={initialTab}
      />
      <OnboardingTour surface="list" autoOffer={documents.length === 0} />
    </main>
  );
}
