import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateToolPathAccess, extractAbsolutePaths, isPathWithinWorkspace } from "../lib/agent-sandbox";

const WS = "/work/.research-workspaces/doc-1/worktrees/run-1";
const PROTECTED = ["/srv/gdocs-ai"];

// The guard expands ~ / $HOME using process.env.HOME; pin it to a path that is
// clearly outside the workspace and outside the system allowlist so the
// home-directory tests are deterministic.
const HOME = "/home/victim";
process.env.HOME = HOME;

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
  // A bare `~` (as in `ls ~`) must be extracted too — otherwise it slips past
  // the guard entirely.
  assert.deepEqual(extractAbsolutePaths("ls ~"), ["~"]);
  assert.deepEqual(extractAbsolutePaths("cd ~ && cat foo"), ["~"]);
});

test("Bash accessing the host home directory is denied", () => {
  // The exact reproduction from the user's bug report: the agent ran `ls ~` and
  // listed the host home directory. The workspace lives *inside* the server
  // repo, but the home dir is the repo's parent — a denylist of protected roots
  // never covered it. Confinement must deny it.
  const bareTilde = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "ls ~" }
  });
  assert.equal(bareTilde.allowed, false);

  const sshKey = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "cat ~/.ssh/id_rsa" }
  });
  assert.equal(sshKey.allowed, false);

  const homeVar = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "cat $HOME/.aws/credentials" }
  });
  assert.equal(homeVar.allowed, false);

  const homeBraceVar = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "ls ${HOME}/Documents" }
  });
  assert.equal(homeBraceVar.allowed, false);

  // An absolute path to the home directory by its real path is denied too.
  const absHome = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: `cat ${HOME}/.bash_history` }
  });
  assert.equal(absHome.allowed, false);
});

test("Bash accessing an arbitrary out-of-workspace path is denied", () => {
  // Anything outside the workspace and outside the system allowlist is denied —
  // not just the previously-enumerated protected roots.
  const otherProject = evaluateToolPathAccess({
    workspace: WS,
    protectedRoots: PROTECTED,
    toolName: "Bash",
    toolInput: { command: "cat /data/other-project/secret.txt" }
  });
  assert.equal(otherProject.allowed, false);
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
