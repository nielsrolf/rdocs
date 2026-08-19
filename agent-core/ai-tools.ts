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
  // Plan tracking: the agent panel folds these into the session plan rail
  // (components/document-workspace/todo-outline.ts). Newer Claude Code builds
  // ship the Task* family instead of the single TodoWrite snapshot tool, so
  // both names stay listed.
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet"
];

export type AgentAccessMode = "workspace" | "read_only";

const READ_ONLY_AGENT_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet"
];

export function toolsForAgentAccess(mode: AgentAccessMode | null | undefined): string[] {
  return mode === "read_only" ? [...READ_ONLY_AGENT_TOOLS] : [...CLAUDE_AGENT_TOOLS];
}
