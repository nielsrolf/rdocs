import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ForumComments, type ForumCommentView } from "@/components/forum/forum-comments";
import { QuicktakeCard } from "@/components/forum/quicktakes";
import { getCurrentUser } from "@/lib/auth";
import { listForumComments, type ForumComment } from "@/lib/forum-data";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { getQuicktake } from "@/lib/quicktakes";

type PageProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const take = await getQuicktake(id, null);
  const clip = take?.body.replace(/\s+/g, " ").trim().slice(0, 60);
  return { title: clip ? `${clip} — Quicktakes — r-docs` : "Quicktakes — r-docs" };
}

function serializeForumComment(comment: ForumComment): ForumCommentView {
  return {
    ...comment,
    createdAt: comment.createdAt.toISOString(),
    replies: comment.replies.map(serializeForumComment)
  };
}

// Permalink page for a single quicktake with its nested comments — the link
// you send a colleague ("look at this comment: <link>#comment-<id>").
export default async function QuicktakePage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();

  const access = await resolveDocumentAccess(id, user?.id ?? null, null);
  if (!access) {
    if (!user) {
      redirect("/sign-in");
    }
    notFound();
  }

  const [take, forumComments] = await Promise.all([
    getQuicktake(id, user?.id ?? null),
    listForumComments(id, user?.id ?? null)
  ]);
  if (!take) {
    notFound();
  }

  return (
    <main className="forum-shell">
      <header className="forum-header">
        <nav className="forum-header-nav">
          <Link href="/forum/quicktakes" className="forum-btn-ghost">
            ← Quicktakes
          </Link>
        </nav>
        <nav className="forum-header-nav">
          {user ? null : (
            <Link href="/sign-in" className="forum-btn-ghost">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <QuicktakeCard take={{ ...take, createdAt: take.createdAt.toISOString() }} canVote={Boolean(user)} />
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
