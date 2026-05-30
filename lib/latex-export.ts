// Converts a TipTap document (the same JSON shape lib/content.ts walks for
// Markdown) into a self-contained LaTeX document suitable for Overleaf. The
// conversion is pure — image bytes are resolved by the caller (the export
// route) and passed back in via `imagePaths`, so this module stays unit-testable
// without filesystem or network access.

type Attrs = Record<string, unknown> | null;

function getNodeType(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const type = (node as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

function getNodeContent(node: unknown): unknown[] {
  if (!node || typeof node !== "object") return [];
  const content = (node as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function getNodeAttrs(node: unknown): Attrs {
  if (!node || typeof node !== "object") return null;
  const attrs = (node as { attrs?: unknown }).attrs;
  return attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const LATEX_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}"
};

/**
 * Escape a run of plain text so it compiles as literal LaTeX. Single-pass so
 * the braces introduced by `\textbackslash{}` etc. are not re-escaped.
 */
export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESCAPES[ch]);
}

function escapeUrl(url: string): string {
  // hyperref handles most characters; only % and # must be escaped in the href.
  return url.replace(/([%#\\])/g, "\\$1");
}

// Stable identity for an image node, shared by collection and serialization so
// the caller's resolved-path map lines up with what the serializer looks up.
function imageKey(node: unknown): string | null {
  const type = getNodeType(node);
  const attrs = getNodeAttrs(node);
  if (type === "image") {
    const src = str(attrs?.src);
    return src ? `image:${src}` : null;
  }
  if (type === "repoImage") {
    const path = str(attrs?.path) || str(attrs?.src);
    return path ? `repo:${path}` : null;
  }
  return null;
}

export type DocumentImageRef = {
  key: string;
  kind: "image" | "repoImage";
  /** For images: the src (data:/http(s)). For repoImage: the repo-relative path. */
  value: string;
  alt: string;
  caption: string;
};

/** Collect every image in document order, de-duplicated by key. */
export function collectDocumentImages(content: unknown): DocumentImageRef[] {
  const out: DocumentImageRef[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown) => {
    const type = getNodeType(node);
    if (type === "image" || type === "repoImage") {
      const key = imageKey(node);
      if (key && !seen.has(key)) {
        seen.add(key);
        const attrs = getNodeAttrs(node);
        out.push({
          key,
          kind: type,
          value: type === "repoImage" ? str(attrs?.path) || str(attrs?.src) : str(attrs?.src),
          alt: str(attrs?.alt),
          caption: str(attrs?.caption)
        });
      }
    }
    for (const child of getNodeContent(node)) walk(child);
  };
  walk(content);
  return out;
}

type Ctx = {
  listKinds: Array<"ordered" | "bullet" | "task">;
  inCode: boolean;
  imagePaths: Map<string, string>;
};

function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) return text;
  let href: string | null = null;
  let code = false;
  let bold = false;
  let italic = false;
  let strike = false;
  let underline = false;
  for (const mark of marks) {
    if (!mark || typeof mark !== "object") continue;
    const type = (mark as { type?: unknown }).type;
    if (type === "link") {
      const attrs = (mark as { attrs?: { href?: unknown } }).attrs;
      if (typeof attrs?.href === "string") href = attrs.href;
    } else if (type === "code") code = true;
    else if (type === "bold") bold = true;
    else if (type === "italic") italic = true;
    else if (type === "strike") strike = true;
    else if (type === "underline") underline = true;
  }

  let result = text;
  if (code) {
    result = `\\texttt{${result}}`;
  } else {
    if (strike) result = `\\sout{${result}}`;
    if (underline) result = `\\underline{${result}}`;
    if (italic) result = `\\emph{${result}}`;
    if (bold) result = `\\textbf{${result}}`;
  }
  if (href) {
    result = `\\href{${escapeUrl(href)}}{${result}}`;
  }
  return result;
}

function serializeChildren(node: unknown, ctx: Ctx): string {
  return getNodeContent(node)
    .map((child) => serializeNode(child, ctx))
    .join("");
}

function headingCommand(level: number, body: string): string {
  switch (level) {
    case 1:
      return `\\section{${body}}\n\n`;
    case 2:
      return `\\subsection{${body}}\n\n`;
    case 3:
      return `\\subsubsection{${body}}\n\n`;
    default:
      return `\\paragraph{${body}}\\mbox{}\\\\\n\n`;
  }
}

function imageFigure(ref: { alt: string; caption: string }, texPath: string | undefined): string {
  const captionText = ref.caption || ref.alt;
  const caption = captionText ? `\\caption{${escapeLatex(captionText)}}\n` : "";
  if (texPath) {
    return (
      `\\begin{figure}[h]\n\\centering\n` +
      `\\includegraphics[width=0.8\\linewidth]{${texPath}}\n` +
      caption +
      `\\end{figure}\n\n`
    );
  }
  // Unresolved image: a framed placeholder keeps the document compiling.
  const label = captionText || "image";
  return (
    `\\begin{figure}[h]\n\\centering\n` +
    `\\fbox{\\parbox{0.8\\linewidth}{\\centering [Image not embedded: ${escapeLatex(label)}]}}\n` +
    caption +
    `\\end{figure}\n\n`
  );
}

function serializeNode(node: unknown, ctx: Ctx): string {
  const type = getNodeType(node);

  if (type === "text") {
    const raw = str((node as { text?: unknown }).text);
    if (ctx.inCode) return raw;
    return applyMarks(escapeLatex(raw), (node as { marks?: unknown }).marks);
  }

  if (type === "hardBreak") return "\\\\\n";

  if (type === "image" || type === "repoImage") {
    const attrs = getNodeAttrs(node);
    const key = imageKey(node);
    const texPath = key ? ctx.imagePaths.get(key) : undefined;
    return imageFigure({ alt: str(attrs?.alt), caption: str(attrs?.caption) }, texPath);
  }

  if (type === "embeddedWidget") {
    const attrs = getNodeAttrs(node);
    const label = str(attrs?.label) || "Interactive widget";
    return (
      `\\begin{figure}[h]\n\\centering\n` +
      `\\fbox{\\parbox{0.8\\linewidth}{\\centering Interactive widget: ${escapeLatex(label)}\\\\` +
      `(not exportable to LaTeX)}}\n\\end{figure}\n\n`
    );
  }

  if (type === "heading") {
    const level = Math.min(6, Math.max(1, Number(getNodeAttrs(node)?.level) || 2));
    return headingCommand(level, serializeChildren(node, ctx).trim());
  }

  if (type === "tabBreak") {
    const title = str(getNodeAttrs(node)?.title) || "Untitled tab";
    return `\\section{${escapeLatex(title)}}\n\n`;
  }

  if (type === "paragraph") {
    const body = serializeChildren(node, ctx).trim();
    return body ? `${body}\n\n` : "";
  }

  if (type === "blockquote") {
    const body = serializeChildren(node, ctx).trim();
    return body ? `\\begin{quote}\n${body}\n\\end{quote}\n\n` : "";
  }

  if (type === "codeBlock") {
    const body = serializeChildren(node, { ...ctx, inCode: true }).replace(/\n$/, "");
    return `\\begin{verbatim}\n${body}\n\\end{verbatim}\n\n`;
  }

  if (type === "bulletList" || type === "orderedList" || type === "taskList") {
    const kind = type === "orderedList" ? "ordered" : type === "taskList" ? "task" : "bullet";
    ctx.listKinds.push(kind);
    const env = kind === "ordered" ? "enumerate" : "itemize";
    const body = serializeChildren(node, ctx);
    ctx.listKinds.pop();
    return `\\begin{${env}}\n${body}\\end{${env}}\n\n`;
  }

  if (type === "listItem") {
    return `\\item ${serializeChildren(node, ctx).trim()}\n`;
  }

  if (type === "taskItem") {
    const checked = getNodeAttrs(node)?.checked === true;
    const box = checked ? "$\\boxtimes$" : "$\\square$";
    return `\\item[${box}] ${serializeChildren(node, ctx).trim()}\n`;
  }

  if (type === "table") {
    const rows = getNodeContent(node);
    const colCount = rows.length > 0 ? getNodeContent(rows[0]).length : 0;
    if (colCount === 0) return "";
    const spec = Array.from({ length: colCount }, () => "l").join(" ");
    const body = rows.map((row) => serializeTableRow(row, ctx)).join("\\hline\n");
    return `\\begin{center}\n\\begin{tabular}{${spec}}\n\\hline\n${body}\\hline\n\\end{tabular}\n\\end{center}\n\n`;
  }

  if (type === "horizontalRule") {
    return `\\noindent\\rule{\\linewidth}{0.4pt}\n\n`;
  }

  // Unknown wrapper node: descend into its children.
  return serializeChildren(node, ctx);
}

function serializeTableRow(row: unknown, ctx: Ctx): string {
  const cells = getNodeContent(row).map((cell) =>
    serializeChildren(cell, ctx).replace(/\s+/g, " ").trim()
  );
  return `${cells.join(" & ")} \\\\\n`;
}

const PREAMBLE = `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[normalem]{ulem}
\\usepackage{hyperref}
`;

export function documentToLatex(
  content: unknown,
  opts: { title: string; imagePaths?: Map<string, string> }
): string {
  const ctx: Ctx = {
    listKinds: [],
    inCode: false,
    imagePaths: opts.imagePaths ?? new Map()
  };
  const body = getNodeContent(content)
    .map((node) => serializeNode(node, ctx))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const title = escapeLatex(opts.title.trim() || "Untitled document");
  return (
    PREAMBLE +
    `\n\\title{${title}}\n\\author{}\n\\date{}\n\n` +
    `\\begin{document}\n\\maketitle\n\n${body}\n\n\\end{document}\n`
  );
}
