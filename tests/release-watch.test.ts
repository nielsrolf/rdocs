import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// deploy/release-watch.sh against a throwaway origin + checkout, with the real
// deploy replaced by a stub that records it ran. Regression (2026-11-07): the
// watcher treated `.deploy-active` as "a deploy is running", but deploy.sh
// keeps the ACTIVE COLOR in that file permanently — so once a single deploy had
// ever happened, every push to `release` was skipped forever.

const WATCHER = path.join(__dirname, "..", "deploy", "release-watch.sh");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-watch-"));
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, checkout);
  git(checkout, "config", "user.email", "t@example.com");
  git(checkout, "config", "user.name", "t");
  fs.mkdirSync(path.join(checkout, "deploy"));
  fs.copyFileSync(WATCHER, path.join(checkout, "deploy", "release-watch.sh"));
  fs.writeFileSync(
    path.join(checkout, "deploy", "deploy.sh"),
    "#!/usr/bin/env bash\necho \"$(git rev-parse HEAD)\" >> deployed.txt\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(checkout, "deploy", "refresh-dev-data.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(checkout, ".gitignore"), "deployed.txt\nlogs/\n.deploy-active\n.deploy.lock\n.release-watch.lock\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "push", "-q", "origin", "HEAD:main", "HEAD:release");
  // A previous deploy left its color behind, exactly as on the real host.
  fs.writeFileSync(path.join(checkout, ".deploy-active"), "blue\n");

  // Someone ships a new commit to release from another clone.
  const other = path.join(root, "other");
  git(root, "clone", "-q", origin, other);
  git(other, "config", "user.email", "t@example.com");
  git(other, "config", "user.name", "t");
  fs.writeFileSync(path.join(other, "feature.txt"), "new\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "feature");
  git(other, "push", "-q", "origin", "HEAD:release");
  return { root, checkout, target: git(other, "rev-parse", "HEAD") };
}

function runWatcher(checkout: string) {
  return spawnSync("bash", [path.join(checkout, "deploy", "release-watch.sh")], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH }
  });
}

test("a push to release deploys even though .deploy-active holds the current color", () => {
  const { root, checkout, target } = setup();
  try {
    const result = runWatcher(checkout);
    const deployed = fs.existsSync(path.join(checkout, "deployed.txt"))
      ? fs.readFileSync(path.join(checkout, "deployed.txt"), "utf8").trim()
      : "";
    assert.equal(deployed, target, `watcher did not deploy. stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.equal(git(checkout, "rev-parse", "HEAD"), target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the watcher waits while a deploy holds .deploy.lock", async () => {
  const { root, checkout } = setup();
  // Hold deploy.sh's single-flight lock the way a running deploy does.
  const holder = spawn("flock", [path.join(checkout, ".deploy.lock"), "sleep", "30"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = runWatcher(checkout);
    assert.equal(fs.existsSync(path.join(checkout, "deployed.txt")), false, result.stdout);
    assert.match(result.stdout, /a deploy is already running/);
  } finally {
    holder.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
