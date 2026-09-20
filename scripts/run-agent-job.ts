/** Generic external orchestrator seam. JSON AgentJob on stdin; NDJSON events on stdout.
 * Reuses the production container runner; no document, Prisma mutation or host credentials.
 * Caller owns workspaces, credentials, accounting, persistence and scheduling.
 */
import { createInterface } from "node:readline";
import { ContainerRunner } from "../lib/agent-runner/container";
import type { AgentJob } from "../lib/agent-runner";

async function main() {
  const lines = createInterface({ input: process.stdin });
  const line = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    lines.once("close", () => reject(new Error("Expected one JSON AgentJob")));
  });
  lines.close();
  const job = JSON.parse(line) as AgentJob & { containerName?: string; timeoutSeconds?: number };
  if (!job.input?.workspacePath || !job.agentConfig?.model) throw new Error("workspacePath and model required");
  // This CLI has no persistent AiRun row: use attached transport and bounded cancellation.
  process.env.AGENT_DETACHED_CONTAINERS = "0";
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), Math.min(job.timeoutSeconds ?? 3600, 86400) * 1000);
  const emit = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
  try {
    const result = await new ContainerRunner().run(job.input, {
      agentConfig: job.agentConfig, agentEnv: job.agentEnv, validation: job.validation,
      containerName: job.containerName, innerDocker: false, signal: controller.signal,
      onProgress: (event) => { emit({ type: "progress", ...event }); },
      onSessionId: (sessionId) => { emit({ type: "session", sessionId }); }
    });
    emit({ type: "result", result });
  } finally { clearTimeout(timer); }
}
main().catch((error) => {
  process.stdout.write(JSON.stringify({ type: "error", message: String(error) }) + "\n");
  process.exitCode = 1;
});
