import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { ForumFeed, ForumPostCard, type ForumFeedItemView, type ForumPostView } from "@/components/forum/forum-feed";
import { ForumLayoutToggle } from "@/components/forum/forum-layout-toggle";
import { NewPostButton } from "@/components/forum/new-post-button";
import { QuicktakeFeed } from "@/components/forum/quicktakes";
import { ForumPostNotificationBell } from "@/components/notification-bell";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { forumExcerpt, listForumDocumentsForUser, listForumFeedForUser, type ForumDocumentSummary } from "@/lib/forum-data";
import { FORUM_LAYOUT_COOKIE, resolveForumLayout, type ForumLayout } from "@/lib/forum-layout";
import { getQuicktakeVisibility, listQuicktakes } from "@/lib/quicktakes";
import { listForumPostCandidates } from "@/lib/forum-posting";

export const metadata: Metadata = { title: "Forum — r-docs" };

export const dynamic = "force-dynamic";

async function excerptsFor(postIds: string[]): Promise<Map<string, string>> {
  const excerpts = new Map<string, string>();
  if (postIds.length === 0) return excerpts;
  const contents = await db.document.findMany({
    where: { id: { in: postIds } },
    select: { id: true, content: true }
  });
  for (const doc of contents) {
    excerpts.set(doc.id, forumExcerpt(doc.content));
  }
  return excerpts;
}

function serializePost(post: ForumDocumentSummary, excerpt: string): ForumPostView {
  return {
    id: post.id,
    title: post.title,
    postedAt: post.postedAt.toISOString(),
    ownerName: post.owner.name,
    score: post.score,
    ownVote: post.ownVote,
    commentCount: post.commentCount,
    excerpt
  };
}

// Forum frontpage. Two layouts, chosen per viewer (lib/forum-layout.ts):
//   "unified" — full posts and quick takes in ONE feed ranked by the shared
//               hotness function;
//   "split"   — the newest quick takes in their own section (link to all),
//               then the ranked post list.
// Posts are every doc the viewer can access (same access gate as the studio)
// carrying the "posted to forum" flag, plus all PUBLIC posts — which makes the
// page work signed-out too.
export default async function ForumPage() {
  const user = await getCurrentUser();
  const cookieStore = await cookies();

  const [userRow, visibility, groups, postCandidates] = await Promise.all([
    user
      ? db.user.findUnique({
          where: { id: user.id },
          select: { forumPostSlackNotifications: true, forumLayout: true }
        })
      : Promise.resolve(null),
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
  const layout: ForumLayout = resolveForumLayout(
    cookieStore.get(FORUM_LAYOUT_COOKIE)?.value,
    userRow?.forumLayout
  );

  const feedProps = {
    groups,
    initialGroupId: visibility?.groupId ?? null,
    isSignedIn: Boolean(user),
    currentUserName: user?.name ?? "Guest"
  };

  let body: React.ReactNode;
  if (layout === "split") {
    const [posts, quicktakes] = await Promise.all([
      listForumDocumentsForUser(user?.id ?? null),
      listQuicktakes(user?.id ?? null, 5)
    ]);
    const excerpts = await excerptsFor(posts.map((p) => p.id));
    body = (
      <>
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
            {...feedProps}
          />
        </section>
        <section className="forum-post-list">
          <h2 className="forum-section-title">Posts</h2>
          {posts.map((post) => (
            <ForumPostCard
              key={post.id}
              post={serializePost(post, excerpts.get(post.id) ?? "")}
              canVote={Boolean(user)}
            />
          ))}
          {posts.length === 0 ? (
            <p className="forum-empty">
              Nothing here yet. Post a document to the forum from its share menu in the studio.
            </p>
          ) : null}
        </section>
      </>
    );
  } else {
    const feed = await listForumFeedForUser(user?.id ?? null);
    const excerpts = await excerptsFor(
      feed.filter((item) => item.kind === "post").map((item) => item.id)
    );
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
            post: serializePost(item.post, excerpts.get(item.id) ?? "")
          }
    );
    body = (
      <section className="forum-post-list" aria-label="Feed">
        <ForumFeed initialItems={items} {...feedProps} />
      </section>
    );
  }

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
          <ForumLayoutToggle value={layout} />
          {user ? (
            <>
              <ForumPostNotificationBell initialEnabled={userRow?.forumPostSlackNotifications ?? true} />
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
      {body}
    </main>
  );
}
