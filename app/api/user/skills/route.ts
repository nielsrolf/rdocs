import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadCatalogSkill } from "@/lib/skill-catalog";
import {
  getUserSkillDir,
  prepareSkillUpload,
  readSkillUploadFromFormData,
  writeSkillToStore
} from "@/lib/skills";

export const runtime = "nodejs";

// Per-user agent skill library. Skill files live on disk (lib/skills.ts);
// these routes manage the metadata rows and the store in lockstep. Skills
// marked as default are copied into every document the user creates.

function serializeUserSkill(skill: {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    isDefault: skill.isDefault,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString()
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const skills = await db.userSkill.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" }
  });
  return NextResponse.json({ skills: skills.map(serializeUserSkill) });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // JSON body → one-click install from the curated skill catalog.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    const catalogName = typeof body?.catalogName === "string" ? body.catalogName : "";
    if (!catalogName) {
      return NextResponse.json({ error: "Missing catalogName." }, { status: 400 });
    }
    let prepared;
    try {
      prepared = await loadCatalogSkill(catalogName);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to load the skill catalog." },
        { status: 502 }
      );
    }
    if (!prepared) {
      return NextResponse.json({ error: "Skill not found in the catalog." }, { status: 404 });
    }
    await writeSkillToStore(getUserSkillDir(user.id, prepared.name), prepared);
    const skill = await db.userSkill.upsert({
      where: { userId_name: { userId: user.id, name: prepared.name } },
      create: {
        userId: user.id,
        name: prepared.name,
        description: prepared.description,
        isDefault: body?.isDefault === true
      },
      update: { description: prepared.description }
    });
    return NextResponse.json({ skill: serializeUserSkill(skill) });
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Expected a multipart skill upload." }, { status: 400 });
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

  const isDefault = formData.get("isDefault") === "true";

  // Re-uploading a skill with the same name replaces it wholesale.
  await writeSkillToStore(getUserSkillDir(user.id, prepared.name), prepared);
  const skill = await db.userSkill.upsert({
    where: { userId_name: { userId: user.id, name: prepared.name } },
    create: {
      userId: user.id,
      name: prepared.name,
      description: prepared.description,
      isDefault
    },
    update: { description: prepared.description }
  });

  return NextResponse.json({ skill: serializeUserSkill(skill) });
}
