import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canManageDocumentAutomation, resolveDocumentAccess } from "@/lib/permissions";
import {
  copySkillDir,
  getDocumentSkillDir,
  getUserSkillDir,
  prepareSkillUpload,
  readSkillUploadFromFormData,
  writeSkillToStore
} from "@/lib/skills";

export const runtime = "nodejs";

// Agent skills attached to a document. Anyone with edit access can add skills
// — either by uploading skill files or by copying a skill from their own
// library. Attached skills are materialized into every agent worktree at
// `.claude/skills/<name>` and enabled by name for the run.

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function serializeDocumentSkill(skill: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    createdAt: skill.createdAt.toISOString()
  };
}

const copySchema = z.object({
  userSkillId: z.string().min(1),
  share: z.string().optional().nullable()
});

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const skills = await db.documentSkill.findMany({
    where: { documentId: id },
    orderBy: { name: "asc" }
  });

  return NextResponse.json({ skills: skills.map(serializeDocumentSkill) });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const contentType = request.headers.get("content-type") ?? "";

  // JSON body → copy a skill from the caller's own library into the document.
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    const parsed = copySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid skill payload." }, { status: 400 });
    }

    const access = await resolveDocumentAccess(id, user?.id, parsed.data.share ?? null);
    if (!access || !canManageDocumentAutomation(access, user?.id)) {
      return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
    }
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const userSkill = await db.userSkill.findUnique({ where: { id: parsed.data.userSkillId } });
    if (!userSkill || userSkill.userId !== user.id) {
      return NextResponse.json({ error: "Skill not found in your library." }, { status: 404 });
    }

    await copySkillDir(getUserSkillDir(user.id, userSkill.name), getDocumentSkillDir(id, userSkill.name));
    const skill = await db.documentSkill.upsert({
      where: { documentId_name: { documentId: id, name: userSkill.name } },
      create: {
        documentId: id,
        name: userSkill.name,
        description: userSkill.description,
        createdById: user.id
      },
      update: { description: userSkill.description }
    });

    return NextResponse.json({ skill: serializeDocumentSkill(skill) });
  }

  // Multipart body → direct skill file upload.
  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Expected a skill upload." }, { status: 400 });
  }
  const shareToken = typeof formData.get("share") === "string" ? (formData.get("share") as string) : null;

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access || !canManageDocumentAutomation(access, user?.id)) {
    return NextResponse.json({ error: "Sign in with collaborator edit access to manage agent skills." }, { status: 403 });
  }

  let prepared;
  try {
    prepared = prepareSkillUpload(await readSkillUploadFromFormData(formData));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid skill upload." },
      { status: 400 }
    );
  }

  await writeSkillToStore(getDocumentSkillDir(id, prepared.name), prepared);
  const skill = await db.documentSkill.upsert({
    where: { documentId_name: { documentId: id, name: prepared.name } },
    create: {
      documentId: id,
      name: prepared.name,
      description: prepared.description,
      createdById: user?.id ?? null
    },
    update: { description: prepared.description }
  });

  return NextResponse.json({ skill: serializeDocumentSkill(skill) });
}
