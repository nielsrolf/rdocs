// Agent-driven workspace provisioning: an agent creates a CHILD workspace
// (document) from the workspace it works in and hands environment on to it.
//
// Ownership rule: the child is owned by the PARENT's owner, and the user who
// triggered the creation (if someone else) gets EDIT membership — so a
// collaborator's run can never create documents the owner cannot see or
// control. Environment hand-over copies stored ciphertext server-side
// (copyDocumentEnvKeys): the agent names keys, never handles their values.
// Provisioner admin secrets (PROVISIONER_SECRET_ENV_KEYS) are never handed on.
//
// Authorization (edit access on the parent / target) is the CALLER's job — the
// MCP tools in lib/mcp/tools.ts check it before calling in here.

import { applyMarkdownEdit } from "@/lib/mcp/apply-edit";
import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import {
  copyDocumentEnvKeys,
  deleteDocumentEnv,
  isProvisionerSecretEnvKey,
  listDocumentEnvMasked,
  upsertDocumentEnv,
  type MaskedEnvVar
} from "@/lib/document-env";
import { DocumentRepositoryError, setDocumentRepository } from "@/lib/document-repository";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { copySkillDir, getDocumentSkillDir } from "@/lib/skills";

export class WorkspaceProvisioningError extends Error {}

export const MAX_ENV_KEYS_PER_CALL = 30;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_VALUE_LENGTH = 8192;

function validateEnvKeys(keys: string[]) {
  if (keys.length > MAX_ENV_KEYS_PER_CALL) {
    throw new WorkspaceProvisioningError(`At most ${MAX_ENV_KEYS_PER_CALL} env keys per call.`);
  }
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      throw new WorkspaceProvisioningError(`"${key}" is not a valid env var name.`);
    }
  }
}

function validateEnvValues(values: Record<string, string>) {
  validateEnvKeys(Object.keys(values));
  for (const [key, value] of Object.entries(values)) {
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      throw new WorkspaceProvisioningError(`Value of ${key} exceeds ${MAX_ENV_VALUE_LENGTH} characters.`);
    }
  }
}

function refuseProvisionerKeys(keys: string[]) {
  const refused = keys.filter(isProvisionerSecretEnvKey);
  if (refused.length > 0) {
    throw new WorkspaceProvisioningError(
      `${refused.join(", ")} is a provisioner admin secret and cannot be handed on by an agent; ` +
        "the document owner sets it in the environment menu."
    );
  }
}

async function copyEnv(fromDocumentId: string, toDocumentId: string, keys: string[]) {
  validateEnvKeys(keys);
  refuseProvisionerKeys(keys);
  const { missing } = await copyDocumentEnvKeys(fromDocumentId, toDocumentId, keys);
  if (missing.length > 0) {
    const available = (await listDocumentEnvMasked(fromDocumentId))
      .map((entry) => entry.key)
      .filter((key) => !isProvisionerSecretEnvKey(key));
    throw new WorkspaceProvisioningError(
      `Not set on the source document: ${missing.join(", ")}. Available keys: ${available.join(", ") || "(none)"}.`
    );
  }
}

export type CreateChildWorkspaceInput = {
  parentDocumentId: string;
  /** The user the creation is attributed to (run's triggering user). */
  userId: string;
  title: string;
  markdown?: string;
  /** Literal env values to set on the child. */
  environment?: Record<string, string>;
  /** Env keys copied from the parent (values never leave the server). */
  inheritEnv?: string[];
  /** Skill names copied from the parent's document skills. */
  inheritSkills?: string[];
  repoUrl?: string | null;
  repoBranch?: string | null;
};

export type CreatedChildWorkspace = {
  id: string;
  ownerId: string;
  envKeys: string[];
  skills: string[];
};

