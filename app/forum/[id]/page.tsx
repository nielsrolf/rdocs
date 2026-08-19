import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DocumentWorkspace } from "@/components/document-workspace";
import { ForumComments, type ForumCommentView } from "@/components/forum/forum-comments";
import { VoteWidget } from "@/components/forum/vote-widget";
import { getCurrentUser } from "@/lib/auth";
import { getCollaborationVersion } from "@/lib/collaboration";
import { parseDocumentContent } from "@/lib/content";
import { ThreadStatusValue } from "@/lib/contracts";
import { db } from "@/lib/db";
import { listDocumentThreads } from "@/lib/document-data";
import { listForumComments, type ForumComment } from "@/lib/forum-data";
import { loadMentionCandidates } from "@/lib/mention-data";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const doc = await db.document.findUnique({ where: { id }, select: { title: true } });
  const title = doc?.title?.trim();
  return { title: title ? `${title} — Forum — r-docs` : "Forum — r-docs" };
}

function serializeForumComment(comment: ForumComment): ForumCommentView {
  return {
    ...comment,
    createdAt: comment.createdAt.toISOString(),
    replies: comment.replies.map(serializeForumComment)
  };
}

// Forum view of a document: the public-share-style read-only rendering of the
// doc (same access management as the studio) with nested comments below.
export default async function ForumDocumentPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();

  // Public posts render for logged-out visitors too; everything else needs an
  // account (and access) as before.
  const access = await resolveDocumentAccess(id, user?.id ?? null, null);
  if (!access) {
    if (!user) {
      redirect("/sign-in");
    }
    notFound();
  }

  const [threads, mentionMembers, forumComments, voteAgg, ownVote, initialCollaborationVersion] =
    await Promise.all([
      listDocumentThreads(id, user?.id ?? null),
      loadMentionCandidates(id),
      listForumComments(id, user?.id ?? null),
      db.documentVote.aggregate({ where: { documentId: id }, _sum: { value: true } }),
      user
        ? db.documentVote.findUnique({
            where: { documentId_userId: { documentId: id, userId: user.id } },
            select: { value: true }
          })
        : Promise.resolve(null),
      getCollaborationVersion(id, access.document.content, access.document.updatedAt)
    ]);

  const normalizedThreads = threads.map((thread) => ({
    ...thread,
    status: thread.status as ThreadStatusValue
  }));

  const owner = await db.user.findUnique({
    where: { id: access.document.ownerId },
    select: { name: true }
  });

  return (
    <main className="forum-shell forum-document-shell">
      <header className="forum-header">
        <nav className="forum-header-nav">
          <Link href="/forum" className="forum-btn-ghost">
            ← Forum
          </Link>
        </nav>
        <nav className="forum-header-nav">
          {user ? (
            <Link href={`/documents/${id}`} className="forum-btn-ghost">
              Open in studio
            </Link>
          ) : (
            <Link href="/sign-in" className="forum-btn-ghost">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <div className="forum-post-header">
        <VoteWidget
          targetType="document"
          targetId={id}
          initialScore={voteAgg._sum.value ?? 0}
          initialOwnVote={ownVote?.value ?? 0}
          canVote={Boolean(user)}
        />
        <div>
          <h1 className="forum-title">{access.document.title || "Untitled"}</h1>
          <div className="forum-post-meta">
            <span>{owner?.name ?? "Unknown"}</span>
            {access.document.forumPostedAt ? (
              <>
                <span>·</span>
                <span>
                  {access.document.forumPostedAt.toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric"
                  })}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="forum-document-body document-page-shell">
        <DocumentWorkspace
          currentUserId={user?.id ?? null}
          currentUserName={user?.name ?? "Guest"}
          documentId={access.document.id}
          initialCollaborationVersion={initialCollaborationVersion}
          initialContent={parseDocumentContent(access.document.content)}
          initialDocumentUpdatedAt={access.document.updatedAt.toISOString()}
          initialPermission={access.permission}
          initialShareLinks={[]}
          initialMembers={[]}
          mentionMembers={mentionMembers}
          initialMentionedCommentIds={[]}
          initialRepoBranch={access.document.repoBranch}
          initialRepoUrl={access.document.repoUrl}
          initialAgentModel={access.document.agentModel}
          initialAgentEffort={access.document.agentEffort}
          initialRunnerMode={access.document.runnerMode}
          initialHasOpenRouterKey={false}
          initialHasLiteLlmKey={false}
          initialHasOpenAiKey={false}
          initialHasChatgptAuth={false}
          localAgentModel={null}
          anthropicFreeFallback={false}
          credentialHasOpenRouterKey={false}
          credentialHasLiteLlmKey={false}
          credentialHasOpenAiKey={false}
          credentialHasChatgptAuth={false}
          initialThreads={normalizedThreads}
          initialTitle={access.document.title}
          documentKind={access.document.kind}
          isAuthenticated={Boolean(user)}
          isOwner={user?.id === access.document.ownerId}
          shareToken={null}
          viaShareLink={false}
          forumView
        />
      </div>
      <ForumComments
        documentId={id}
        initialComments={forumComments.map(serializeForumComment)}
        canComment={Boolean(user) && (canComment(access.permission) || access.viaForumPublic)}
        canVote={Boolean(user)}
        currentUserName={user?.name ?? "Guest"}
      />
    </main>
  );
}
