// Shared run-lifecycle scaffold for the background agent runners
// (lib/ask-ai.ts, lib/agent-conversation.ts, lib/ai-edit-run.ts).
//
// Every AiRun background function used to hand-roll the same ~120 lines:
// selfHosted runner gating, heartbeat + abort registration, isolated-worktree
// setup (with the workspacePath DB update and "Using isolated worktree …"
// timeline event), credential/env resolution with the free-fallback notices,
// the progress double-write (AiRun.progress + AiRunEvent), the end-of-run
// workspace commit on BOTH the success and failure paths, the terminal FAILED
// bookkeeping, and the deregister/stop-heartbeat/remove-worktree finally.
//
// withAgentRunLifecycle owns that scaffold. The per-runner `fn` receives a
// context whose staged helpers (`setupWorkspace`, `loadEnv`,
// `commitRunChanges`, `onProgress`) it calls in ITS OWN order — the three
// runners interleave their per-mode preparation (document parsing, session
// resume planning, thread queries) differently around these stages, and event
// order is part of the observable contract (agent-timeline.tsx and tests match
// these strings verbatim; keep them byte-identical).

import type { AgentAccessMode, ClaudeAgentProgressEvent } from "@/agent-core";
import { createDeferredHeartbeat, recordAiRunEvent } from "@/lib/ai-runs";
import {
  RUN_CANCELLED_MESSAGE,
  deregisterRunAbortController,
  isRunCancellation,
  registerRunAbortController
} from "@/lib/agent-runner/run-registry";
import { createAgentRunner, getAgentRunner, getSelfHostedRunner, type AgentRunner } from "@/lib/agent-runner";
import { AttachSupersededError } from "@/lib/agent-runner/session-client";
import { db } from "@/lib/db";
import {
  loadAgentEnvWithFreeFallback,
  restrictAgentEnvForReadOnly,
  type AgentRunEnvResolution
} from "@/lib/user-credentials";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  removeRunWorktree,
  type CommitResult,
  type LinkedRepositoryWorktree
} from "@/lib/research-workspace";

// --- Shared timeline strings. These are matched verbatim by the client
// (agent-timeline.tsx renders lifecycle rows) and by tests — never reword one
// without updating every matcher.

export function isolatedWorktreeMessage(linkedRepo: {
  workspace: string;
  branchName: string;
}): string {
  return `Using isolated worktree ${linkedRepo.workspace} on branch ${linkedRepo.branchName}.`;
}

export function freeFallbackNotice(model: string | null): string {
  return `No AI credential connected — running on the free local model (${model}). It is much slower than Claude (first output can take a few minutes). Connect a credential under Settings in the topbar to use Claude.`;
}

export function providerFallbackNotice(model: string | null): string {
  return `No OpenAI credential connected — routing Codex through LiteLLM as ${model}.`;
}

export const READ_ONLY_AGENT_NOTICE =
  "Share-link agent is read-only: repository writes, commands, document secrets, commits, and pushes are disabled.";

export function pushFailureNotice(pushError: string): string {
  return `Changes were committed locally but could not be pushed to the linked repository: ${pushError}`;
}

/**
 * Recognized by name as well as identity: the error can cross module-instance
 * boundaries (instrumentation context vs. route context), where `instanceof`
 * against a second copy of the class silently fails.
 */
function isAttachSuperseded(error: unknown): boolean {
  return (
    error instanceof AttachSupersededError ||
    (error instanceof Error && error.name === "AttachSupersededError")
  );
}

export const SESSION_HANDED_OFF_MESSAGE =
  "Another server process took over this run's agent container — it continues there, driven by another server process. This reader stepped aside.";

export function hostDevRunNotice(cwd: string): string {
  return `⚠ HOST DEV RUN: executing unsandboxed on the host in ${cwd}.`;
}

export type AgentRunLifecycleOptions = {
  aiRunId: string;
  documentId: string;
  createdById: string | null;
  agentAccessMode: AgentAccessMode;
  // Document.runnerMode ("managed" | "selfHosted"). selfHosted documents never
  // get a worktree managed by this app — the owner's external worker clones
  // and works in its own checkout.
  runnerMode: string;
  // Host dev mode (allowlisted Slack dev channel): run unsandboxed in this
  // host directory — no worktree, no end-of-run commit/cleanup. Wins over
  // selfHosted if both are somehow set, since it explicitly wants a live
  // host checkout.
  hostDevDir?: string | null;
  // Commit message used when saving workspace changes after `fn` threw.
  failureCommitMessage: string;
  // Logged (via the hook) when that failure-path commit itself fails; omit to
  // swallow the commit error silently.
  onFailureCommitError?: (error: unknown) => void;
  // Called with the original error right after the failure-path commit,
  // before the terminal bookkeeping (e.g. ask-ai's console.error).
  onRunError?: (error: unknown) => void;
  // Terminal AiRun.error fallback when the thrown value is not an Error.
  defaultFailureMessage: string;
  // Start the liveness heartbeat only when `fn` calls ctx.beginHeartbeat()
  // instead of at run start. Set by runs that begin with a blocking wait (the
  // conversation session lock) so a parked run goes silent and is reaped.
  deferHeartbeat?: boolean;
};

