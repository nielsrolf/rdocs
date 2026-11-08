import { db } from "@/lib/db";
import { listFrequentCollaborators } from "@/lib/collaborator-suggestions";
import { personMatchRank } from "@/lib/mentions";

export type UserSearchResult = { id: string; name: string; email: string; known: boolean };

const SCAN_LIMIT = 200;

/** People the viewer already works with: frequent direct-share collaborators
 * plus everyone in a group they belong to or own. Ranked first in searches. */
async function knownPeopleIds(viewerId: string): Promise<Set<string>> {
  const [collaborators, groupMates] = await Promise.all([
    listFrequentCollaborators(viewerId, 100),
    db.groupMember.findMany({
      where: {
        group: { OR: [{ ownerId: viewerId }, { members: { some: { userId: viewerId } } }] }
      },
      select: { userId: true, group: { select: { ownerId: true } } }
    })
  ]);
  const ids = new Set(collaborators.map((person) => person.id));
  for (const row of groupMates) {
    ids.add(row.userId);
    ids.add(row.group.ownerId);
  }
  ids.delete(viewerId);
  return ids;
}

/**
 * Autocomplete search over accounts by name or email for a signed-in viewer
 * (group member pickers, the share dialog). Every signed-in user can already
 * list all accounts via the forum mention candidates, so this exposes nothing
 * new; it just keeps the payload small. An empty query returns the viewer's
 * known people. Ranking: match quality (`personMatchRank`), then known people,
 * then shorter names.
 */
export async function searchUsers(input: {
  viewerId: string;
  query: string;
  limit?: number;
  excludeIds?: string[];
}): Promise<UserSearchResult[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 25));
  const query = input.query.trim().slice(0, 100);
  const exclude = new Set(input.excludeIds ?? []);
  const known = await knownPeopleIds(input.viewerId);

  const rows = query
    ? await db.user.findMany({
        // SQLite LIKE: case-insensitive for ASCII. A superset of what
        // personMatchRank accepts; the ranker filters it down.
        where: { OR: [{ name: { contains: query } }, { email: { contains: query.toLowerCase() } }] },
        select: { id: true, name: true, email: true },
        take: SCAN_LIMIT
      })
    : await db.user.findMany({
        where: { id: { in: [...known] } },
        select: { id: true, name: true, email: true }
      });

  return rows
    .filter((row) => !exclude.has(row.id))
    .map((row) => ({ row, rank: personMatchRank(query, row) }))
    .filter((entry): entry is { row: (typeof rows)[number]; rank: number } => entry.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(known.has(b.row.id)) - Number(known.has(a.row.id)) ||
        a.row.name.length - b.row.name.length ||
        a.row.email.localeCompare(b.row.email)
    )
    .slice(0, limit)
    .map(({ row }) => ({ id: row.id, name: row.name, email: row.email, known: known.has(row.id) }));
}
