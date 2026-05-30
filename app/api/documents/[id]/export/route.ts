import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getDocumentMarkdown, parseDocumentContent } from "@/lib/content";
import { collectDocumentImages, documentToLatex, type DocumentImageRef } from "@/lib/latex-export";
import { resolveDocumentAccess } from "@/lib/permissions";
import { ensureLinkedRepository } from "@/lib/research-workspace";
import { db } from "@/lib/db";
import { createZip, type ZipEntry } from "@/lib/zip";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "document"
  );
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/webp": ".webp"
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 50;

function extensionFor(value: string, fallback = ".png"): string {
  const ext = path.extname(value.split("?")[0]).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : fallback;
}

function readWorkspaceFile(workspace: string, relativePath: string) {
  const resolved = path.resolve(workspace, relativePath);
  const root = path.resolve(workspace);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    return Promise.resolve(null);
  }
  return fs.readFile(resolved).catch(() => null);
}

async function resolveDataUrl(value: string): Promise<{ bytes: Buffer; ext: string } | null> {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  const mime = match[1] ?? "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { bytes, ext: MIME_EXTENSIONS[mime] ?? ".png" };
}

async function resolveHttpUrl(value: string): Promise<{ bytes: Buffer; ext: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(value, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    const mimeExt = MIME_EXTENSIONS[(response.headers.get("content-type") ?? "").split(";")[0].trim()];
    return { bytes: buf, ext: mimeExt ?? extensionFor(value) };
  } catch {
    return null;
  }
}

// Read a repo-relative image from the document's linked workspace, falling back
// to recent successful AI-run worktrees (mirrors the repo-files route).
async function resolveRepoImage(
  documentId: string,
  relativePath: string,
  baseWorkspace: string | null
): Promise<{ bytes: Buffer; ext: string } | null> {
  const candidates: string[] = [];
  if (baseWorkspace) candidates.push(baseWorkspace);
  const runs = await db.aiRun.findMany({
    where: { documentId, status: "SUCCEEDED", workspacePath: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: 20,
    select: { workspacePath: true }
  });
  for (const run of runs) {
    if (run.workspacePath) candidates.push(run.workspacePath);
  }
  for (const workspace of candidates) {
    const bytes = await readWorkspaceFile(workspace, relativePath);
    if (bytes && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) {
      return { bytes, ext: extensionFor(relativePath) };
    }
  }
  return null;
}

async function buildLatexZip(input: {
  documentId: string;
  title: string;
  content: unknown;
}): Promise<Buffer> {
  const refs = collectDocumentImages(input.content).slice(0, MAX_IMAGES);

  // The document's linked repo workspace, resolved once (only if there are repo images).
  let baseWorkspace: string | null = null;
  if (refs.some((ref) => ref.kind === "repoImage")) {
    const linked = await ensureLinkedRepository(input.documentId, { requireClean: false }).catch(() => null);
    baseWorkspace = linked?.workspace ?? null;
  }

  const imagePaths = new Map<string, string>();
  const imageEntries: ZipEntry[] = [];
  let index = 0;
  for (const ref of refs) {
    const resolved = await resolveImage(input.documentId, ref, baseWorkspace);
    if (!resolved) continue;
    index += 1;
    const name = `images/fig-${index}${resolved.ext}`;
    imagePaths.set(ref.key, name);
    imageEntries.push({ name, data: resolved.bytes });
  }

  const tex = documentToLatex(input.content, { title: input.title, imagePaths });
  const readme =
    "Overleaf export\n" +
    "================\n\n" +
    "Upload this whole .zip to Overleaf (New Project -> Upload Project) and\n" +
    "compile main.tex. Images are bundled under images/. Interactive widgets and\n" +
    "any images that could not be fetched are rendered as placeholders.\n";

  return createZip([
    { name: "main.tex", data: Buffer.from(tex, "utf8") },
    { name: "README.txt", data: Buffer.from(readme, "utf8") },
    ...imageEntries
  ]);
}

function resolveImage(
  documentId: string,
  ref: DocumentImageRef,
  baseWorkspace: string | null
): Promise<{ bytes: Buffer; ext: string } | null> {
  if (ref.kind === "repoImage") {
    return resolveRepoImage(documentId, ref.value, baseWorkspace);
  }
  if (ref.value.startsWith("data:")) {
    return resolveDataUrl(ref.value);
  }
  if (/^https?:\/\//i.test(ref.value)) {
    return resolveHttpUrl(ref.value);
  }
  return Promise.resolve(null);
}

// Export the document. Read access is sufficient (anyone who can view the
// document can export what they can already see). `?format=latex` returns an
// Overleaf-ready .zip; otherwise Markdown.
export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("share");
  const format = (url.searchParams.get("format") ?? "markdown").toLowerCase();

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const content = parseDocumentContent(access.document.content);
  const title = access.document.title?.trim() || "Untitled document";
  const slug = slugify(title);

  if (format === "latex" || format === "overleaf" || format === "zip") {
    const zip = await buildLatexZip({ documentId: id, title, content });
    // Copy into a fresh ArrayBuffer-backed view so the type is an unambiguous
    // BodyInit (Buffer's ArrayBufferLike backing is not accepted directly).
    const body = new Uint8Array(zip.byteLength);
    body.set(zip);
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${slug}.zip"`
      }
    });
  }

  const markdown = getDocumentMarkdown(content);
  const body = `# ${title}\n\n${markdown}\n`;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.md"`
    }
  });
}
