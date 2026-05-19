import { spawn } from "node:child_process";
import path from "node:path";

import { AiDocumentBlock } from "@/lib/content";

type ClaudeCommentReplyInput = {
  documentTitle: string;
  documentText: string;
  documentBlocks: AiDocumentBlock[];
  anchorText: string;
  anchorContext: string | null;
  requesterName: string;
  comments: Array<{
    author: string;
    body: string;
  }>;
};

type ClaudeResearchAgentInput = {
  mode: "comment_reply" | "edit_selection" | "conversation";
  documentTitle: string;
  documentText: string;
  unresolvedThreads: Array<{
    id: string;
    anchorText: string;
    anchorContext: string | null;
    comments: Array<{
      author: string;
      body: string;
    }>;
  }>;
  workspacePath: string | null;
  workspaceOverview: string;
  instruction: string;
  anchorText?: string;
  anchorContext?: string | null;
  comments?: Array<{
    author: string;
    body: string;
  }>;
  selectedText?: string;
  selectedContext?: string | null;
  conversationHistory?: Array<{
    role: string;
    message: string;
  }>;
};

type ClaudeCommentReplyOutput = {
  reply: string;
  model: string;
  visitedSources: string[];
};

type AiSelectionEditInput = {
  documentTitle: string;
  documentText: string;
  documentBlocks: AiDocumentBlock[];
  selectedText: string;
  selectedContext: string | null;
  instruction: string;
};

type AiSelectionEditOutput = {
  replacementText: string;
  model: string;
  visitedSources: string[];
};

type ClaudeResearchAgentOutput = {
  reply?: string;
  replacementText?: string;
  images?: Array<{
    path: string;
    alt?: string;
    caption?: string;
  }>;
  widgets?: Array<{
    label: string;
    build_cmd?: string;
    buildCmd?: string;
    embed_source?: string;
    embedSource?: string;
  }>;
  summary?: string;
  model: string;
};

export type ClaudeAgentProgressEvent = {
  role?: "agent" | "tool" | "tool_result" | "system" | "error";
  message: string;
};

function runPythonJsonScript<TInput, TOutput>(
  scriptName: string,
  input: TInput,
  timeoutMs: number,
  timeoutMessage: string,
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>
): Promise<TOutput> {
  const scriptPath = path.join(process.cwd(), "scripts", scriptName);
  const command = process.env.PYTHON_BIN || "uv";
  const args = process.env.PYTHON_BIN
    ? [scriptPath]
    : ["run", "python", scriptPath];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        UV_NO_PROGRESS: "1"
      }
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    let stderrRemainder = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrRemainder += text;

      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      lines.forEach((line) => {
        if (!line.trim()) {
          return;
        }

        try {
          const parsed = JSON.parse(line) as { type?: unknown; role?: unknown; message?: unknown };
          if (parsed.type === "progress" && typeof parsed.message === "string") {
            void onProgress?.({
              role:
                parsed.role === "agent" ||
                parsed.role === "tool" ||
                parsed.role === "tool_result" ||
                parsed.role === "system" ||
                parsed.role === "error"
                  ? parsed.role
                  : undefined,
              message: parsed.message
            });
          }
        } catch {
          // Keep stderr intact for failures; non-JSON lines are normal diagnostics.
        }
      });
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `AI helper exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse AI helper response: ${stdout || stderr}`));
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

export async function runClaudeCommentReply(
  input: ClaudeCommentReplyInput
): Promise<ClaudeCommentReplyOutput> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runPythonJsonScript(
        "claude_comment_reply.py",
        input,
        180_000,
        "AI helper timed out after 180 seconds."
      );
    } catch (error) {
      lastError = error;

      if (attempt === 1) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("AI helper failed unexpectedly.");
}

export async function runAiSelectionEdit(
  input: AiSelectionEditInput
): Promise<AiSelectionEditOutput> {
  return runPythonJsonScript(
    "ai_edit_selection.py",
    input,
    180_000,
    "AI edit helper timed out after 180 seconds."
  );
}

export async function runClaudeResearchAgent(
  input: ClaudeResearchAgentInput,
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>
): Promise<ClaudeResearchAgentOutput> {
  return runPythonJsonScript(
    "claude_research_agent.py",
    input,
    600_000,
    "Claude research agent timed out after 600 seconds.",
    onProgress
  );
}
