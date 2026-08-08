import type { Metadata } from "next";
import Link from "next/link";

import { QuicktakeFeed, type QuicktakeView } from "@/components/forum/quicktakes";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getQuicktakeVisibility, listQuicktakes, type QuicktakeSummary } from "@/lib/quicktakes";

export const metadata: Metadata = { title: "Quicktakes — Forum — r-docs" };

export const dynamic = "force-dynamic";

function serializeQuicktake(take: QuicktakeSummary): QuicktakeView {
  return { ...take, createdAt: take.createdAt.toISOString() };
}

// The full quicktakes feed: twitter-like short posts. Public quicktakes render
// for logged-out visitors too; the composer needs an account.
export default async function QuicktakesPage() {
  const user = await getCurrentUser();

  const [quicktakes, visibility, groups] = await Promise.all([
    listQuicktakes(user?.id ?? null),
    user ? getQuicktakeVisibility(user.id) : Promise.resolve(null),
    user
      ? db.group.findMany({
          where: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
          orderBy: { name: "asc" },
          select: { id: true, name: true }
        })
      : Promise.resolve([])
  ]);

  return (
    <main className="forum-shell">
      <header className="forum-header">
        <div>
          <h1 className="forum-title">Quicktakes</h1>
          <p className="forum-subtitle">
            {user
              ? "Short takes from you and people who shared with you."
              : "Public short takes. Sign in to post, vote, and comment."}
          </p>
        </div>
        <nav className="forum-header-nav">
          <Link href="/forum" className="forum-btn-ghost">
            ← Forum
          </Link>
          {user ? null : (
            <Link href="/sign-in" className="forum-btn-ghost">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <QuicktakeFeed
        initialQuicktakes={quicktakes.map(serializeQuicktake)}
        groups={groups}
        initialGroupId={visibility?.groupId ?? null}
        isSignedIn={Boolean(user)}
        currentUserName={user?.name ?? "Guest"}
      />
    </main>
  );
}
