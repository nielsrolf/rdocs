import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateToolPathAccess, extractAbsolutePaths, isPathWithinWorkspace } from "../lib/agent-sandbox";

const WS = "/work/.research-workspaces/doc-1/worktrees/run-1";
const PROTECTED = ["/srv/gdocs-ai"];

test("isPathWithinWorkspace handles absolute, relative, and traversal paths", () => {
  assert.equal(isPathWithinWorkspace(WS, `${WS}/src/index.ts`), true);
  assert.equal(isPathWithinWorkspace(WS, "src/index.ts"), true); // relative to workspace
  assert.equal(isPathWithinWorkspace(WS, `${WS}/../run-2/secret`), false); // sibling run
  assert.equal(isPathWithinWorkspace(WS, "/etc/passwd"), false);
  assert.equal(isPathWithinWorkspace(WS, `${WS}`), true);
});

test("structured file tools are confined to the workspace", () => {
  const inside = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Read",
    toolInput: { file_path: `${WS}/README.md` }
  });
  assert.equal(inside.allowed, true);

  const outside = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Read",
    toolInput: { file_path: "/etc/passwd" }
  });
  assert.equal(outside.allowed, false);

  const grepOutside = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Grep",
    toolInput: { pattern: "secret", path: "/srv/gdocs-ai" }
  });
  assert.equal(grepOutside.allowed, false);
});

test("extractAbsolutePaths finds absolute and home tokens", () => {
  assert.deepEqual(extractAbsolutePaths("cat /etc/hosts && ls ~/.ssh"), ["/etc/hosts", "~/.ssh"]);
  assert.deepEqual(extractAbsolutePaths("echo hi"), []);
  assert.deepEqual(extractAbsolutePaths('grep x "/srv/gdocs-ai/.env"'), ["/srv/gdocs-ai/.env"]);
});

test("Bash referencing a protected root is denied; workspace + system paths are allowed", () => {
  const repoLeak = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "cat /srv/gdocs-ai/.env" }
  });
  assert.equal(repoLeak.allowed, false);

  const ownWorkspace = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: `cat ${WS}/notes.txt` }
  });
  assert.equal(ownWorkspace.allowed, true);

  // System paths (toolchain) are not in protectedRoots, so Bash may read them;
  // the kernel Seatbelt sandbox is what restricts these more broadly.
  const systemPath = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "node --version && cat /usr/lib/foo" }
  });
  assert.equal(systemPath.allowed, true);
});

test("non-path tools are always allowed", () => {
  assert.equal(
    evaluateToolPathAccess({
      workspace: WS,
      protectedRoots: PROTECTED,
      toolName: "WebSearch",
      toolInput: { query: "anything" }
    }).allowed,
    true
  );
});
