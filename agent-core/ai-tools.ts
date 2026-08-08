export const CLAUDE_AGENT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "LS",
  "Bash",
  "WebSearch",
  "WebFetch",
  // Plan tracking: the agent panel renders these snapshots as the session
  // plan rail (components/document-workspace/todo-outline.ts).
  "TodoWrite"
];

export type AgentAccessMode = "workspace" | "read_only";

const READ_ONLY_AGENT_TOOLS = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "TodoWrite"];

export function toolsForAgentAccess(mode: AgentAccessMode | null | undefined): string[] {
  return mode === "read_only" ? [...READ_ONLY_AGENT_TOOLS] : [...CLAUDE_AGENT_TOOLS];
}
