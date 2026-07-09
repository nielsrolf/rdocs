import { z } from "zod";

import { embedSourceExists } from "@/agent-core/ai-edit-submission";
import { broadcastDocumentEvent } from "@/lib/collaboration";
import {
  defaultDocumentContent,
  getContextAroundMatch,
  getDocumentMarkdown,
  getDocumentPlainText,
  parseDocumentContent,
  serializeDocumentContent
} from "@/lib/content";
import { db } from "@/lib/db";
import { serializeComment, serializeThread } from "@/lib/document-data";
import { copyOwnerDefaultSkillsToDocument } from "@/lib/document-skills";
import { applyMarkdownEdit, McpEditError } from "@/lib/mcp/apply-edit";
import { widgetSourceUrl } from "@/lib/mcp/markdown-doc";
import { commitFilesToWorkspace, McpFileError, type UploadedFile } from "@/lib/mcp/workspace-files";
import { canComment, canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { ensureLinkedRepository, runWidgetBuild } from "@/lib/research-workspace";

export type McpUser = { id: string; email: string; name: string };
export type McpToolContext = { user: McpUser; origin: string };

export class McpToolError extends Error {}

// ---------------------------------------------------------------------------
// Shared input pieces

const documentRef = z
  .string()
  .min(1)
  .describe("Document id, or a document URL like https://…/documents/<id>.");

const MARKDOWN_CONTRACT = [
  "Markdown supports headings, GFM tables, task lists, code blocks and links; a single newline renders as a hard line break.",
  "Images: reference files committed to the document workspace as ![alt](path/in/repo.png) — upload them with upload_files first.",
  "Interactive widgets: insert the placeholder ![widget: <label>](widget://<widget_id>) on its own line — create the widget with create_widget first, or reuse a widget id from read_document."
].join(" ");

function parseDocumentRef(ref: string): string {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/\/documents\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{10,40}$/.test(trimmed)) return trimmed;
  throw new McpToolError(`"${ref}" is not a document id or document URL.`);
}

async function requireAccess(ref: string, userId: string, level: "view" | "comment" | "edit") {
  const documentId = parseDocumentRef(ref);
  const access = await resolveDocumentAccess(documentId, userId, null);
  if (!access) {
    throw new McpToolError("Document not found or you do not have access to it.");
  }
  if (level === "edit" && !canEdit(access.permission)) {
    throw new McpToolError("You do not have edit access to this document.");
  }
  if (level === "comment" && !canComment(access.permission)) {
    throw new McpToolError("You do not have comment access to this document.");
  }
  return { documentId, access };
}

const THREAD_SELECT = {
  id: true,
  anchorText: true,
  anchorContext: true,
  status: true,
  tags: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  comments: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      body: true,
      aiModel: true,
      guestName: true,
      sourceLinks: true,
      commitSha: true,
      commitUrl: true,
      aiRunId: true,
      createdAt: true,
      author: { select: { id: true, name: true } }
    }
  }
} as const;

// ---------------------------------------------------------------------------
// Tool registry

export type McpTool<Args = unknown> = {
  name: string;
  description: string;
  schema: z.ZodType<Args>;
  handler: (args: Args, ctx: McpToolContext) => Promise<unknown>;
};

function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>, ctx: McpToolContext) => Promise<unknown>;
}): McpTool {
  return tool as unknown as McpTool;
}

const listDocuments = defineTool({
  name: "list_documents",
  description: "List the documents you own or that are shared with you (most recently updated first).",
  schema: z.object({}).strict(),
  handler: async (_args, ctx) => {
    const [owned, memberships] = await Promise.all([
      db.document.findMany({
        where: { ownerId: ctx.user.id },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, title: true, updatedAt: true }
      }),
      db.documentMembership.findMany({
        where: { userId: ctx.user.id },
        orderBy: { document: { updatedAt: "desc" } },
        take: 50,
        select: {
          permission: true,
          document: { select: { id: true, title: true, updatedAt: true } }
        }
      })
    ]);
    return {
      documents: [
        ...owned.map((doc) => ({ ...doc, role: "owner" as string })),
        ...memberships.map((m) => ({ ...m.document, role: m.permission.toLowerCase() }))
      ]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          updated_at: doc.updatedAt.toISOString(),
          role: doc.role,
          url: `${ctx.origin}/documents/${doc.id}`
        }))
    };
  }
});

