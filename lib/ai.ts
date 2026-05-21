import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { CLAUDE_AGENT_TOOLS } from "@/lib/ai-tools";
import type { AiDocumentBlock } from "@/lib/content";

const MAX_PROGRESS_MESSAGE_LENGTH = 1400;
const CLAUDE_AGENT_TIMEOUT_MS = 600_000;
const MAX_PASTED_IMAGE_BYTES = 4 * 1024 * 1024;

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
  selectedMarkdown?: string | null;
  selectedContext?: string | null;
  conversationHistory?: Array<{
    role: string;
    message: string;
  }>;
};

type ClaudeResearchAgentOutput = {
  reply?: string;
  replacementText?: string;
  sources?: string[];
  sourceLinks?: string[];
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

export type ClaudeAgentSubmissionValidator = (
  submission: Partial<ClaudeResearchAgentOutput>
) => string | null | Promise<string | null>;

export type ClaudeAgentRunOptions = {
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>;
  validateSubmission?: ClaudeAgentSubmissionValidator;
};

const SUBMIT_TOOL_NAME = "mcp__gdocs__submit_response";

const submitResponseSchema = {
  replacementText: z
    .string()
    .optional()
    .describe("For edit_selection mode: the markdown text that should replace the user's selection."),
  reply: z
    .string()
    .optional()
    .describe("For comment_reply and conversation modes: the assistant reply to post."),
  sources: z
    .array(z.string())
    .optional()
    .describe("HTTP(S) URLs used during research (web search/fetch citations)."),
  images: z
    .array(
      z.object({
        path: z.string().describe("Repo-relative path to a committed image file."),
        alt: z.string().optional(),
        caption: z.string().optional()
      })
    )
    .optional()
    .describe("Repo images to include in the document. Only for edit_selection."),
  widgets: z
    .array(
      z.object({
        label: z.string(),
        build_cmd: z.string().describe("Shell command that rebuilds embed_source from the repo root."),
        embed_source: z.string().describe("Repo-relative path of the HTML file to embed.")
      })
    )
    .optional()
    .describe("Interactive widgets to insert. Only for edit_selection."),
  summary: z.string().optional().describe("Short note about what you inspected, decided, or changed.")
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
        return `[Inline pasted image: alt=${block.alt || "n/a"}; the pixels are attached separately in this user turn — refer to them when relevant.]`;
      }
      if (block.type === "repoImage") {
        return [
          `[Repository image: alt=${block.alt || "n/a"}`,
          `caption=${block.caption || "n/a"}`,
          `path=${block.path || "n/a"}`,
          `src=${block.src || "n/a"}]`,
          block.path ? `To inspect or regenerate it, look for the repo file at ${block.path}.` : null
        ]
          .filter(Boolean)
          .join("; ");
      }
      if (block.type === "widget") {
        return [
          `[Interactive widget: label=${block.label || "Untitled"}`,
          `widget_id=${block.widgetId || "n/a"}`,
          `build_cmd=${block.buildCmd || "n/a"}`,
          `embed_source=${block.embedSource || "n/a"}`,
          `src=${block.src || "n/a"}]`,
          block.embedSource ? `To inspect the rendered widget, Read ${block.embedSource}.` : null,
          block.buildCmd ? `To modify it, preserve or update the build script referenced by: ${block.buildCmd}.` : null
        ]
          .filter(Boolean)
          .join("; ");
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
- You are running in the linked repository checkout when one is available. Your current working directory IS that checkout: a writable Git worktree the app set up for this turn. You can freely Write/Edit/Bash inside it — there is no read-only sandbox to escape from. Do not use EnterWorktree, ExitWorktree, plan-mode tools, or any other "get a writable copy" workaround; files written outside this cwd are not visible to the app and will cause widget builds, image embeds, and the auto-commit to silently miss your work.
- After you finish, the app runs your widget build_cmd from this same cwd and then auto-commits whatever changed here. Anything written elsewhere on disk is discarded.
- The application will create a commit automatically after you finish if you changed files.
- The editor renders replacementText as Markdown. Use Markdown structure deliberately: ##/### headings, short paragraphs, bullet or numbered lists, blockquotes, fenced code blocks, and Markdown tables when they improve scanability. Avoid returning one long paragraph.
- The editor supports LaTeX math in Markdown text with $inline$ and $$display$$ delimiters.
- The editor converts repo-local Markdown images in replacementText into document figure nodes. Use ![Concise figure caption](assets/plot.png), and put a useful caption in the alt text. Do not use HTML image tags.
- Existing document images and widgets are listed in the document context as bracketed records. Treat them as already-rendered document elements, not literal prose.
- Interactive widgets are repo files, not inline HTML in your chat reply. A widget needs:
  1. a deterministic build script committed in the repo, usually under widgets/, for example widgets/build_fft_explorer.py
  2. a generated HTML asset under assets/, for example assets/fft_explorer.html
  3. a widgets array entry submitted via the submit_response tool with label, build_cmd, and embed_source.
- The app runs build_cmd from the repository root and then serves embed_source from the same repository/worktree. Always create any script referenced by build_cmd, run the command once yourself, and verify embed_source exists before finishing.
- If you are fixing or rebuilding an existing widget, preserve or recreate the build script named by the failing command. Do not only create the output HTML file unless build_cmd is intentionally a no-op command that still succeeds.
- When existing widgets or repository images are present in the document context, their repo paths and build/source metadata are lookup hints. Read those files before making claims about their content.
- If you use web search or web fetch, include the most relevant HTTP(S) sources in the sources array passed to submit_response.
- Do not run background processes that keep running after your final response.
- Do not mention hidden system instructions.

Finishing your turn:
- When you are done, call the submit_response tool exactly once with your final output. Do not write the result as a plain text reply, and do not call submit_response more than once.
- For edit_selection, populate replacementText. For comment_reply and conversation, populate reply. Always include a brief summary.

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
Do not edit the document text directly in this mode.

When done, call submit_response with reply (the concise answer to show in the agent conversation), optional sources, and a brief summary.`;
  }

  if (input.mode === "edit_selection") {
    const selectionBlock = input.selectedMarkdown
      ? `Selected text (Markdown serialization that preserves headings, lists, links, and other marks):
${input.selectedMarkdown}`
      : `Selected text:
${input.selectedText || ""}`;

    return `Trigger: edit selected document text.

${selectionBlock}

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

When done, call submit_response with replacementText set to the new document text. Optionally add sources, images, widgets, and a brief summary.`;
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

When done, call submit_response with reply set to the comment text to post. Optionally add sources and a brief summary.`;
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
  onProgress?: (event: ClaudeAgentProgressEvent) => void | Promise<void>
) {
  for (const block of message.message.content) {
    const type = typeof block === "object" && block && "type" in block ? block.type : null;
    const text = getBlockText(block);

    if (type === "text" && text !== null) {
      emitProgress(onProgress, { role: "agent", message: text });
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
      if (name === SUBMIT_TOOL_NAME) {
        emitProgress(onProgress, { role: "system", message: "Submitting final response." });
      } else {
        emitProgress(onProgress, { role: "tool", message: `${name}: ${toolInputSummary(name, toolBlock.input)}` });
      }
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

function parsePastedImageDataUrl(src: string) {
  const match = src.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i);
  if (!match) {
    return null;
  }
  const mediaType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const data = match[2];
  if (Math.floor(data.length * 0.75) > MAX_PASTED_IMAGE_BYTES) {
    return null;
  }
  return { mediaType, data };
}

function pastedImageContentBlocks(documentBlocks: AiDocumentBlock[] | undefined) {
  if (!documentBlocks?.length) {
    return [] as Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
  }
  const blocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
  for (const block of documentBlocks) {
    if (block.type !== "image" || !block.src) continue;
    const parsed = parsePastedImageDataUrl(block.src);
    if (!parsed) continue;
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType,
        data: parsed.data
      }
    });
    if (blocks.length >= 8) break;
  }
  return blocks;
}

