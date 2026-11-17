// Agent presets: named configurations a user starts an integration's agent
// from, on the /agent-setup consent page. A preset holds everything that page
// lets the user choose, so "run my careful Opus agent with a $50 budget on this
// task" is one pick instead of five. Presets are the user's own; integrations
// never see them, only the name of the one a run was started with.

import { z } from "zod";

import { AGENT_EFFORTS, isStorableAgentModel } from "@/agent-core/agent-config";
import { db } from "@/lib/db";

export const MAX_AGENT_PRESETS = 30;
const EFFORT_VALUES = AGENT_EFFORTS.map((effort) => effort.value) as [string, ...string[]];

export const agentPresetNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\n\r\t]+$/, "A preset name is one line.");

export const agentPresetConfigSchema = z.object({
  /** A storable Document.agentModel value; null = the user's default model. */
  agentModel: z
    .string()
    .max(200)
    .nullable()
    .refine((value) => value === null || isStorableAgentModel(value), "Unknown model."),
  /** null = the user's default effort. */
  agentEffort: z.enum(EFFORT_VALUES).nullable(),
  /** Names of skills in the user's library. */
  skills: z.array(z.string().min(1).max(64)).max(20),
  /** Ids of the credential choices on the consent page (runCredentialChoices). */
  credentialIds: z.array(z.string().min(1).max(64)).max(40),
  budget: z
    .object({
      provisionerDocumentId: z.string().min(1).max(64),
      budgetUsd: z.number().positive().max(1_000_000),
      costProjectParent: z.string().trim().max(100).nullable()
    })
    .nullable()
});

export type AgentPresetConfig = z.infer<typeof agentPresetConfigSchema>;
export type AgentPresetView = { id: string; name: string; config: AgentPresetConfig; updatedAt: string };

export class AgentPresetError extends Error {}

function parseConfig(raw: string): AgentPresetConfig | null {
  try {
    const parsed = agentPresetConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The user's presets, by name. One whose stored config no longer validates is left out. */
export async function listAgentPresets(userId: string): Promise<AgentPresetView[]> {
  const rows = await db.agentPreset.findMany({ where: { userId }, orderBy: { name: "asc" } });
  return rows.flatMap((row) => {
    const config = parseConfig(row.config);
    return config ? [{ id: row.id, name: row.name, config, updatedAt: row.updatedAt.toISOString() }] : [];
  });
}

/** Create the preset, or replace the one of that name. */
export async function saveAgentPreset(userId: string, name: string, config: AgentPresetConfig): Promise<AgentPresetView> {
  const existing = await db.agentPreset.findUnique({ where: { userId_name: { userId, name } } });
  if (!existing && (await db.agentPreset.count({ where: { userId } })) >= MAX_AGENT_PRESETS) {
    throw new AgentPresetError(`You have ${MAX_AGENT_PRESETS} presets already. Delete one first.`);
  }
  const row = await db.agentPreset.upsert({
    where: { userId_name: { userId, name } },
    create: { userId, name, config: JSON.stringify(config) },
    update: { config: JSON.stringify(config) }
  });
  return { id: row.id, name: row.name, config, updatedAt: row.updatedAt.toISOString() };
}

export async function deleteAgentPreset(userId: string, id: string): Promise<boolean> {
  const deleted = await db.agentPreset.deleteMany({ where: { id, userId } });
  return deleted.count > 0;
}
