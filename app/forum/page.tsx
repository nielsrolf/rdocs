import type { Metadata } from "next";
import Link from "next/link";

import { ForumFeed, type ForumFeedItemView } from "@/components/forum/forum-feed";
import { NewPostButton } from "@/components/forum/new-post-button";
import { ForumPostNotificationBell } from "@/components/notification-bell";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { forumExcerpt, listForumFeedForUser } from "@/lib/forum-data";
import { getQuicktakeVisibility } from "@/lib/quicktakes";
import { listForumPostCandidates } from "@/lib/forum-posting";

export const metadata: Metadata = { title: "Forum — r-docs" };

export const dynamic = "force-dynamic";

// Forum frontpage: ONE feed of full posts and quicktakes, ranked by the same
// hotness function. Posts are every doc the viewer can access (same access
// gate as the studio) carrying the "posted to forum" flag, plus all PUBLIC
// posts — which makes the page work signed-out too.
export default async function ForumPage() {
  const user = await getCurrentUser();

  const [feed, visibility, groups, postCandidates] = await Promise.all([
    listForumFeedForUser(user?.id ?? null),
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
  const notificationRow = user
    ? await db.user.findUnique({ where: { id: user.id }, select: { forumPostSlackNotifications: true } })
    : null;
  const postIds = feed.filter((item) => item.kind === "post").map((item) => item.id);
  const excerpts = new Map<string, string>();
  if (postIds.length > 0) {
    const contents = await db.document.findMany({
      where: { id: { in: postIds } },
      select: { id: true, content: true }
    });
    for (const doc of contents) {
      excerpts.set(doc.id, forumExcerpt(doc.content));
    }
  }

  const items: ForumFeedItemView[] = feed.map((item) =>
    item.kind === "quicktake"
      ? {
          kind: "quicktake",
          id: item.id,
          take: { ...item.take, createdAt: item.take.createdAt.toISOString() }
        }
      : {
          kind: "post",
          id: item.id,
          post: {
            id: item.post.id,
            title: item.post.title,
            postedAt: item.post.postedAt.toISOString(),
            ownerName: item.post.owner.name,
            score: item.post.score,
            ownVote: item.post.ownVote,
            commentCount: item.post.commentCount,
            excerpt: excerpts.get(item.id) ?? ""
          }
        }
  );

  return (
    <main className="forum-shell">
      <header className="forum-header">
        <div>
          <h1 className="forum-title">Forum</h1>
          <p className="forum-subtitle">
            {user
              ? "Posts and quick takes you have access to, ranked by votes and recency."
              : "Public posts and quick takes, ranked by votes and recency. Sign in to see private posts, vote, and comment."}
          </p>
        </div>
        <nav className="forum-header-nav">
          {user ? (
            <>
              <ForumPostNotificationBell initialEnabled={notificationRow?.forumPostSlackNotifications ?? true} />
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
      <section className="forum-post-list" aria-label="Feed">
        <ForumFeed
          initialItems={items}
          groups={groups}
          initialGroupId={visibility?.groupId ?? null}
          isSignedIn={Boolean(user)}
          currentUserName={user?.name ?? "Guest"}
        />
      </section>
    </main>
  );
}