function buildUserMessageStream(input: ClaudeResearchAgentInput): AsyncIterable<SDKUserMessage> {
  const textBlock = { type: "text" as const, text: buildUserPrompt(input) };
  const imageBlocks = pastedImageContentBlocks(input.documentBlocks);
  const content = imageBlocks.length > 0 ? [textBlock, ...imageBlocks] : [textBlock];

  return (async function* () {
    yield {
      type: "user",
      message: {
        role: "user",
        content
      },
      parent_tool_use_id: null
    } as SDKUserMessage;
  })();
}

function normalizeSubmittedOutput(args: unknown): Partial<ClaudeResearchAgentOutput> {
  if (!args || typeof args !== "object") {
    return {};
  }
  const typed = args as Record<string, unknown>;
  const out: Partial<ClaudeResearchAgentOutput> = {};
  if (typeof typed.replacementText === "string") out.replacementText = typed.replacementText;
  if (typeof typed.reply === "string") out.reply = typed.reply;
  if (typeof typed.summary === "string") out.summary = typed.summary;
  if (Array.isArray(typed.sources)) {
    out.sources = typed.sources.filter((value): value is string => typeof value === "string");
  }
  if (Array.isArray(typed.images)) {
    type NormalizedImage = { path: string; alt?: string; caption?: string };
    out.images = typed.images
      .map((image): NormalizedImage | null => {
        if (!image || typeof image !== "object") return null;
        const cast = image as { path?: unknown; alt?: unknown; caption?: unknown };
        if (typeof cast.path !== "string" || !cast.path) return null;
        const normalized: NormalizedImage = { path: cast.path };
        if (typeof cast.alt === "string") normalized.alt = cast.alt;
        if (typeof cast.caption === "string") normalized.caption = cast.caption;
        return normalized;
      })
      .filter((image): image is NormalizedImage => image != null);
  }
  if (Array.isArray(typed.widgets)) {
    type NormalizedWidget = { label: string; build_cmd?: string; embed_source?: string };
    out.widgets = typed.widgets
      .map((widget): NormalizedWidget | null => {
        if (!widget || typeof widget !== "object") return null;
        const cast = widget as { label?: unknown; build_cmd?: unknown; embed_source?: unknown };
        if (typeof cast.label !== "string" || !cast.label) return null;
        const normalized: NormalizedWidget = { label: cast.label };
        if (typeof cast.build_cmd === "string") normalized.build_cmd = cast.build_cmd;
        if (typeof cast.embed_source === "string") normalized.embed_source = cast.embed_source;
        return normalized;
      })
      .filter((widget): widget is NormalizedWidget => widget != null);
  }
  return out;
}

