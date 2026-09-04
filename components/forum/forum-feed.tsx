"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { VoteTally } from "@/lib/forum-votes";

import { QuicktakeCard, QuicktakeComposer, type QuicktakeGroupOption, type QuicktakeView } from "./quicktakes";
import { VoteWidget } from "./vote-widget";

export type ForumPostView = {
  id: string;
  title: string;
  postedAt: string;
  ownerName: string;
  commentCount: number;
  excerpt: string;
} & VoteTally;

// One frontpage feed entry: a full post or a quicktake, already ranked.
export type ForumFeedItemView =
  | { kind: "post"; id: string; post: ForumPostView }
  | { kind: "quicktake"; id: string; take: QuicktakeView };

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return value;
  }
}

export function ForumPostCard({ post, canVote }: { post: ForumPostView; canVote: boolean }) {
  return (
    <article className="forum-post-card">
      <VoteWidget
        targetType="document"
        targetId={post.id}
        tally={post}
        canVote={canVote}
      />
      <div className="forum-post-body">
        <Link href={`/forum/${post.id}`} className="forum-post-title">
          {post.title || "Untitled"}
        </Link>
        <div className="forum-post-meta">
          <span>{post.ownerName}</span>
          <span>·</span>
          <span>{formatDate(post.postedAt)}</span>
          <span>·</span>
          <span>
            {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
          </span>
        </div>
        {post.excerpt ? <p className="forum-post-excerpt">{post.excerpt}</p> : null}
      </div>
    </article>
  );
}

// The forum frontpage: posts and quicktakes in ONE stream (ranked server-side
// by the shared hotness function), with the quicktake composer on top.
export function ForumFeed({
  initialItems,
  groups,
  initialGroupId,
  isSignedIn,
  currentUserName = "Guest"
}: {
  initialItems: ForumFeedItemView[];
  groups: QuicktakeGroupOption[];
  initialGroupId: string | null;
  isSignedIn: boolean;
  currentUserName?: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);

  return (
    <div className="quicktake-feed">
      {isSignedIn ? (
        <QuicktakeComposer
          groups={groups}
          initialGroupId={initialGroupId}
          onPosted={(take) => {
            setItems((current) => [{ kind: "quicktake", id: take.id, take }, ...current]);
            router.refresh();
          }}
        />
      ) : null}
      {items.map((item) =>
        item.kind === "quicktake" ? (
          <QuicktakeCard
            key={item.id}
            take={item.take}
            canVote={isSignedIn}
            canComment={isSignedIn}
            currentUserName={currentUserName}
            inlineComments
            clampBody
            onDeleted={(id) => setItems((current) => current.filter((entry) => entry.id !== id))}
          />
        ) : (
          <ForumPostCard key={item.id} post={item.post} canVote={isSignedIn} />
        )
      )}
      {items.length === 0 ? (
        <p className="forum-empty">
          Nothing here yet. Post a quick take above, or post a document to the forum from its share
          menu in the studio.
        </p>
      ) : null}
    </div>
  );
}
