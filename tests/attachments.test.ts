import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ATTACHMENTS_DIRNAME,
  sanitizeFileName,
  saveAttachmentToStore,
  syncAttachmentsIntoWorktree
} from "../lib/attachments";
import { getDocumentAiBlocks, getDocumentMarkdown, getDocumentPlainText } from "../lib/content";
import { createDocumentEditorSchema } from "../lib/document-editor-schema";

const attachmentDoc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Before" }] },
    {
      type: "attachmentChip",
      attrs: {
        attachmentId: "att-1",
        documentId: "doc-1",
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
        size: 2048,
        workspacePath: "attachments/Q3-report.pdf"
      }
    },
    { type: "paragraph", content: [{ type: "text", text: "After" }] }
  ]
};

test("getDocumentMarkdown renders an attachment chip as a workspace-path link", () => {
  const md = getDocumentMarkdown(attachmentDoc);
  assert.match(md, /\[Attachment: Q3 report\.pdf\]\(attachments\/Q3-report\.pdf\)/);
});

test("getDocumentPlainText mentions the attachment by name", () => {
  const text = getDocumentPlainText(attachmentDoc);
  assert.match(text, /Attachment: Q3 report\.pdf/);
});

test("getDocumentAiBlocks includes the attachment and its workspace path", () => {
  const blocks = getDocumentAiBlocks(attachmentDoc);
  const joined = blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  assert.match(joined, /Attachment: Q3 report\.pdf \(attachments\/Q3-report\.pdf\)/);
});

test("attachmentChip is registered on the server schema and round-trips through nodeFromJSON", () => {
  // The server validates stored documents via schema.nodeFromJSON (see
  // lib/collaboration.ts), so this is the parse path that actually matters
  // out-of-browser. A missing node type here would throw.
  const schema = createDocumentEditorSchema();
  const pmDoc = schema.nodeFromJSON(attachmentDoc);
  const chip = pmDoc.child(1);
  assert.equal(chip.type.name, "attachmentChip");
  assert.equal(chip.attrs.attachmentId, "att-1");
  assert.equal(chip.attrs.fileName, "Q3 report.pdf");
  assert.equal(chip.attrs.size, 2048);
  assert.equal(chip.attrs.workspacePath, "attachments/Q3-report.pdf");

  // toJSON → nodeFromJSON preserves every attribute.
  const reparsed = schema.nodeFromJSON(pmDoc.toJSON());
  assert.equal(reparsed.child(1).attrs.workspacePath, "attachments/Q3-report.pdf");
});

test("sanitizeFileName strips path traversal and unsafe characters but keeps the extension", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("My Report (final).pdf"), "My-Report-final-.pdf");
  assert.equal(sanitizeFileName(""), "attachment");
});

test("saveAttachmentToStore uniquifies colliding names and syncAttachmentsIntoWorktree copies them with a self-ignoring .gitignore", async (t) => {
  // Run against a real temp WORKSPACE_ROOT by cd-ing process.cwd via the module's
  // path.join(process.cwd(), ...). Instead of mutating cwd, exercise the helpers
  // with a documentId scoped under the real workspace root and clean up after.
  const documentId = `test-attach-${process.pid}-${Date.now()}`;
  const workspaceRoot = path.join(process.cwd(), ".research-workspaces");
  t.after(async () => {
    await fs.rm(path.join(workspaceRoot, documentId), { recursive: true, force: true });
  });

  const first = await saveAttachmentToStore(documentId, "notes.txt", Buffer.from("one"));
  const second = await saveAttachmentToStore(documentId, "notes.txt", Buffer.from("two"));
  assert.equal(first.storedName, "notes.txt");
  assert.equal(second.storedName, "notes-1.txt");
  assert.equal(first.workspacePath, "attachments/notes.txt");

  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "wt-"));
  t.after(async () => {
    await fs.rm(worktree, { recursive: true, force: true });
  });
  // Make the worktree a real git repo so we can assert the copy stays untracked.
  spawnSync("git", ["init", "-q"], { cwd: worktree });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: worktree });
  spawnSync("git", ["config", "user.name", "t"], { cwd: worktree });

  await syncAttachmentsIntoWorktree(documentId, worktree);

  const copied = await fs.readFile(path.join(worktree, ATTACHMENTS_DIRNAME, "notes.txt"), "utf8");
  assert.equal(copied, "one");
  const ignore = await fs.readFile(path.join(worktree, ATTACHMENTS_DIRNAME, ".gitignore"), "utf8");
  assert.equal(ignore.trim(), "*");

  const status = spawnSync("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout.toString().trim(), "", "attachments must not show up as git changes");
});
