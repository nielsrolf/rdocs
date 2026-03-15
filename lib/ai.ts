import { spawn } from "node:child_process";
import fs from "node:fs";
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

type ClaudeCommentReplyOutput = {
  reply: string;
  model: string;
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
};

function getPythonEnv() {
  const pythonHome = path.join(process.cwd(), ".python-home");
  const cacheHome = path.join(process.cwd(), ".cache");

  fs.mkdirSync(pythonHome, { recursive: true });
  fs.mkdirSync(cacheHome, { recursive: true });

  return {
    pythonHome,
    cacheHome
  };
}

function runPythonJsonScript<TInput, TOutput>(
  scriptName: string,
  input: TInput,
  timeoutMs: number,
  timeoutMessage: string
): Promise<TOutput> {
  const pythonBin = process.env.PYTHON_BIN || "python3";
  const scriptPath = path.join(process.cwd(), "scripts", scriptName);
  const { pythonHome, cacheHome } = getPythonEnv();

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: pythonHome,
        XDG_CACHE_HOME: cacheHome
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

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
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
        75_000,
        "AI helper timed out after 75 seconds."
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
    75_000,
    "AI edit helper timed out after 75 seconds."
  );
}