const readDocument = defineTool({
  name: "read_document",
  description:
    "Read a document as markdown. Existing interactive widgets appear as ![widget: <label>](widget://<widget_id>) placeholders and images as workspace paths — echo them verbatim to keep them when editing. Also returns the document's widgets and open comment threads.",
  schema: z.object({ document: documentRef }).strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "view");
    const document = await db.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { id: true, title: true, content: true, repoUrl: true, repoBranch: true, updatedAt: true }
    });
    const [widgets, threads] = await Promise.all([
      db.embeddedWidget.findMany({
        where: { documentId },
        select: { id: true, label: true, buildCmd: true, embedSource: true, lastBuiltAt: true, lastError: true }
      }),
      db.commentThread.findMany({
        where: { documentId, status: "OPEN" },
        orderBy: { createdAt: "asc" },
        select: THREAD_SELECT
      })
    ]);
    const content = parseDocumentContent(document.content);
    return {
      id: document.id,
      title: document.title,
      url: `${ctx.origin}/documents/${document.id}`,
      repo: document.repoUrl ? { url: document.repoUrl, branch: document.repoBranch } : null,
      updated_at: document.updatedAt.toISOString(),
      markdown: getDocumentMarkdown(content),
      widgets: widgets.map((widget) => ({
        widget_id: widget.id,
        label: widget.label,
        build_cmd: widget.buildCmd,
        embed_source: widget.embedSource,
        placeholder: `![widget: ${widget.label}](widget://${widget.id})`,
        last_built_at: widget.lastBuiltAt?.toISOString() ?? null,
        last_error: widget.lastError
      })),
      open_comment_threads: threads.map((thread) => serializeThread(thread))
    };
  }
});

const replaceInDocument = defineTool({
  name: "replace_in_document",
  description:
    `Replace one passage of a document. find_text must be copied EXACTLY from read_document's markdown/text and must match exactly one place (include surrounding context to disambiguate). The replacement markdown is inserted in its place. ${MARKDOWN_CONTRACT} Live collaborators see the change immediately.`,
  schema: z
    .object({
      document: documentRef,
      find_text: z.string().min(1).max(20_000).describe("Exact, unique text currently in the document."),
      replacement_markdown: z.string().max(200_000).describe("Markdown that replaces find_text.")
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "edit");
    const { version } = await applyMarkdownEdit({
      documentId,
      userId: ctx.user.id,
      mode: "replace",
      markdown: args.replacement_markdown,
      findText: args.find_text
    });
    return { ok: true, document_version: version };
  }
});

const appendToDocument = defineTool({
  name: "append_to_document",
  description: `Append markdown at the end of a document. ${MARKDOWN_CONTRACT}`,
  schema: z
    .object({
      document: documentRef,
      markdown: z.string().min(1).max(200_000)
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "edit");
    const { version } = await applyMarkdownEdit({
      documentId,
      userId: ctx.user.id,
      mode: "append",
      markdown: args.markdown
    });
    return { ok: true, document_version: version };
  }
});

const replaceDocument = defineTool({
  name: "replace_document",
  description:
    `Replace a document's ENTIRE content with new markdown. Destructive: existing content, comment anchors and inline widgets are all replaced (prior state stays in version history). Prefer replace_in_document for targeted edits. ${MARKDOWN_CONTRACT}`,
  schema: z
    .object({
      document: documentRef,
      markdown: z.string().max(400_000)
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "edit");
    const { version } = await applyMarkdownEdit({
      documentId,
      userId: ctx.user.id,
      mode: "replace_all",
      markdown: args.markdown
    });
    return { ok: true, document_version: version };
  }
});

const createDocument = defineTool({
  name: "create_document",
  description: `Create a new document you own, optionally with initial markdown content. ${MARKDOWN_CONTRACT}`,
  schema: z
    .object({
      title: z.string().min(1).max(300),
      markdown: z.string().max(400_000).optional()
    })
    .strict(),
  handler: async (args, ctx) => {
    const document = await db.document.create({
      data: {
        title: args.title.trim(),
        content: serializeDocumentContent(defaultDocumentContent),
        ownerId: ctx.user.id
      },
      select: { id: true }
    });
    await copyOwnerDefaultSkillsToDocument(ctx.user.id, document.id);
    if (args.markdown?.trim()) {
      await applyMarkdownEdit({
        documentId: document.id,
        userId: ctx.user.id,
        mode: "replace_all",
        markdown: args.markdown
      });
    }
    return { id: document.id, url: `${ctx.origin}/documents/${document.id}` };
  }
});

