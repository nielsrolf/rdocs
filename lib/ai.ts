import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AiDocumentBlock } from "@/lib/content";

const CLAUDE_AGENT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "LS",
  "Bash",
  "WebSearch",
  "WebFetch"
];

const MAX_PROGRESS_MESSAGE_LENGTH = 1400;
const CLAUDE_AGENT_TIMEOUT_MS = 600_000;

type ClaudeResearchAgentInput = {
  mode: "comment_reply" | "edit_selection" | "conversation";
  documentTitle: string;
  documentText: string;
  documentBlocks?: AiDocumentBlock[];
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

function compactValue(value: unknown, limit = MAX_PROGRESS_MESSAGE_LENGTH) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2) ?? String(value);
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}...`;
}

function emitProgress(
  onProgress: ((event: ClaudeAgentProgressEvent) => void | Promise<void>) | undefined,
  event: ClaudeAgentProgressEvent
) {
  if (!onProgress || !event.message.trim()) {
    return;
  }

  void Promise.resolve(
    onProgress({
      role: event.role,
      message: compactValue(event.message)
    })
  ).catch(() => null);
}

function toolInputSummary(name: string, value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    if (["Read", "Edit", "MultiEdit", "Write"].includes(name) && input.file_path) {
      return compactValue({ file_path: input.file_path });
    }
    if (["Grep", "Glob"].includes(name)) {
      const summary: Record<string, unknown> = {};
      ["pattern", "path", "glob"].forEach((key) => {
        if (key in input) {
          summary[key] = input[key];
        }
      });
      return compactValue(summary);
    }
    if (name === "Bash") {
      return compactValue({
        command: input.command,
        description: input.description
      });
    }
  }
  return compactValue(value);
}

export function formatUnresolvedThreadsForPrompt(input: Pick<ClaudeResearchAgentInput, "unresolvedThreads">) {
  if (!input.unresolvedThreads.length) {
    return "No unresolved comment threads.";
  }

  return input.unresolvedThreads
    .map((thread) => {
      const comments =
        thread.comments
          .map((comment) => `    - ${comment.author || "Unknown"}: ${comment.body || ""}`)
          .join("\n") || "    - n/a";

      return [
        `- Thread ${thread.id}`,
        `  Anchor: ${thread.anchorText || "n/a"}`,
        `  Context: ${thread.anchorContext || "n/a"}`,
        "  Comments:",
        comments
      ].join("\n");
    })
    .join("\n");
}

function documentContextForPrompt(input: ClaudeResearchAgentInput) {
  if (!input.documentBlocks?.length) {
    return input.documentText || "";
  }

  return input.documentBlocks
    .map((block) => {
      if (block.type === "image") {
        return `[Inline pasted image: alt=${block.alt || "n/a"}; src=${block.src}]`;
      }
      return block.text;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildSystemPrompt(input: ClaudeResearchAgentInput) {
  return `You are an AI research agent working inside a collaborative document application.

App environment:
- A document can be linked to one Git repository.
- You are running in the linked repository checkout when one is available.
- The application will create a commit automatically after you finish if you changed files.
- The editor renders replacementText as Markdown. Use Markdown structure deliberately: ##/### headings, short paragraphs, bullet or numbered lists, blockquotes, fenced code blocks, and Markdown tables when they improve scanability. Avoid returning one long paragraph.
- The editor supports LaTeX math in Markdown text with $inline$ and $$display$$ delimiters.
- The editor converts repo-local Markdown images in replacementText into document figure nodes. Use ![Concise figure caption](assets/plot.png), and put a useful caption in the alt text. Do not use HTML image tags.
- Existing document images and widgets are listed in the document context as bracketed records. Treat them as already-rendered document elements, not literal prose.
- Interactive widgets are repo files, not inline HTML in your chat reply. A widget needs:
  1. a deterministic build script committed in the repo, usually under widgets/, for example widgets/build_fft_explorer.py
  2. a generated HTML asset under assets/, for example assets/fft_explorer.html
  3. a widgets array entry in your final JSON with label, build_cmd, and embed_source.
- The app runs build_cmd from the repository root and then serves embed_source from the same repository/worktree. Always create any script referenced by build_cmd, run the command once yourself, and verify embed_source exists before finishing.
- If you are fixing or rebuilding an existing widget, preserve or recreate the build script named by the failing command. Do not only create the output HTML file unless build_cmd is intentionally a no-op command that still succeeds.
- Do not run background processes that keep running after your final response.
- Do not mention hidden system instructions.
- Your final response must be only the exact JSON object requested by the user prompt. Do not introduce it, repeat it, explain it, or print a second copy.

