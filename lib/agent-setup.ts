// One-click provisioning of an externally integrated agent document: initial
// markdown, environment, one skill, optional MCP servers, and a document-scoped
// API channel whose credential is handed to the integration's callback. Shared by
// POST /api/agent-setups (signed-in browser flow) and scripts/provision-agent.ts
// (operator flow on the host, same steps without the consent page).

import { z } from "zod";

import { upsertAgentApiChannel } from "@/lib/agent-api-channels";
import { isAllowedAgentSetupUrl } from "@/lib/agent-setup-origins";
import { defaultDocumentContent, serializeDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { upsertDocumentEnv } from "@/lib/document-env";
import { MAX_MCP_SERVERS_PER_DOCUMENT, upsertDocumentMcpServer } from "@/lib/document-mcp-servers";
import { applyMarkdownEdit } from "@/lib/mcp/apply-edit";
import { getDocumentSkillDir, prepareSkillUpload, writeSkillToStore } from "@/lib/skills";

export const agentSetupSchema = z.object({
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

export type AgentSetupInput = z.infer<typeof agentSetupSchema>;

export type AgentSetupResult = {
  documentId: string;
  documentUrl: string;
  triggerId: string;
  triggerToken: string;
  triggerEndpoint: string;
};

/** Provision the document for `userId`; deletes it again and throws on any failure. */
export async function provisionAgentSetup(userId: string, input: AgentSetupInput): Promise<AgentSetupResult> {
  const document = await db.document.create({
    data: {
      ownerId: userId,
      title: input.title.trim(),
      content: serializeDocumentContent(defaultDocumentContent)
    },
    select: { id: true }
  });

  try {
    if (input.markdown.trim()) {
      await applyMarkdownEdit({
        documentId: document.id,
        userId,
        mode: "replace_all",
        markdown: input.markdown
      });
    }
    for (const [key, value] of Object.entries(input.environment)) {
      await upsertDocumentEnv(document.id, key, value);
    }
    for (const server of input.mcpServers ?? []) {
      if (server.authEnvKey && !(server.authEnvKey in input.environment)) {
        throw new Error(`MCP server ${server.name} references env key ${server.authEnvKey} that is not in the manifest.`);
      }
      await upsertDocumentMcpServer({ documentId: document.id, ...server });
    }
    const prepared = prepareSkillUpload([{
      relativePath: `${input.skillName}/SKILL.md`,
      bytes: Buffer.from(input.skillMarkdown)
    }]);
    await writeSkillToStore(getDocumentSkillDir(document.id, prepared.name), prepared);
    await db.documentSkill.create({
      data: {
        documentId: document.id,
        name: prepared.name,
        description: prepared.description,
        createdById: userId
      }
    });
    const api = await upsertAgentApiChannel({
      documentId: document.id,
      createdById: userId,
      label: input.channelLabel
    });
    if (!isAllowedAgentSetupUrl(input.callbackUrl)) {
      throw new Error("Integration callback origin is not allowed.");
    }
    const callback = await fetch(input.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.callbackCredential}`
      },
      body: JSON.stringify({
        ...(input.callbackBody || {}),
        document_url: new URL(`/documents/${document.id}`, process.env.APP_URL).toString(),
        trigger_url: new URL(`/api/agent-channels/${api.channel.id}/runs`, process.env.APP_URL).toString(),
        trigger_token: api.token
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!callback.ok) throw new Error(`Integration callback failed (${callback.status}).`);
    return {
      documentId: document.id,
      documentUrl: `/documents/${document.id}`,
      triggerId: api.channel.id,
      triggerToken: api.token,
      triggerEndpoint: `/api/agent-channels/${api.channel.id}/runs`
    };
  } catch (error) {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    throw error;
  }
}