export async function createChildWorkspace(input: CreateChildWorkspaceInput): Promise<CreatedChildWorkspace> {
  const parent = await db.document.findUnique({
    where: { id: input.parentDocumentId },
    select: { id: true, ownerId: true, kind: true, agentModel: true, agentEffort: true, agentInnerDocker: true }
  });
  if (!parent) throw new WorkspaceProvisioningError("Parent document not found.");
  if (parent.kind === "quicktake") {
    throw new WorkspaceProvisioningError("A forum quicktake cannot be the parent of a workspace.");
  }

  const environment = input.environment ?? {};
  validateEnvValues(environment);
  const inheritEnv = [...new Set(input.inheritEnv ?? [])];
  validateEnvKeys(inheritEnv);
  refuseProvisionerKeys([...inheritEnv, ...Object.keys(environment)]);
  const inheritSkills = [...new Set(input.inheritSkills ?? [])];
  const parentSkills = inheritSkills.length
    ? await db.documentSkill.findMany({
        where: { documentId: parent.id, name: { in: inheritSkills } },
        select: { name: true, description: true }
      })
    : [];
  const missingSkills = inheritSkills.filter((name) => !parentSkills.some((skill) => skill.name === name));
  if (missingSkills.length > 0) {
    throw new WorkspaceProvisioningError(`The parent has no skill named: ${missingSkills.join(", ")}.`);
  }

  const child = await db.document.create({
    data: {
      title: input.title.trim(),
      content: serializeDocumentContent(defaultDocumentContent),
      ownerId: parent.ownerId,
      parentDocumentId: parent.id,
      agentModel: parent.agentModel,
      agentEffort: parent.agentEffort,
      agentInnerDocker: parent.agentInnerDocker
    },
    select: { id: true }
  });

  try {
    if (input.userId !== parent.ownerId) {
      await db.documentMembership.create({
        data: { documentId: child.id, userId: input.userId, permission: "EDIT" }
      });
    }
    await copyOwnerDefaultSkillsToDocument(parent.ownerId, child.id);
    for (const skill of parentSkills) {
      await copySkillDir(getDocumentSkillDir(parent.id, skill.name), getDocumentSkillDir(child.id, skill.name));
      await db.documentSkill.upsert({
        where: { documentId_name: { documentId: child.id, name: skill.name } },
        create: { documentId: child.id, name: skill.name, description: skill.description, createdById: input.userId },
        update: { description: skill.description }
      });
    }
    if (inheritEnv.length > 0) await copyEnv(parent.id, child.id, inheritEnv);
    for (const [key, value] of Object.entries(environment)) {
      await upsertDocumentEnv(child.id, key, value);
    }
    if (input.markdown?.trim()) {
      await applyMarkdownEdit({
        documentId: child.id,
        userId: input.userId,
        mode: "replace_all",
        markdown: input.markdown
      });
    }
    if (input.repoUrl) {
      await setDocumentRepository({
        documentId: child.id,
        userId: input.userId,
        repoUrl: input.repoUrl.trim(),
        repoBranch: input.repoBranch?.trim() || null
      });
    }
  } catch (error) {
    await db.document.delete({ where: { id: child.id } }).catch(() => null);
    if (error instanceof DocumentRepositoryError) throw new WorkspaceProvisioningError(error.message);
    throw error;
  }

  const [envRows, skillRows] = await Promise.all([
    db.documentEnvVar.findMany({ where: { documentId: child.id }, select: { key: true }, orderBy: { key: "asc" } }),
    db.documentSkill.findMany({ where: { documentId: child.id }, select: { name: true }, orderBy: { name: "asc" } })
  ]);
  console.log(
    "[workspace-provisioning] created child workspace",
    JSON.stringify({ childId: child.id, parentId: parent.id, ownerId: parent.ownerId, userId: input.userId })
  );
  return {
    id: child.id,
    ownerId: parent.ownerId,
    envKeys: envRows.map((row) => row.key),
    skills: skillRows.map((row) => row.name)
  };
}

export type SetWorkspaceEnvInput = {
  documentId: string;
  set?: Record<string, string>;
  /** Copy these keys from another document (caller checked edit access on it). */
  copyFrom?: { documentId: string; keys: string[] };
  unset?: string[];
};

export async function setWorkspaceEnv(input: SetWorkspaceEnvInput): Promise<MaskedEnvVar[]> {
  const set = input.set ?? {};
  const unset = [...new Set(input.unset ?? [])];
  validateEnvValues(set);
  validateEnvKeys(unset);
  refuseProvisionerKeys([...Object.keys(set), ...unset]);
  if (input.copyFrom?.keys.length) {
    await copyEnv(input.copyFrom.documentId, input.documentId, [...new Set(input.copyFrom.keys)]);
  }
  for (const [key, value] of Object.entries(set)) {
    await upsertDocumentEnv(input.documentId, key, value);
  }
  for (const key of unset) {
    await deleteDocumentEnv(input.documentId, key);
  }
  return listDocumentEnvMasked(input.documentId);
}

export async function listChildWorkspaces(parentDocumentId: string) {
  return db.document.findMany({
    where: { parentDocumentId },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, ownerId: true, createdAt: true, repoUrl: true }
  });
}

/** Is `documentId` a direct child of `parentDocumentId`? */
export async function isChildWorkspaceOf(documentId: string, parentDocumentId: string): Promise<boolean> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { parentDocumentId: true }
  });
  return document?.parentDocumentId === parentDocumentId;
}
