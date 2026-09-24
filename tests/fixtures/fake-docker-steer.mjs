#!/usr/bin/env node
// Fake container runtime for the stdio steering-ack tests
// (tests/agent-steer-ack.test.ts). Stands in for `docker`:
//   docker info ...   → no extra OCI runtimes
//   docker rm/kill    → no-op
//   docker run ...    → reads the job line, then answers every steering frame
//                       like runner/agent-entrypoint.ts does. FAKE_STEER_MODE
//                       picks the answer: "accept" | "refuse" | "silent" (an
//                       image that predates the ack protocol). The run ends on
//                       a steering message whose text is "__finish__", or when
//                       stdin closes.
import readline from "node:readline";

const [command] = process.argv.slice(2);
if (command === "info") {
  process.stdout.write("{}\n");
  process.exit(0);
}
if (command !== "run") process.exit(0);

const mode = process.env.FAKE_STEER_MODE || "accept";
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
let sawJob = false;
const finish = () => {
  emit({ type: "result", output: { reply: "done" } });
  process.exit(0);
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  if (!sawJob) {
    sawJob = true;
    emit({ type: "progress", event: { role: "system", message: "fake container ready" } });
    return;
  }
  const frame = JSON.parse(line);
  if (frame.type === "user_message" && frame.text === "__finish__") return finish();
  if (frame.type === "user_message" && mode !== "silent") {
    emit({ type: "steer_ack", id: frame.id, accepted: mode === "accept" });
  }
}).on("close", finish);