export type AgentRunLifecycleContext = {
  runner: AgentRunner;
  isSelfHosted: boolean;
  abortSignal: AbortSignal;
  // Starts the liveness heartbeat (idempotent). Only meaningful with
  // `deferHeartbeat`; call it as soon as the run really begins working.
  beginHeartbeat(): void;
  // The identical progress double-write every runner passes to runner.run():
  // AiRun.progress update + AiRunEvent append, failures swallowed.
  onProgress: (event: ClaudeAgentProgressEvent) => Promise<void>;
  // Ensures the isolated worktree (managed runs), records workspacePath /
  // branchName on the AiRun, and emits the "Using isolated worktree …" event.
  // Host dev runs record the deployment cwd + HOST DEV notice instead;
  // selfHosted runs get null (the external worker owns its checkout).
  setupWorkspace(): Promise<LinkedRepositoryWorktree | null>;
  // loadAgentEnvWithFreeFallback + the free-fallback / provider-fallback /
  // read-only timeline notices. `runAgentEnv` is the env to hand to
  // runner.run() (read-only-restricted when the access mode demands it);
  // `agentEnv` stays unrestricted for capability checks.
  loadEnv(agentConfig: {
    model: string | null;
    effort: string | null;
  }): Promise<{
    agentEnv: AgentRunEnvResolution["agentEnv"];
    runAgentEnv: AgentRunEnvResolution["agentEnv"];
    effectiveAgentConfig: AgentRunEnvResolution["agentConfig"];
    usedFreeFallback: boolean;
    usedProviderFallback: boolean;
  }>;
  // Success-path workspace commit: commits + pushes the run worktree when the
  // run has one and workspace access, no-op result otherwise; a push failure
  // is surfaced as an error timeline event (never fatal).
  commitRunChanges(message: string): Promise<CommitResult>;
};

export type AgentRunLifecycleResult<T> =
  | { status: "SUCCEEDED"; value: T }
  // The run's detached session container was taken over by another server
  // process (single-attach arbitration). It is NOT finished and NOT failed: the
  // process that attached is the reader now and owns the terminal bookkeeping,
  // so this one records a note and touches nothing else.
  | { status: "HANDED_OFF" }
  | { status: "FAILED"; error: string };