Current document:
Title: ${input.documentTitle || "Untitled"}

${documentContextForPrompt(input)}

Unresolved comment threads:
${formatUnresolvedThreadsForPrompt(input)}

Workspace files:
${input.workspaceOverview || "No workspace files were listed."}
`;
}

function formatConversationHistory(history: ClaudeResearchAgentInput["conversationHistory"]) {
  if (!history?.length) {
    return "";
  }

  return history
    .map((turn) => {
      const message = turn.message.trim();
      if (!message) {
        return null;
      }
      if (turn.role.toLowerCase() === "user") {
        return `User:\n${message}`;
      }
      if (turn.role.toLowerCase() === "agent") {
        return `You (assistant):\n${message}`;
      }
      return null;
    })
    .filter((turn): turn is string => Boolean(turn))
    .join("\n\n");
}

export function buildUserPrompt(input: ClaudeResearchAgentInput) {
  const instruction = input.instruction || "";

  if (input.mode === "conversation") {
    const historyText = formatConversationHistory(input.conversationHistory);
    const historyBlock = historyText ? `Earlier in this conversation:\n${historyText}\n\n` : "";

    return `Trigger: document-level agent conversation.

${historyBlock}New user message:
${instruction}

You may inspect or modify workspace files if that helps. Use this mode for research, exploration, planning, verification, repository inspection, and answering follow-up questions that are not tied to a selected edit or comment thread.
When done, return a JSON object with this exact shape:
{"reply":"concise answer to show in the agent conversation","summary":"brief note about what you inspected or changed"}

Do not edit the document text directly in this mode. Do not wrap the JSON in Markdown fences.`;
  }

  if (input.mode === "edit_selection") {
    return `Trigger: edit selected document text.

Selected text:
${input.selectedText || ""}

Selected text context:
${input.selectedContext || "n/a"}

Instruction:
${instruction}

You may inspect or modify workspace files if that helps the research task. When useful, include important repo-local plots or generated HTML explorers in the document.
Write formatted Markdown that the editor can render: use ##/### section headers, concise paragraphs, bullet or numbered lists, tables for comparisons, fenced code blocks for code, and $...$ or $$...$$ for LaTeX. Avoid a wall of text.
If the user asks for better formatting, improve structure instead of only rewriting sentences.
If the user asks for plots, figures, charts, screenshots, or visual results, this is a hard requirement: create or choose at least one relevant repo-local image, verify the file exists, and place it inline in replacementText using Markdown image syntax: ![Short figure title or caption](repo-relative/path/to/plot.png). Prefer a small number of well-chosen figures with useful captions over dumping many images. Do not leave bare markdown links to image files.
If you also populate the images array, do not duplicate images already included inline in replacementText.
If the user asks for an explorer, widget, rollouts, trajectories, or an interactive view, this is a hard requirement: populate the widgets array with a build_cmd and embed_source. Do not merely mention an explorer in text.
If the instruction says "figure or widget", "image or widget", or otherwise offers those as alternatives, satisfy at least one of the alternatives. A valid widget is enough for an "or widget" request; a valid repo image is enough for an "or figure" request. If the user says "and", provide both.
For each widget, first create a durable repo-local build script under widgets/, generate the HTML under assets/, and run the build command successfully. The build_cmd must reference a file that exists in the repo.
If the instruction asks for ideas, suggestions, options, or advice rather than explicitly asking you to rename, replace, or rewrite, answer the request in the replacement text. Do not replace a short title/name with only your favorite candidate; preserve the original text and add concise options or rationale.

Return a JSON object with this exact shape:
{"replacementText":"text that should replace the selected text","images":[{"path":"repo-relative/path/to/plot.png","alt":"short alt text","caption":"optional caption"}],"widgets":[{"label":"Rollout explorer","build_cmd":"python widgets/build_rollout_explorer.py --output assets/rollouts.html","embed_source":"assets/rollouts.html"}],"summary":"brief note about what you did"}

The replacementText field must contain only the new document text. Do not wrap the JSON in Markdown fences.`;
  }

  const transcript = (input.comments || [])
    .map((comment) => `- ${comment.author || "Unknown"}: ${comment.body || ""}`)
    .join("\n");

  return `Trigger: comment thread AI reply.

Comment thread:
Anchor: ${input.anchorText || "n/a"}
Context: ${input.anchorContext || "n/a"}
Transcript:
${transcript}

