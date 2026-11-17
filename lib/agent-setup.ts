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
import { channelCredentialCeilingSchema } from "@/lib/run-credential-policy";
import { copySkillDir, getDocumentSkillDir, getUserSkillDir, prepareSkillUpload, writeSkillToStore } from "@/lib/skills";
import { AGENT_EFFORTS, isStorableAgentModel, normalizeAgentModel } from "@/agent-core/agent-config";
import { agentPresetNameSchema } from "@/lib/agent-presets";
import {
  canProvisionBudgetFrom,
  closeWorkspaceBudget,
  provisionWorkspaceBudget,
  WorkspaceBudgetError
} from "@/lib/workspace-budget";
import { listDocumentEnvMasked } from "@/lib/document-env";

/** A setup the user asked for that cannot be done as asked; the message is theirs to read. */
export class AgentSetupError extends Error {}

const EFFORT_VALUES = AGENT_EFFORTS.map((effort) => effort.value) as [string, ...string[]];

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
    .optional(),
  // The user's choice on the consent page of which credentials runs of the new
  // channel may use. Stored as the channel's ceiling; omitted = unrestricted.
  credentials: channelCredentialCeilingSchema.optional().nullable(),
  // A total compute budget for the new workspace, paid by a provisioner document
  // the user can edit (lib/workspace-budget.ts). The workspace then runs on its
  // own budgeted keys, which are added to the channel's credential ceiling.
  budget: z
    .object({
      provisionerDocumentId: z.string().min(1).max(64),
      budgetUsd: z.number().positive().max(1_000_000),
      // The cost dashboard project to file the workspace under (default: the provisioner's).
      costProjectParent: z.string().trim().max(100).optional().nullable()
    })
    .optional()
    .nullable(),
  // What the user configured on the consent page. Omitted = their defaults.
  // agentModel is a Document.agentModel value, which also decides the harness
  // (Claude Code or Codex); skills are names in the user's own library and are
  // copied into the workspace next to the integration's skill.
  agentModel: z.string().max(200).optional().nullable(),
  agentEffort: z.enum(EFFORT_VALUES).optional().nullable(),
  skills: z.array(z.string().min(1).max(64)).max(20).optional(),
  // The preset the configuration came from, told to the integration as the agent's name.
  presetName: agentPresetNameSchema.optional().nullable()
});

export type AgentSetupInput = z.infer<typeof agentSetupSchema>;

export type AgentSetupResult = {
  documentId: string;
  documentUrl: string;
  triggerId: string;
  triggerToken: string;
  triggerEndpoint: string;
  budget?: { budgetUsd: number; costsProject: string; providers: Record<string, string>; warnings: string[] };
};

/**
 * What the integration is told about the agent it is about to start: names
 * only, nothing it could use. `model` and `effort` are null when the workspace
 * follows the user's defaults (the run itself reports the model it ran on).
 */
export type AgentSetupAgentInfo = { preset: string | null; model: string | null; effort: string | null; skills: string[] };

/** Provision the document for `userId`; deletes it again and throws on any failure. */
export async function provisionAgentSetup(userId: string, input: AgentSetupInput): Promise<AgentSetupResult> {
  if (input.budget && !(await canProvisionBudgetFrom(userId, input.budget.provisionerDocumentId))) {
    throw new WorkspaceBudgetError("You cannot give out budgets from that document.");
  }
  const agentModel = input.agentModel ? normalizeAgentModel(input.agentModel) : null;
  if (agentModel && !isStorableAgentModel(agentModel)) {
    throw new AgentSetupError(`"${input.agentModel}" is not a model r-docs can run.`);
  }
  // Checked before anything exists, so a skill that was renamed or removed leaves no workspace behind.
  const wanted = [...new Set(input.skills ?? [])];
  const librarySkills = wanted.length
    ? await db.userSkill.findMany({ where: { userId, name: { in: wanted } } })
    : [];
  const missing = wanted.filter((name) => !librarySkills.some((skill) => skill.name === name));
  if (missing.length) {
    throw new AgentSetupError(`Not in your skill library: ${missing.join(", ")}. Add them under Settings → AI, or untick them.`);
  }
  let budgeted = false;
  const document = await db.document.create({
    data: {
      ownerId: userId,
      title: input.title.trim(),
      content: serializeDocumentContent(defaultDocumentContent),
      ...(agentModel ? { agentModel } : {}),
      ...(input.agentEffort ? { agentEffort: input.agentEffort } : {})
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
    // The user's own skills, next to the integration's. The integration's skill wins a name clash:
    // it is what tells the agent how to do the integration's job.
    for (const skill of librarySkills) {
      if (skill.name === prepared.name) continue;
      await copySkillDir(getUserSkillDir(userId, skill.name), getDocumentSkillDir(document.id, skill.name));
      await db.documentSkill.create({
        data: {
          documentId: document.id,
          name: skill.name,
          description: skill.description,
          createdById: userId,
          catalogName: skill.catalogName,
          catalogVersion: skill.catalogVersion
        }
      });
    }
    const agent: AgentSetupAgentInfo = {
      preset: input.presetName?.trim() || null,
      model: agentModel,
      effort: input.agentEffort ?? null,
      skills: librarySkills.map((skill) => skill.name).filter((name) => name !== prepared.name).sort()
    };
    let budget: AgentSetupResult["budget"];
    let credentials = input.credentials;
    if (input.budget) {
      const before = new Set((await listDocumentEnvMasked(document.id)).map((entry) => entry.key));
      const provisioned = await provisionWorkspaceBudget({
        provisionerDocumentId: input.budget.provisionerDocumentId,
        documentId: document.id,
        userId,
        budgetUsd: input.budget.budgetUsd,
        title: input.title.trim(),
        documentUrl: new URL(`/documents/${document.id}`, process.env.APP_URL).toString(),
        costsParent: input.budget.costProjectParent
      });
      budgeted = true;
      budget = {
        budgetUsd: provisioned.budgetUsd,
        costsProject: provisioned.costsProject,
        providers: provisioned.providers,
        warnings: provisioned.warnings
      };
      // The budget's keys are the point of the workspace: a credential ceiling
      // chosen on the consent page must not withhold them from its runs.
      if (credentials) {
        const budgetKeys = (await listDocumentEnvMasked(document.id)).map((entry) => entry.key).filter((key) => !before.has(key));
        credentials = { ...credentials, allowEnv: [...new Set([...(credentials.allowEnv ?? []), ...budgetKeys])] };
      }
    }
    const api = await upsertAgentApiChannel({
      documentId: document.id,
      createdById: userId,
      label: input.channelLabel,
      credentialPolicy: credentials ? JSON.stringify(credentials) : null
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
        trigger_token: api.token,
        agent,
        ...(budget ? { budget_usd: budget.budgetUsd } : {})
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!callback.ok) throw new Error(`Integration callback failed (${callback.status}).`);
    return {
      documentId: document.id,
      documentUrl: `/documents/${document.id}`,
      triggerId: api.channel.id,
      triggerToken: api.token,
      triggerEndpoint: `/api/agent-channels/${api.channel.id}/runs`,
      ...(budget ? { budget } : {})
    };
  } catch (error) {
    // The keys minted for the budget must not outlive the workspace.
    if (budgeted) {
      await closeWorkspaceBudget(document.id, fetch, { deleteModalEnvironment: true }).catch((closeError) =>
        console.warn("[agent-setup] could not close the budget of a failed setup", {
          documentId: document.id,
          error: closeError instanceof Error ? closeError.message : String(closeError)
        })
      );
    }
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    throw error;
  }
}
