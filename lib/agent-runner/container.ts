import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ClaudeAgentProgressEvent,
  ClaudeResearchAgentInput,
  ClaudeResearchAgentOutput
} from "@/agent-core";

import type { AgentRunner, AgentRunOptions } from "./index";
import { toAgentJob } from "./index";
import { buildContainerEnv, buildContainerRunArgs, serializeEnvFile } from "./container-args";
import { resolveAgentCredentialEnv } from "./agent-credential";

// Runs the agent in a hardened local container with the document worktree
// bind-mounted at /workspace. The agent's tools are confined to the container's
// mount namespace, so the host home / app repo / sibling worktrees are
// unreachable — the real boundary the in-process path lacked.
//
// Transport: the job goes in over stdin; NDJSON frames come back over stdout;
// stderr is forwarded to the server log. Secrets ride a host-side --env-file.
export class ContainerRunner implements AgentRunner {
  readonly mode = "container" as const;

  async run(
    input: ClaudeResearchAgentInput,
    options?: AgentRunOptions
  ): Promise<ClaudeResearchAgentOutput> {
    const job = toAgentJob(input, options);
    if (!job.input.workspacePath) {
      throw new Error(
        "[agent-runner] container mode requires an isolated workspace path; refusing to run without one."
      );
    }

    const runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker";
    const image = process.env.AGENT_CONTAINER_IMAGE || "gdocs-agent:local";
    const readOnly = process.env.AGENT_CONTAINER_READONLY !== "false";

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gdocs-agent-"));
    const envFile = path.join(tmpDir, "env");

    try {
      const containerEnv = buildContainerEnv(process.env, job.agentEnv ?? {});
      // Supply an Anthropic credential the scrubbed env wouldn't otherwise carry
      // (falls back to the host ~/.claude OAuth session). See agent-credential.ts.
      const { added, warning } = resolveAgentCredentialEnv(containerEnv, { homeDir: process.env.HOME });
      Object.assign(containerEnv, added);
      if (warning) console.warn(`[agent-runner] ${warning}`);
      await writeFile(envFile, serializeEnvFile(containerEnv), { mode: 0o600 });

      const args = buildContainerRunArgs({
        image,
        workspaceHostPath: job.input.workspacePath,
        envFileHostPath: envFile,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        memory: process.env.AGENT_CONTAINER_MEMORY || "4g",
        cpus: process.env.AGENT_CONTAINER_CPUS || undefined,
        pidsLimit: 512,
        readOnly
      });

      return await this.spawnContainer(runtime, args, job, options?.onProgress);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private spawnContainer(
    runtime: string,
    args: string[],
    job: ReturnType<typeof toAgentJob>,
    onProgress?: AgentRunOptions["onProgress"]
  ): Promise<ClaudeResearchAgentOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(runtime, args, { stdio: ["pipe", "pipe", "pipe"] });

      let result: ClaudeResearchAgentOutput | null = null;
      let frameError: string | null = null;
      let stdoutBuffer = "";
      let stderrTail = "";
      const pending: Array<Promise<unknown>> = [];

      const handleFrame = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let frame: { type?: string; event?: ClaudeAgentProgressEvent; output?: ClaudeResearchAgentOutput; message?: string };
        try {
          frame = JSON.parse(trimmed);
        } catch {
          // Non-NDJSON noise on stdout — treat as a log line, don't crash.
          process.stderr.write(`[agent-container] non-JSON stdout: ${trimmed}\n`);
          return;
        }
        if (frame.type === "progress" && frame.event && onProgress) {
          pending.push(Promise.resolve(onProgress(frame.event)).catch(() => {}));
        } else if (frame.type === "result" && frame.output) {
          result = frame.output;
        } else if (frame.type === "error") {
          frameError = frame.message ?? "Agent container reported an error.";
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        let nl: number;
        while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
          handleFrame(stdoutBuffer.slice(0, nl));
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        process.stderr.write(`[agent-container] ${text}`);
      });

      child.on("error", (error) => reject(error));

      child.on("close", async (code) => {
        if (stdoutBuffer.trim()) handleFrame(stdoutBuffer);
        await Promise.all(pending);
        if (frameError) {
          reject(new Error(frameError));
          return;
        }
        if (result) {
          resolve(result);
          return;
        }
        reject(
          new Error(
            `Agent container exited with code ${code} without emitting a result.` +
              (stderrTail ? ` Last stderr:\n${stderrTail}` : "")
          )
        );
      });

      child.stdin.write(JSON.stringify(job));
      child.stdin.end();
    });
  }
}
