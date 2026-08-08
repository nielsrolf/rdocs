import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, rateLimitAiRun, requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { recordAiRunEvent } from "@/lib/ai-runs";
import { runAiEditInBackground } from "@/lib/ai-edit-run";
import { db } from "@/lib/db";
import { resolveAgentConfigForUser } from "@/lib/agent-defaults";
import { agentAccessModeForDocumentAccess, canComment, canEdit } from "@/lib/permissions";

const aiEditSchema = z
  .object({
    selectedText: z.string().max(200000),
    selectedMarkdown: z.string().max(400000).optional().nullable(),
    selectedContext: z.string().max(50000).optional().nullable(),
    instruction: z.string().min(1).max(4000),
    selectionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/).optional().nullable(),
    shareToken: z.string().optional().nullable(),
    // Set by comment-access users: the selection edit and any out-of-selection
    // edits are applied as tracked-change suggestions instead of committed content.
    suggest: z.boolean().optional(),
    // Session continuation: a follow-up message into an existing edit session.
    // The new run threads under this parent (same conversation in the agent
    // view) and the agent gets the prior attempts' transcript as history.
    parentRunId: z.string().min(1).max(60).optional().nullable()
  })
  .superRefine((data, ctx) => {
    // A fresh edit needs a real selection; a continuation may have lost its
    // anchor (the previous attempt failed and the marker is gone) and still be
    // worth running — the agent has the session history to work from.
    if (!data.parentRunId && data.selectedText.length < 1) {
      ctx.addIssue({
        code: "custom",
        message: "selectedText is required unless this is a session continuation (parentRunId).",
        path: ["selectedText"]
      });
    }
  });

export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = aiEditSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid AI edit payload." }, { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "VIEW", {
    shareToken: parsed.data.shareToken ?? null
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user, access } = gate;
  // Editors may commit edits directly; comment-access users may run the agent
  // only in suggestion mode (suggest: true), where the result lands as tracked
  // changes they cannot commit on their own.
  const editorAccess = canEdit(access.permission);
  const suggestAccess = parsed.data.suggest === true && canComment(access.permission);
  if (!editorAccess && !suggestAccess) {
    return jsonError(403, "You do not have edit access.");
  }
  const suggestOnly = !editorAccess;

  // Agent runs are expensive; cap per-user (or per-IP for share-token editors).
  const limited = rateLimitAiRun(user, request, "You're starting AI edits too quickly. Try again shortly.");
  if (limited) {
    return limited;
  }

  // Continuations must thread under a run of the SAME document; a bad parent
  // id degrades to a fresh run rather than leaking another doc's session.
  let parentRunId: string | null = null;
  if (parsed.data.parentRunId) {
    const parent = await db.aiRun.findFirst({
      where: { id: parsed.data.parentRunId, documentId: id },
      select: { id: true }
    });
    parentRunId = parent?.id ?? null;
  }

  const aiRun = await db.aiRun.create({
    data: {
      documentId: id,
      triggerType: "SELECTION_EDIT",
      createdById: user?.id ?? null,
      triggerId: parsed.data.selectionId ? `selection:${parsed.data.selectionId}` : null,
      selectionId: parsed.data.selectionId ?? null,
      // Kept (truncated) so the agent view can show what the run was triggered
      // on after the live selection marker is gone.
      selectedText: parsed.data.selectedText.trim().slice(0, 1500) || null,
      parentRunId,
      instruction: parsed.data.instruction.trim(),
      progress: "Starting Claude research agent.",
      suggestOnly
    }
  });

  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: parsed.data.instruction.trim()
  });

  void runAiEditInBackground({
    documentId: id,
    aiRunId: aiRun.id,
    parsed: parsed.data,
    documentTitle: access.document.title,
    documentContentRaw: access.document.content,
    createdById: user?.id ?? null,
    // Doc agent-panel config -> triggering user's default -> app default.
    agentConfig: await resolveAgentConfigForUser(access.document, user?.id ?? null),
    agentAccessMode: agentAccessModeForDocumentAccess(access),
    runnerMode: access.document.runnerMode
  }).catch((error) => {
    console.error("[ai-edit] background run threw", {
      aiRunId: aiRun.id,
      documentId: id,
      error: error instanceof Error ? error.message : error
    });
  });

  return NextResponse.json({ aiRunId: aiRun.id, status: aiRun.status }, { status: 202 });
}