const uploadFiles = defineTool({
  name: "upload_files",
  description:
    "Upload files into the document's workspace repository (git-committed on the server). Required before referencing local artifacts in the document: images referenced as ![alt](path.png) and widget build scripts/HTML must exist in the workspace to render. Binary files go in content_base64, text files in content.",
  schema: z
    .object({
      document: documentRef,
      files: z
        .array(
          z
            .object({
              path: z.string().min(1).max(500).describe("Repo-relative path, e.g. assets/loss.png"),
              content: z.string().max(2_000_000).optional().describe("UTF-8 text content."),
              content_base64: z.string().max(12_000_000).optional().describe("Base64 bytes for binary files.")
            })
            .strict()
        )
        .min(1)
        .max(32),
      message: z.string().max(300).optional().describe("Git commit message.")
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "edit");
    const files: UploadedFile[] = args.files.map((file) => ({
      path: file.path,
      content: file.content,
      contentBase64: file.content_base64
    }));
    const result = await commitFilesToWorkspace({
      documentId,
      files,
      message: args.message?.trim() || `MCP upload by ${ctx.user.name}`,
      userId: ctx.user.id
    });
    return {
      ok: true,
      commit_sha: result.commitSha,
      paths: result.paths,
      note: "Reference uploaded images in document markdown as ![alt](<path>)."
    };
  }
});

const createWidget = defineTool({
  name: "create_widget",
  description:
    "Register an interactive widget (self-contained HTML rendered in a sandboxed iframe) for a document. Upload the build script and the generated HTML via the files parameter (or upload_files beforehand). embed_source is the workspace path of the HTML artifact; build_cmd regenerates it (python/node/bash script inside the workspace). Returns the placeholder to insert into the document with replace_in_document/append_to_document.",
  schema: z
    .object({
      document: documentRef,
      label: z.string().min(1).max(120),
      build_cmd: z.string().min(1).max(1000).describe('e.g. "python widgets/build_fft.py"'),
      embed_source: z.string().min(1).max(500).describe("Workspace path of the built HTML, e.g. assets/fft.html"),
      files: z
        .array(
          z
            .object({
              path: z.string().min(1).max(500),
              content: z.string().max(2_000_000).optional(),
              content_base64: z.string().max(12_000_000).optional()
            })
            .strict()
        )
        .max(32)
        .optional()
        .describe("Files to upload first (build script, prebuilt HTML, data)."),
      run_build: z
        .boolean()
        .optional()
        .describe("Run build_cmd on the server after uploading (default: only if embed_source is missing).")
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "edit");

    let workspace: string;
    if (args.files && args.files.length > 0) {
      const uploaded = await commitFilesToWorkspace({
        documentId,
        files: args.files.map((file) => ({
          path: file.path,
          content: file.content,
          contentBase64: file.content_base64
        })),
        message: `Add widget "${args.label}" (MCP upload by ${ctx.user.name})`,
        userId: ctx.user.id
      });
      workspace = uploaded.linked.workspace;
    } else {
      const linked = await ensureLinkedRepository(documentId, {
        requireClean: false,
        runnerUserId: ctx.user.id
      });
      if (!linked) throw new McpToolError("Document workspace is unavailable.");
      workspace = linked.workspace;
    }

    let lastBuiltAt: Date | null = null;
    let lastError: string | null = null;
    const artifactExists = await embedSourceExists(workspace, args.embed_source);
    const shouldBuild = args.run_build ?? !artifactExists;
    if (shouldBuild) {
      const buildResult = await runWidgetBuild(args.build_cmd, workspace);
      if (buildResult.ok) {
        lastBuiltAt = new Date();
      } else {
        lastError = buildResult.error.slice(0, 6000);
      }
    }

    if (!(await embedSourceExists(workspace, args.embed_source))) {
      throw new McpToolError(
        `embed_source "${args.embed_source}" does not exist in the workspace${
          lastError ? ` and the build failed: ${lastError}` : " — upload it or fix build_cmd"
        }.`
      );
    }

    const widget = await db.embeddedWidget.create({
      data: {
        documentId,
        label: args.label,
        buildCmd: args.build_cmd,
        embedSource: args.embed_source,
        workspacePath: workspace,
        lastBuiltAt,
        lastError
      },
      select: { id: true, label: true }
    });

    return {
      widget_id: widget.id,
      placeholder: `![widget: ${widget.label}](widget://${widget.id})`,
      source_url: `${ctx.origin}${widgetSourceUrl(documentId, widget.id)}`,
      build_error: lastError,
      note: "Insert the placeholder into the document (its own paragraph) via replace_in_document or append_to_document."
    };
  }
});

