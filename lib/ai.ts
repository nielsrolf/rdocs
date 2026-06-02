// Moved to agent-core/agent.ts so the agent runtime can be imported by the
// standalone container entrypoint without pulling in Next.js. This shim keeps
// the historical `@/lib/ai` import path working.
export * from "../agent-core/agent";