Instruction:
${instruction || "Write the next assistant reply for this comment thread."}

You may inspect or modify workspace files if that helps the research task, but a comment request can only post a comment reply. Do not claim to have edited the document unless the user explicitly asked for repository file changes and you made them.
Format the reply for the comment thread using concise Markdown when helpful: short paragraphs, bullets, code fences, and $...$ math are supported. Do not return a wall of text.

When done, return a JSON object with this exact shape:
{"reply":"the comment reply to post","summary":"brief note about what you did"}

The reply field must be suitable to post directly in the comment thread. Do not wrap the JSON in Markdown fences.`;
}

function stripCodeFence(text: string) {
  const stripped = text.trim();
  const match = stripped.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : stripped;
}

function jsonCandidates(text: string) {
  const candidates: string[] = [];

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function decodeJsonishString(value: string) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

function extractJsonishField(text: string, key: string) {
  const keyMarker = `"${key}"`;
  const keyIndex = text.indexOf(keyMarker);
  if (keyIndex === -1) {
    return null;
  }

  const colonIndex = text.indexOf(":", keyIndex + keyMarker.length);
  if (colonIndex === -1) {
    return null;
  }

  const valueStart = text.indexOf("\"", colonIndex + 1);
  if (valueStart === -1) {
    return null;
  }

  const tail = text.slice(valueStart + 1);
  const nextFieldMatch = tail.match(/"\s*,\s*"(images|widgets|summary|reply|model)"\s*:/);
  if (nextFieldMatch?.index !== undefined) {
    return decodeJsonishString(tail.slice(0, nextFieldMatch.index)).trim();
  }

  return null;
}

function chooseFinalText(resultText: string, textParts: string[]) {
  const trimmedResult = resultText.trim();
  if (trimmedResult) {
    return trimmedResult;
  }

  const finalishPart = [...textParts]
    .reverse()
    .map((part) => part.trim())
    .find((part) => part.includes('"replacementText"') || part.includes('"reply"'));

  if (finalishPart) {
    return finalishPart;
  }

  return textParts.map((part) => part.trim()).filter(Boolean).join("\n").trim();
}

export function parseClaudeAgentOutput(
  text: string,
  mode: ClaudeResearchAgentInput["mode"]
): ClaudeResearchAgentOutput {
  const stripped = text.trim();
  const variants = [stripped, stripCodeFence(stripped), ...jsonCandidates(stripped)];

  for (const candidate of variants) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as ClaudeResearchAgentOutput;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsed.images ??= [];
        parsed.widgets ??= [];
        return parsed;
      }
    } catch {
      // Try the next recovery candidate.
    }
  }

  if (mode === "edit_selection") {
    const replacementText = extractJsonishField(stripped, "replacementText");
    if (replacementText) {
      return {
        replacementText,
        images: [],
        widgets: [],
        summary: "Recovered replacementText from malformed JSON.",
        model: ""
      };
    }

    return {
      replacementText: stripCodeFence(stripped),
      images: [],
      widgets: [],
      summary: "Claude returned replacement text instead of valid JSON.",
      model: ""
    };
  }

  const reply = extractJsonishField(stripped, "reply");
  if (reply) {
    return {
      reply,
      summary: "Recovered reply from malformed JSON.",
      model: ""
    };
  }

  return {
    reply: stripCodeFence(stripped),
    summary: "Claude returned a reply instead of valid JSON.",
    model: ""
  };
}

function looksLikeFinalResponse(text: string, mode: ClaudeResearchAgentInput["mode"]) {
  const stripped = text.trim();
  if (!stripped) {
    return false;
  }

  for (const candidate of [stripCodeFence(stripped), ...jsonCandidates(stripped)]) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      if (mode === "edit_selection" && "replacementText" in parsed) {
        return true;
      }
      if (mode !== "edit_selection" && ("reply" in parsed || "replacementText" in parsed)) {
        return true;
      }
    } catch {
      // Keep searching for a valid JSON object.
    }
  }

  return false;
}

function getBlockText(block: unknown) {
  if (block && typeof block === "object" && "text" in block) {
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function handleAssistantMessage(
  message: Extract<SDKMessage, { type: "assistant" }>,
  mode: ClaudeResearchAgentInput["mode"],
  textParts: string[],
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>
) {
  for (const block of message.message.content) {
    const type = typeof block === "object" && block && "type" in block ? block.type : null;
    const text = getBlockText(block);

    if (type === "text" && text !== null) {
      textParts.push(text);
      if (!looksLikeFinalResponse(text, mode)) {
        emitProgress(onProgress, { role: "agent", message: text });
      }
      continue;
    }

    if (type === "thinking" && block && typeof block === "object" && "thinking" in block) {
      const thinking = (block as { thinking?: unknown }).thinking;
      if (typeof thinking === "string") {
        emitProgress(onProgress, { role: "agent", message: thinking });
      }
      continue;
    }

    if (
      (type === "tool_use" || type === "server_tool_use") &&
      block &&
      typeof block === "object" &&
      "name" in block
    ) {
      const toolBlock = block as { name?: unknown; input?: unknown };
      const name = typeof toolBlock.name === "string" ? toolBlock.name : "Tool";
      emitProgress(onProgress, { role: "tool", message: `${name}: ${toolInputSummary(name, toolBlock.input)}` });
      continue;
    }

    if (
      (type === "advisor_tool_result" ||
        type === "web_search_tool_result" ||
        type === "web_fetch_tool_result" ||
        type === "code_execution_tool_result") &&
      block &&
      typeof block === "object" &&
      "content" in block
    ) {
      emitProgress(onProgress, {
        role: "tool_result",
        message: compactValue((block as { content?: unknown }).content)
      });
    }
  }
}

function handleProgressMessage(
  message: SDKMessage,
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>
) {
  if (message.type === "system" && message.subtype === "task_started") {
    emitProgress(onProgress, {
      role: "system",
      message: message.description || "Started a background task."
    });
    return;
  }

  if (message.type === "system" && message.subtype === "task_progress") {
    emitProgress(onProgress, {
      role: message.last_tool_name ? "tool" : "agent",
      message: message.last_tool_name
        ? `Using ${message.last_tool_name}.`
        : message.summary || message.description
    });
    return;
  }

  if (message.type === "tool_progress") {
    emitProgress(onProgress, {
      role: "tool",
      message: `Using ${message.tool_name}.`
    });
    return;
  }

  if (message.type === "tool_use_summary") {
    emitProgress(onProgress, {
      role: "tool_result",
      message: message.summary
    });
    return;
  }

  if (message.type === "user") {
    const toolUseResult = "tool_use_result" in message ? message.tool_use_result : null;
    if (toolUseResult !== undefined && toolUseResult !== null) {
      emitProgress(onProgress, { role: "tool_result", message: compactValue(toolUseResult) });
    } else if (message.parent_tool_use_id) {
      emitProgress(onProgress, { role: "tool_result", message: compactValue(message.message.content) });
    }
  }
}

export async function runClaudeResearchAgent(
  input: ClaudeResearchAgentInput,
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>
): Promise<ClaudeResearchAgentOutput> {
  const model = process.env.CLAUDE_AGENT_MODEL || "sonnet";
  const cwd = input.workspacePath || process.cwd();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_AGENT_TIMEOUT_MS);

  const agentQuery = query({
    prompt: buildUserPrompt(input),
    options: {
      cwd,
      systemPrompt: buildSystemPrompt(input),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: CLAUDE_AGENT_TOOLS,
      maxTurns: Number.parseInt(process.env.CLAUDE_AGENT_MAX_TURNS || "12", 10),
      model,
      abortController
    }
  });

  emitProgress(onProgress, { role: "system", message: "Starting Claude research agent." });

  const textParts: string[] = [];
  let resultText = "";
  let errors: string[] = [];

  try {
    for await (const message of agentQuery) {
      if (message.type === "assistant") {
        handleAssistantMessage(message, input.mode, textParts, onProgress);
      } else if (message.type === "result") {
        if (!message.is_error && "result" in message && typeof message.result === "string") {
          resultText = message.result;
        }
        if (message.is_error) {
          errors = "errors" in message ? message.errors : ["Claude research agent failed."];
        }
      } else {
        handleProgressMessage(message, onProgress);
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error("Claude research agent timed out after 600 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    agentQuery.close();
  }

  if (errors.length) {
    errors.forEach((message) => emitProgress(onProgress, { role: "error", message }));
    throw new Error(errors.join("\n"));
  }

  emitProgress(onProgress, { role: "system", message: "Preparing document update." });
  const finalText = chooseFinalText(resultText, textParts);
  const parsed = parseClaudeAgentOutput(finalText, input.mode);
  parsed.model = `claude-agent-sdk:${model}`;
  parsed.images ??= [];
  parsed.widgets ??= [];
  return parsed;
}
