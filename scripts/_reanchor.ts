import { db } from "../lib/db";

const documentId = "cmpe98vtn0002ter2158nmlwb";
const APPLY = process.argv.includes("--apply");

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = {
  type?: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: Node[];
};

function collectThreadIdsInDoc(node: Node, into: Set<string>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.marks)) {
    for (const m of node.marks) {
      if (m?.type === "commentAnchor" && typeof m.attrs?.threadId === "string") into.add(m.attrs.threadId as string);
    }
  }
  if (Array.isArray((node.attrs as Record<string, unknown>)?.commentThreadIds)) {
    for (const tid of (node.attrs!.commentThreadIds as unknown[])) if (typeof tid === "string") into.add(tid);
  }
  if (Array.isArray(node.content)) for (const c of node.content) collectThreadIdsInDoc(c, into);
}

// Find all (paragraph-path, text-offset-within-paragraph) hits of anchorText in the doc.
type Hit = { paragraphPath: number[]; startOffset: number; endOffset: number };

function* iterateBlockNodes(node: Node, path: number[]): Generator<{ node: Node; path: number[] }> {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "blockquote" ||
    node.type === "codeBlock" ||
    node.type === "listItem" ||
    node.type === "taskItem" ||
    node.type === "tableCell" ||
    node.type === "tableHeader"
  ) {
    yield { node, path };
  }
  if (Array.isArray(node.content)) {
    for (let i = 0; i < node.content.length; i++) {
      yield* iterateBlockNodes(node.content[i], [...path, i]);
    }
  }
}

function blockText(node: Node): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text" && typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  return node.content.map((c) => blockText(c)).join("");
}

function findHits(doc: Node, needle: string): Hit[] {
  const hits: Hit[] = [];
  for (const { node, path } of iterateBlockNodes(doc, [])) {
    const text = blockText(node);
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      hits.push({ paragraphPath: path, startOffset: idx, endOffset: idx + needle.length });
      idx += needle.length;
    }
  }
  return hits;
}

function applyAnchorAtHit(doc: Node, hit: Hit, threadId: string) {
  let block = doc;
  for (const idx of hit.paragraphPath) {
    block = (block.content as Node[])[idx];
  }
  const content = (block.content ?? []) as Node[];
  const newContent: Node[] = [];
  let cursor = 0;
  let { startOffset, endOffset } = hit;

  for (const child of content) {
    if (child.type !== "text" || typeof child.text !== "string") {
      newContent.push(child);
      continue;
    }
    const start = cursor;
    const end = cursor + child.text.length;
    cursor = end;

    if (end <= startOffset || start >= endOffset) {
      newContent.push(child);
      continue;
    }

    const before = child.text.slice(0, Math.max(0, startOffset - start));
    const middle = child.text.slice(Math.max(0, startOffset - start), Math.min(child.text.length, endOffset - start));
    const after = child.text.slice(Math.min(child.text.length, endOffset - start));

    if (before) newContent.push({ ...child, text: before });
    if (middle) {
      const existingMarks = (child.marks ?? []).filter((m) => !(m.type === "commentAnchor" && m.attrs?.threadId === threadId));
      newContent.push({
        ...child,
        text: middle,
        marks: [...existingMarks, { type: "commentAnchor", attrs: { threadId } }]
      });
    }
    if (after) newContent.push({ ...child, text: after });
  }

  block.content = newContent;
}

async function main() {
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { content: true, title: true, updatedAt: true }
  });
  const content = JSON.parse(doc.content) as Node;

  const anchored = new Set<string>();
  collectThreadIdsInDoc(content, anchored);

  const threads = await db.commentThread.findMany({
    where: { documentId },
    select: { id: true, anchorText: true, createdAt: true, createdBy: { select: { name: true } } }
  });

  const orphans = threads.filter((t) => !anchored.has(t.id));
  console.log(`document updatedAt: ${doc.updatedAt.toISOString()}`);
  console.log(`orphan threads: ${orphans.length}/${threads.length}`);

  const plan: { threadId: string; hits: Hit[]; chosen: Hit | null; reason: string }[] = [];
  for (const t of orphans) {
    if (!t.anchorText) {
      plan.push({ threadId: t.id, hits: [], chosen: null, reason: "no anchorText" });
      continue;
    }
    const hits = findHits(content, t.anchorText);
    if (hits.length === 0) {
      plan.push({ threadId: t.id, hits, chosen: null, reason: "anchorText not found in doc" });
    } else if (hits.length === 1) {
      plan.push({ threadId: t.id, hits, chosen: hits[0], reason: "unique match" });
    } else {
      plan.push({ threadId: t.id, hits, chosen: hits[0], reason: `${hits.length} matches; choosing first` });
    }
  }

  for (const p of plan) {
    const t = orphans.find((x) => x.id === p.threadId)!;
    console.log(`  ${p.chosen ? "REANCHOR" : "SKIP    "}  ${p.threadId}  by ${t.createdBy?.name}  anchor=${JSON.stringify((t.anchorText ?? "").slice(0, 60))}  →  ${p.reason}`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write changes.");
    return;
  }

  let mutated = 0;
  for (const p of plan) {
    if (!p.chosen) continue;
    applyAnchorAtHit(content, p.chosen, p.threadId);
    mutated += 1;
  }

  if (mutated === 0) {
    console.log("Nothing to apply.");
    return;
  }

  const nextContent = JSON.stringify(content);

  // Backup snapshot (mirrors maybeCreateVersionSnapshot's preserve-prior behavior).
  const latest = await db.documentVersion.findFirst({
    where: { documentId },
    orderBy: { createdAt: "desc" },
    select: { title: true, content: true }
  });
  const priorAlreadyArchived = latest?.title === doc.title && latest?.content === doc.content;
  if (!priorAlreadyArchived) {
    await db.documentVersion.create({
      data: {
        documentId,
        title: doc.title,
        content: doc.content,
        sourceLinks: "[]",
        commitSha: null,
        commitUrl: null,
        aiRunId: null
      }
    });
    console.log("snapshotted prior content to DocumentVersion");
  }

  await db.document.update({
    where: { id: documentId },
    data: { content: nextContent }
  });
  console.log(`applied ${mutated} re-anchors and saved.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