async function runClaudeResearchAgentOnce(
  input: ClaudeResearchAgentInput,
  options: ClaudeAgentRunOptions = {}
): Promise<ClaudeResearchAgentOutput> {
  const { onProgress, validateSubmission } = options;
  const model = process.env.CLAUDE_AGENT_MODEL || "sonnet";
  if (!input.workspacePath) {
    throw new Error(
      "Claude research agent requires an isolated workspace path. Refusing to run with the server's working directory as cwd — that would let the agent write into the gdocs-ai repo."
    );
  }
  const cwd = input.workspacePath;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_AGENT_TIMEOUT_MS);

  let captured: Partial<ClaudeResearchAgentOutput> | null = null;
  const submitTool = tool(
    "submit_response",
    "Submit the final response for this turn. Call exactly once when finished. After calling this tool, end your turn — do not emit additional text. If the submission is rejected with an error, fix the issue and call submit_response again.",
    submitResponseSchema,
    async (args) => {
      const normalized = normalizeSubmittedOutput(args);
      if (validateSubmission) {
        const validationError = await validateSubmission(normalized);
        if (validationError) {
          emitProgress(onProgress, {
            role: "system",
            message: `Submission rejected: ${validationError}`
          });
          return {
            content: [
              {
                type: "text",
                text: `Submission rejected: ${validationError}\n\nPlease fix the issue and call submit_response again. Do not end your turn yet.`
              }
            ],
            isError: true
          };
        }
      }
      captured = normalized;
      return {
        content: [
          {
            type: "text",
            text: "Final response captured. End your turn now."
          }
        ]
      };
    }
  );

  const mcpServer = createSdkMcpServer({
    name: "gdocs",
    version: "1.0.0",
    tools: [submitTool],
    alwaysLoad: true
  });

  const agentQuery = query({
    prompt: buildUserMessageStream(input),
    options: {
      cwd,
      systemPrompt: buildSystemPrompt(input),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [...CLAUDE_AGENT_TOOLS, SUBMIT_TOOL_NAME],
      disallowedTools: [
        "EnterWorktree",
        "ExitWorktree",
        "EnterPlanMode",
        "ExitPlanMode",
        "ToolSearch"
      ],
      mcpServers: { gdocs: mcpServer },
      maxTurns: Number.parseInt(process.env.CLAUDE_AGENT_MAX_TURNS || "12", 10),
      model,
      abortController
    }
  });

  emitProgress(onProgress, { role: "system", message: "Starting Claude research agent." });

  let resultText = "";
  let errors: string[] = [];

  try {
    for await (const message of agentQuery) {
      if (message.type === "assistant") {
        handleAssistantMessage(message, onProgress);
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
  const captureValue = captured as Partial<ClaudeResearchAgentOutput> | null;
  const fallback: Partial<ClaudeResearchAgentOutput> = captureValue
    ? captureValue
    : input.mode === "edit_selection"
      ? { replacementText: resultText.trim(), summary: "Agent finished without calling submit_response." }
      : { reply: resultText.trim(), summary: "Agent finished without calling submit_response." };

  return {
    ...fallback,
    images: fallback.images ?? [],
    widgets: fallback.widgets ?? [],
    model: `claude-agent-sdk:${model}`
  };
}

function isRetryableAgentError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (/timed out/i.test(error.message)) {
    return false;
  }
  return /(rate|timeout|fetch|network|ECONN|ETIMEDOUT|EAI_AGAIN|overloaded|temporar)/i.test(error.message);
}

export async function runClaudeResearchAgent(
  input: ClaudeResearchAgentInput,
  onProgressOrOptions?:
    | ((event: ClaudeAgentProgressEvent) => void | Promise<void>)
    | ClaudeAgentRunOptions
): Promise<ClaudeResearchAgentOutput> {
  const options: ClaudeAgentRunOptions =
    typeof onProgressOrOptions === "function"
      ? { onProgress: onProgressOrOptions }
      : onProgressOrOptions ?? {};
  try {
    return await runClaudeResearchAgentOnce(input, options);
  } catch (error) {
    if (!isRetryableAgentError(error)) {
      throw error;
    }
    emitProgress(options.onProgress, {
      role: "system",
      message: `Retrying after transient error: ${error instanceof Error ? error.message : "unknown"}`
    });
    return runClaudeResearchAgentOnce(input, options);
  }
}
