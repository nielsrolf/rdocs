import type { Metadata } from "next";
import Link from "next/link";

import { QuicktakeFeed } from "@/components/forum/quicktakes";
import { NewPostButton } from "@/components/forum/new-post-button";
import { VoteWidget } from "@/components/forum/vote-widget";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { forumExcerpt, listForumDocumentsForUser } from "@/lib/forum-data";
import { getQuicktakeVisibility, listQuicktakes } from "@/lib/quicktakes";
import { listForumPostCandidates } from "@/lib/forum-posting";

export const metadata: Metadata = { title: "Forum — r-docs" };

export const dynamic = "force-dynamic";

function formatDate(value: Date) {
  return value.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Forum frontpage: every doc the viewer can access (same access gate as the
// studio) that carries the "posted to forum" flag, plus all PUBLIC posts —
// which makes the page work signed-out too — ranked by hotness.
export default async function ForumPage() {
  const user = await getCurrentUser();

  const [posts, quicktakes, visibility, groups, postCandidates] = await Promise.all([
    listForumDocumentsForUser(user?.id ?? null),
    listQuicktakes(user?.id ?? null, 5),
    user ? getQuicktakeVisibility(user.id) : Promise.resolve(null),
    user
      ? db.group.findMany({
          where: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
          orderBy: { name: "asc" },
          select: { id: true, name: true }
        })
      : Promise.resolve([]),
    user ? listForumPostCandidates(user.id) : Promise.resolve([])
  ]);
  const excerpts = new Map<string, string>();
  if (posts.length > 0) {
    const contents = await db.document.findMany({
      where: { id: { in: posts.map((p) => p.id) } },
      select: { id: true, content: true }
    });
    for (const doc of contents) {
      excerpts.set(doc.id, forumExcerpt(doc.content));
    }
  }

  return (
    <main className="forum-shell">
      <header className="forum-header">
        <div>
          <h1 className="forum-title">Forum</h1>
          <p className="forum-subtitle">
            {user
              ? "Posts you have access to, ranked by votes and recency."
              : "Public posts, ranked by votes and recency. Sign in to see private posts, vote, and comment."}
          </p>
        </div>
        <nav className="forum-header-nav">
          {user ? (
            <>
              <NewPostButton documents={postCandidates} groups={groups} />
              <Link href="/dashboard" className="forum-btn-ghost">
                Studio
              </Link>
            </>
          ) : (
            <Link href="/sign-in" className="forum-btn-ghost">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <section className="quicktake-section" aria-label="Quicktakes">
        <div className="quicktake-section-header">
          <h2 className="forum-section-title">Quicktakes</h2>
          <Link href="/forum/quicktakes" className="forum-btn-ghost">
            View all →
          </Link>
        </div>
        <QuicktakeFeed
          initialQuicktakes={quicktakes.map((take) => ({
            ...take,
            createdAt: take.createdAt.toISOString()
          }))}
          groups={groups}
          initialGroupId={visibility?.groupId ?? null}
          isSignedIn={Boolean(user)}
          currentUserName={user?.name ?? "Guest"}
        />
      </section>
      <section className="forum-post-list">
        <h2 className="forum-section-title">Posts</h2>
        {posts.map((post) => (
          <article key={post.id} className="forum-post-card">
            <VoteWidget
              targetType="document"
              targetId={post.id}
              initialScore={post.score}
              initialOwnVote={post.ownVote}
              canVote={Boolean(user)}
            />
            <div className="forum-post-body">
              <Link href={`/forum/${post.id}`} className="forum-post-title">
                {post.title || "Untitled"}
              </Link>
              <div className="forum-post-meta">
                <span>{post.owner.name}</span>
                <span>·</span>
                <span>{formatDate(post.postedAt)}</span>
                <span>·</span>
                <span>
                  {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
                </span>
              </div>
              {excerpts.get(post.id) ? (
                <p className="forum-post-excerpt">{excerpts.get(post.id)}</p>
              ) : null}
            </div>
          </article>
        ))}
        {posts.length === 0 ? (
          <p className="forum-empty">
            Nothing here yet. Post a document to the forum from its share menu in the studio.
          </p>
        ) : null}
      </section>
    </main>
  );
}
