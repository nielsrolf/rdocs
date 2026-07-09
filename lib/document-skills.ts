import { db } from "@/lib/db";
import { copySkillDir, getDocumentSkillDir, getUserSkillDir } from "@/lib/skills";

// Copy the owner's default skills into a freshly created document (files +
// DocumentSkill rows). Called from every document-creation path. Best-effort
// per skill: a missing/corrupt library dir must not fail document creation.
export async function copyOwnerDefaultSkillsToDocument(ownerId: string, documentId: string) {
  const defaults = await db.userSkill.findMany({
    where: { userId: ownerId, isDefault: true },
    orderBy: { name: "asc" }
  });

  for (const skill of defaults) {
    try {
      await copySkillDir(getUserSkillDir(ownerId, skill.name), getDocumentSkillDir(documentId, skill.name));
      await db.documentSkill.upsert({
        where: { documentId_name: { documentId, name: skill.name } },
        create: {
          documentId,
          name: skill.name,
          description: skill.description,
          createdById: ownerId
        },
        update: { description: skill.description }
      });
    } catch (error) {
      console.warn("[skills] failed to copy default skill into new document", {
        documentId,
        ownerId,
        skill: skill.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