export async function withAgentRunLifecycle<T>(
  opts: AgentRunLifecycleOptions,
  fn: (ctx: AgentRunLifecycleContext) => Promise<T>
): Promise<AgentRunLifecycleResult<T>> {
  const { aiRunId, documentId, createdById, agentAccessMode, hostDevDir } = opts;
  const isSelfHosted = !hostDevDir && opts.runnerMode === "selfHosted";
  const runner = hostDevDir
    ? createAgentRunner("inprocess")
    : isSelfHosted
      ? getSelfHostedRunner()
      : getAgentRunner();
  // Held in an object rather than a `let`: setupWorkspace assigns it from
  // inside a closure, which TS control-flow analysis cannot see, so a plain
  // `let` narrows to `null` at the catch/finally use sites below.
  const state: { linkedRepo: LinkedRepositoryWorktree | null; handedOff: boolean } = {
    linkedRepo: null,
    handedOff: false
  };
  // Conversation runs pass deferHeartbeat and call ctx.beginHeartbeat() once
  // they hold the per-conversation session lock: a run still queued on that
  // lock must look silent, so the reaper can clear it instead of it posing as
  // a live-but-unsteerable run in its Slack thread (see createDeferredHeartbeat).
  const heartbeat = createDeferredHeartbeat(aiRunId, { deferred: opts.deferHeartbeat });
  const abort = registerRunAbortController(aiRunId);

  const ctx: AgentRunLifecycleContext = {
    runner,
    isSelfHosted,
    abortSignal: abort.signal,
    beginHeartbeat: () => heartbeat.begin(),
    onProgress: async (event) => {
      await Promise.all([
        db.aiRun.update({
          where: { id: aiRunId },
          data: { progress: event.message }
        }),
        recordAiRunEvent({
          aiRunId,
          role: event.role ?? "agent",
          message: event.message
        })
      ]).catch(() => null);
    },
    setupWorkspace: async () => {
      state.linkedRepo =
        hostDevDir || isSelfHosted
          ? null
          : await ensureLinkedRepositoryWorktree(documentId, aiRunId, createdById);
      if (hostDevDir) {
        await db.aiRun.update({
          where: { id: aiRunId },
          data: { workspacePath: hostDevDir }
        });
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message: hostDevRunNotice(hostDevDir)
        });
      }
      if (state.linkedRepo) {
        await db.aiRun.update({
          where: { id: aiRunId },
          data: {
            workspacePath: state.linkedRepo.workspace,
            branchName: state.linkedRepo.branchName
          }
        });
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message: isolatedWorktreeMessage(state.linkedRepo)
        });
      }
      return state.linkedRepo;
    },
    loadEnv: async (agentConfig) => {
      const {
        agentEnv,
        agentConfig: effectiveAgentConfig,
        usedFreeFallback,
        usedProviderFallback
      } = await loadAgentEnvWithFreeFallback(documentId, agentConfig, createdById, {
        aiRunId,
        runnerMode: runner.mode
      });
      if (usedFreeFallback) {
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message: freeFallbackNotice(effectiveAgentConfig.model)
        });
      }
      if (usedProviderFallback) {
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message: providerFallbackNotice(effectiveAgentConfig.model)
        });
      }
      if (agentAccessMode === "read_only") {
        await recordAiRunEvent({
          aiRunId,
          role: "system",
          message: READ_ONLY_AGENT_NOTICE
        });
      }
      return {
        agentEnv,
        runAgentEnv:
          agentAccessMode === "read_only" ? restrictAgentEnvForReadOnly(agentEnv) : agentEnv,
        effectiveAgentConfig,
        usedFreeFallback,
        usedProviderFallback
      };
    },
    commitRunChanges: async (message) => {
      const commit: CommitResult =
        state.linkedRepo && agentAccessMode === "workspace"
          ? await commitWorkspaceChanges({
              workspace: state.linkedRepo.workspace,
              baseWorkspace: state.linkedRepo.baseWorkspace,
              repoUrl: state.linkedRepo.url,
              message,
              push: true
            })
          : { commitSha: null, commitUrl: null, pushed: false };
      if (commit.pushError) {
        await recordAiRunEvent({
          aiRunId,
          role: "error",
          message: pushFailureNotice(commit.pushError)
        }).catch(() => null);
      }
      return commit;
    }
  };

  try {
    const value = await fn(ctx);
    return { status: "SUCCEEDED", value };
  } catch (error) {
    if (isAttachSuperseded(error)) {
      state.handedOff = true;
      // Handover, not failure. Do not commit (the other reader's container is
      // still writing that worktree), do not mark FAILED (that would revoke the
      // still-working agent's broker credentials and post a failure to Slack),
      // do not record an error event.
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: SESSION_HANDED_OFF_MESSAGE
      }).catch(() => null);
      return { status: "HANDED_OFF" };
    }
    if (state.linkedRepo && agentAccessMode === "workspace") {
      await commitWorkspaceChanges({
        workspace: state.linkedRepo.workspace,
        baseWorkspace: state.linkedRepo.baseWorkspace,
        repoUrl: state.linkedRepo.url,
        message: opts.failureCommitMessage,
        push: true
      }).catch((commitError) => {
        opts.onFailureCommitError?.(commitError);
        return null;
      });
    }

    opts.onRunError?.(error);

    const failureMessage = isRunCancellation(error, abort.signal)
      ? RUN_CANCELLED_MESSAGE
      : error instanceof Error
        ? error.message
        : opts.defaultFailureMessage;
    await recordAiRunEvent({
      aiRunId,
      role: "error",
      message: failureMessage
    }).catch(() => null);
    await db.aiRun
      .update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: failureMessage,
          finishedAt: new Date()
        }
      })
      .catch(() => null);
    return { status: "FAILED", error: failureMessage };
  } finally {
    deregisterRunAbortController(aiRunId);
    heartbeat.stop();
    // A handed-off run's container is STILL WORKING in that worktree (it is a
    // bind mount, not a copy) — deleting it here would corrupt the run the other
    // process is now driving.
    if (!state.handedOff && state.linkedRepo && state.linkedRepo.baseWorkspace !== state.linkedRepo.worktree) {
      await removeRunWorktree(state.linkedRepo).catch(() => null);
    }
  }
}
