import { db } from "@/lib/db";

export type CollaboratorSuggestion = { id: string; name: string; email: string; count: number };

/** Frequent collaborators are people who repeatedly share direct-access docs
 * with the current user, ranked by number of shared documents and recency. */
export async function listFrequentCollaborators(userId: string, limit = 12): Promise<CollaboratorSuggestion[]> {
  const documents = await db.document.findMany({
    where: { OR: [{ ownerId: userId }, { memberships: { some: { userId } } }] },
    orderBy: { updatedAt: "desc" },
    select: {
      owner: { select: { id: true, name: true, email: true } },
      memberships: { select: { user: { select: { id: true, name: true, email: true } } } }
    }
  });
  const ranked = new Map<string, CollaboratorSuggestion & { recency: number }>();
  documents.forEach((document, recency) => {
    for (const person of [document.owner, ...document.memberships.map((membership) => membership.user)]) {
      if (person.id === userId) continue;
      const current = ranked.get(person.id);
      if (current) current.count += 1;
      else ranked.set(person.id, { ...person, count: 1, recency });
    }
  });
  return [...ranked.values()]
    .sort((a, b) => b.count - a.count || a.recency - b.recency || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ recency: _recency, ...person }) => person);
}
