import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { upsertAgentApiChannel } from "@/lib/agent-api-channels";
import { isAllowedAgentSetupUrl } from "@/lib/agent-setup-origins";
import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { upsertDocumentEnv } from "@/lib/document-env";
import { MAX_MCP_SERVERS_PER_DOCUMENT, upsertDocumentMcpServer } from "@/lib/document-mcp-servers";
import { applyMarkdownEdit } from "@/lib/mcp/apply-edit";
import { getDocumentSkillDir, prepareSkillUpload, writeSkillToStore } from "@/lib/skills";

export const runtime = "nodejs";

const setupSchema = z.object({
  title: z.string().min(1).max(300),
  markdown: z.string().max(100_000),
  environment: z.record(z.string(), z.string().max(8192)).refine((env) => Object.keys(env).length <= 20),
  skillMarkdown: z.string().min(1).max(500_000),
  skillName: z.string().min(1).max(64),
  channelLabel: z.string().max(120).optional().nullable(),
  callbackUrl: z.string().url().max(2000),
  callbackCredential: z.string().min(1).max(1000),
  callbackBody: z.record(z.string(), z.unknown()).optional(),
  // HTTP MCP servers mounted into every run of the new document. `authEnvKey`
  // names one of the `environment` keys above whose value is sent as a bearer.
  mcpServers: z
    .array(z.object({ name: z.string().min(1).max(64), url: z.string().min(1).max(2000), authEnvKey: z.string().max(128).optional().nullable() }))
    .max(MAX_MCP_SERVERS_PER_DOCUMENT)
    .optional()
});

// Generic one-click provisioning for an externally integrated agent. The browser
// must be signed in; the integration supplies initial content, env and one skill.
// The returned channel credential can trigger only this newly created document.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = setupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent setup payload." }, { status: 400 });

  const document = await db.document.create({
    data: {
      ownerId: user.id,
      title: parsed.data.title.trim(),
      content: serializeDocumentContent(defaultDocumentContent)
    },
    select: { id: true }
  });

  try {
    if (parsed.data.markdown.trim()) {
      await applyMarkdownEdit({
        documentId: document.id,
        userId: user.id,
        mode: "replace_all",
        markdown: parsed.data.markdown
      });
    }
    for (const [key, value] of Object.entries(parsed.data.environment)) {
      await upsertDocumentEnv(document.id, key, value);
    }
    for (const server of parsed.data.mcpServers ?? []) {
      if (server.authEnvKey && !(server.authEnvKey in parsed.data.environment)) {
        throw new Error(`MCP server ${server.name} references env key ${server.authEnvKey} that is not in the manifest.`);
      }
      await upsertDocumentMcpServer({ documentId: document.id, ...server });
    }
    const prepared = prepareSkillUpload([{
      relativePath: `${parsed.data.skillName}/SKILL.md`,
      bytes: Buffer.from(parsed.data.skillMarkdown)
    }]);
    await writeSkillToStore(getDocumentSkillDir(document.id, prepared.name), prepared);
    await db.documentSkill.create({
      data: {
        documentId: document.id,
        name: prepared.name,
        description: prepared.description,
        createdById: user.id
      }
    });
    const api = await upsertAgentApiChannel({
      documentId: document.id,
      createdById: user.id,
      label: parsed.data.channelLabel
    });
    if (!isAllowedAgentSetupUrl(parsed.data.callbackUrl)) {
      throw new Error("Integration callback origin is not allowed.");
    }
    const callback = await fetch(parsed.data.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${parsed.data.callbackCredential}`
      },
      body: JSON.stringify({
        ...(parsed.data.callbackBody || {}),
        document_url: new URL(`/documents/${document.id}`, process.env.APP_URL).toString(),
        trigger_url: new URL(`/api/agent-channels/${api.channel.id}/runs`, process.env.APP_URL).toString(),
        trigger_token: api.token
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!callback.ok) throw new Error(`Integration callback failed (${callback.status}).`);
    return NextResponse.json({
      documentId: document.id,
      documentUrl: `/documents/${document.id}`,
      triggerId: api.channel.id,
      triggerToken: api.token,
      triggerEndpoint: `/api/agent-channels/${api.channel.id}/runs`
    }, { status: 201 });
  } catch (error) {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    console.error("[agent-setup] provisioning failed", {
      documentId: document.id,
      error: error instanceof Error ? error.message : error
    });
    return NextResponse.json({ error: "Could not provision the agent document." }, { status: 500 });
  }
}
