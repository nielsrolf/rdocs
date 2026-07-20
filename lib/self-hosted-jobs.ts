import { db } from "@/lib/db";

// DB access for the selfHostedPull runner queue (Document.runnerMode ===
// "selfHosted"). A SelfHostedJob is the serialized equivalent of what
// ContainerRunner bind-mounts a worktree for: the OWNER's external worker
// polls `claimNextSelfHostedJob`, does the work in its OWN clone of the repo
// (the app never manages a worktree for these documents), and reports back
// via `completeSelfHostedJob` / `failSelfHostedJob`.

export type SelfHostedJobStatus = "pending" | "claimed" | "succeeded" | "failed";

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
      jobPayload: JSON.stringify(input.jobPayload),
      status: "pending"
    },
    select: { id: true, createdAt: true }
  });
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

  return db.selfHostedJob.findUnique({
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
    select: { id: true, document: { select: { ownerId: true } } }
  });
  if (!job || job.document.ownerId !== userId) return false;

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