const listComments = defineTool({
  name: "list_comments",
  description: "List a document's comment threads (anchored to document text), including resolved ones.",
  schema: z
    .object({
      document: documentRef,
      status: z.enum(["OPEN", "RESOLVED", "ALL"]).optional().describe("Filter by thread status (default ALL).")
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "view");
    const status = args.status ?? "ALL";
    const threads = await db.commentThread.findMany({
      where: { documentId, ...(status === "ALL" ? {} : { status }) },
      orderBy: { createdAt: "asc" },
      select: THREAD_SELECT
    });
    return { threads: threads.map((thread) => serializeThread(thread)) };
  }
});

const addComment = defineTool({
  name: "add_comment",
  description:
    "Start a new comment thread anchored to text in the document. find_text must be copied exactly from the document. The comment is authored as you.",
  schema: z
    .object({
      document: documentRef,
      find_text: z.string().min(1).max(1000).describe("Exact document text to anchor the comment to."),
      body: z.string().min(1).max(20_000)
    })
    .strict(),
  handler: async (args, ctx) => {
    const { documentId } = await requireAccess(args.document, ctx.user.id, "comment");
    const document = await db.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { content: true }
    });
    const documentText = getDocumentPlainText(parseDocumentContent(document.content));
    const anchorContext = getContextAroundMatch(documentText, args.find_text);
    if (!anchorContext) {
      throw new McpToolError(
        "find_text was not found in the document — copy the anchor text exactly from read_document."
      );
    }
    const thread = await db.commentThread.create({
      data: {
        documentId,
        createdById: ctx.user.id,
        anchorText: args.find_text.slice(0, 1000),
        anchorContext: anchorContext.slice(0, 2000),
        comments: {
          create: { body: args.body, authorId: ctx.user.id }
        }
      },
      select: THREAD_SELECT
    });
    broadcastDocumentEvent(documentId, "thread-created", {
      thread: serializeThread(thread),
      updatedAt: null
    });
    return { thread_id: thread.id };
  }
});

const replyToComment = defineTool({
  name: "reply_to_comment",
  description: "Reply to an existing comment thread (thread ids come from read_document or list_comments).",
  schema: z
    .object({
      thread_id: z.string().min(1),
      body: z.string().min(1).max(20_000)
    })
    .strict(),
  handler: async (args, ctx) => {
    const thread = await db.commentThread.findUnique({
      where: { id: args.thread_id },
      select: { id: true, documentId: true }
    });
    if (!thread) throw new McpToolError("Comment thread not found.");
    await requireAccess(thread.documentId, ctx.user.id, "comment");

    const comment = await db.comment.create({
      data: { threadId: thread.id, authorId: ctx.user.id, body: args.body },
      select: {
        id: true,
        body: true,
        aiModel: true,
        guestName: true,
        sourceLinks: true,
        commitSha: true,
        commitUrl: true,
        aiRunId: true,
        createdAt: true,
        author: { select: { id: true, name: true } }
      }
    });
    await db.commentThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    broadcastDocumentEvent(thread.documentId, "comment-created", {
      threadId: thread.id,
      comment: serializeComment(comment)
    });
    return { comment_id: comment.id };
  }
});

export const MCP_TOOLS: McpTool[] = [
  listDocuments,
  readDocument,
  replaceInDocument,
  appendToDocument,
  replaceDocument,
  createDocument,
  uploadFiles,
  createWidget,
  listComments,
  addComment,
  replyToComment
];

export function getMcpTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

export async function callMcpTool(name: string, args: unknown, ctx: McpToolContext) {
  const tool = getMcpTool(name);
  if (!tool) {
    throw new McpToolError(`Unknown tool: ${name}`);
  }
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new McpToolError(`Invalid arguments for ${name}: ${parsed.error.message}`);
  }
  try {
    return await tool.handler(parsed.data, ctx);
  } catch (error) {
    if (error instanceof McpToolError || error instanceof McpEditError || error instanceof McpFileError) {
      throw error;
    }
    console.error(`[mcp] tool ${name} failed`, {
      user: ctx.user.id,
      error: error instanceof Error ? error.message : error
    });
    throw new McpToolError(error instanceof Error ? error.message : "Tool execution failed.");
  }
}
