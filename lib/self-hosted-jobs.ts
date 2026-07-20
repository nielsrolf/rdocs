import { db } from "@/lib/db";
import { recordAiRunEvent } from "@/lib/ai-runs";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/secret-crypto";

// DB access for the selfHostedPull runner queue (Document.runnerMode ===
// "selfHosted"). A SelfHostedJob is the serialized equivalent of what
// ContainerRunner bind-mounts a worktree for: the OWNER's external worker
// polls `claimNextSelfHostedJob`, does the work in its OWN clone of the repo
// (the app never manages a worktree for these documents), and reports back
// via `completeSelfHostedJob` / `failSelfHostedJob`.

export type SelfHostedJobStatus = "pending" | "claimed" | "succeeded" | "failed" | "cancelled";

/** Enqueue a job for a selfHosted document's run. Called by SelfHostedPullRunner.run(). */
export async function enqueueSelfHostedJob(input: {
  documentId: string;
  aiRunId: string;
  jobPayload: unknown;
}) {
  return db.selfHostedJob.create({
    data: {
      documentId: input.documentId,
      aiRunId: input.aiRunId,
      // Encrypted at rest: the payload carries the owner's agentEnv
      // (AI/GitHub credentials). Decrypted only when a worker claims it.
      jobPayload: encryptSecret(JSON.stringify(input.jobPayload)),
      status: "pending"
    },
    select: { id: true, createdAt: true }
  });
}

/** Decode a stored jobPayload (encrypted; tolerates legacy plaintext rows). */
export function decodeJobPayload(stored: string): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

/**
 * Claim the oldest pending job among the documents `userId` OWNS (worker auth
 * resolves to the document owner's own ApiToken — see
 * app/api/self-hosted/jobs/claim/route.ts). Marks it "claimed" atomically via
 * a conditional update so two concurrent workers can't double-claim the same
 * row; returns null if nothing is pending.
 */
export async function claimNextSelfHostedJob(userId: string) {
  const candidate = await db.selfHostedJob.findFirst({
    where: { status: "pending", document: { ownerId: userId } },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
  if (!candidate) return null;

  const claimedAt = new Date();
  const result = await db.selfHostedJob.updateMany({
    where: { id: candidate.id, status: "pending" },
    data: { status: "claimed", claimedAt }
  });
  if (result.count === 0) {
    // Lost the race to another worker poll — the caller can retry immediately.
    return null;
  }

  const row = await db.selfHostedJob.findUnique({
    where: { id: candidate.id },
    select: {
      id: true,
      documentId: true,
      aiRunId: true,
      jobPayload: true,
      claimedAt: true,
      createdAt: true
    }
  });
  return row ? { ...row, jobPayload: decodeJobPayload(row.jobPayload) } : null;
}

/**
 * Cancel a pending/claimed job (the app-side run was aborted). The worker
 * learns about it from the `cancelled` flag on its next progress post — there
 * is no push channel to the worker.
 */
export async function cancelSelfHostedJob(id: string) {
  const result = await db.selfHostedJob.updateMany({
    where: { id, status: { in: ["pending", "claimed"] } },
    data: { status: "cancelled", finishedAt: new Date() }
  });
  return result.count === 1;
}

/**
 * Worker streams progress frames for a claimed job. Ownership is re-checked
 * like completeSelfHostedJob. Returns `cancelled: true` when the app-side run
 * was aborted — the worker must stop and discard the job.
 */
export async function recordSelfHostedProgress(
  id: string,
  userId: string,
  events: Array<{ role?: "agent" | "tool" | "tool_result" | "system" | "error"; message: string }>
): Promise<{ ok: boolean; cancelled: boolean }> {
  const job = await db.selfHostedJob.findUnique({
    where: { id },
    select: { id: true, aiRunId: true, status: true, document: { select: { ownerId: true } } }
  });
  if (!job || job.document.ownerId !== userId) return { ok: false, cancelled: false };
  if (job.status === "cancelled") return { ok: true, cancelled: true };
  if (job.status !== "claimed") return { ok: false, cancelled: false };

  const trimmed = events.slice(0, 50);
  for (const event of trimmed) {
    await recordAiRunEvent({
      aiRunId: job.aiRunId,
      role: event.role ?? "agent",
      message: event.message.slice(0, 8000)
    }).catch(() => null);
  }
  const last = trimmed.at(-1);
  if (last) {
    await db.aiRun
      .update({ where: { id: job.aiRunId }, data: { progress: last.message.slice(0, 2000) } })
      .catch(() => null);
  }
  return { ok: true, cancelled: false };
}

/** Look up a job the way SelfHostedPullRunner polls for completion. */
export async function getSelfHostedJob(id: string) {
  return db.selfHostedJob.findUnique({
    where: { id },
    select: {
      id: true,
      documentId: true,
      aiRunId: true,
      status: true,
      resultPayload: true,
      error: true,
      claimedAt: true,
      finishedAt: true
    }
  });
}

/**
 * Worker reports success/failure for a claimed job. `userId` must own the
 * job's document — a worker only ever touches jobs it could have claimed
 * (double-checked here rather than trusted from the URL alone).
 */
export async function completeSelfHostedJob(
  id: string,
  userId: string,
  outcome: { status: "succeeded"; resultPayload: unknown } | { status: "failed"; error: string }
): Promise<boolean> {
  const job = await db.selfHostedJob.findUnique({
    where: { id },
    select: { id: true, status: true, document: { select: { ownerId: true } } }
  });
  if (!job || job.document.ownerId !== userId) return false;
  // A cancelled job's result is dropped: the app-side run already rejected.
  if (job.status !== "claimed" && job.status !== "pending") return false;

  await db.selfHostedJob.update({
    where: { id },
    data:
      outcome.status === "succeeded"
        ? {
            status: "succeeded",
            resultPayload: JSON.stringify(outcome.resultPayload),
            finishedAt: new Date()
          }
        : { status: "failed", error: outcome.error.slice(0, 8000), finishedAt: new Date() }
  });
  return true;
}
