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
    "#!/usr/bin/env bash\necho \"$(git rev-parse HEAD)\" >> deployed.txt\nexit \"$(cat deploy-exit 2>/dev/null || echo 0)\"\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(checkout, "deploy", "refresh-dev-data.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(checkout, ".gitignore"), "deployed.txt\ndeploy-exit\nlogs/\n.deploy-active\n.deploy.lock\n.release-watch*\n");
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

// 2026-11-10: a release that could not deploy (stale listener on the target
// port) was rebuilt every 2 minutes, three full builds before anyone looked.
test("a release that keeps failing is retried once, then parked until release moves", () => {
  const { root, checkout } = setup();
  const attempts = () =>
    fs.existsSync(path.join(checkout, "deployed.txt"))
      ? fs.readFileSync(path.join(checkout, "deployed.txt"), "utf8").trim().split("\n").length
      : 0;
  try {
    fs.writeFileSync(path.join(checkout, "deploy-exit"), "1\n");
    for (let tick = 0; tick < 5; tick++) runWatcher(checkout);
    assert.equal(attempts(), 2, "the same failing sha must not be rebuilt on every tick");
    const log = fs.readFileSync(path.join(checkout, "logs", "release-watch.log"), "utf8");
    assert.equal(log.match(/parked until release moves/g)?.length, 1, log);

    // A new push is a new chance, and a success clears the parking state.
    fs.writeFileSync(path.join(checkout, "deploy-exit"), "0\n");
    const other = path.join(root, "other");
    fs.writeFileSync(path.join(other, "fix.txt"), "fix\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "fix");
    git(other, "push", "-q", "origin", "HEAD:release");
    runWatcher(checkout);
    assert.equal(attempts(), 3);
    assert.equal(fs.existsSync(path.join(checkout, ".release-watch-failed")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unreleased local commits are reported once, not on every tick", () => {
  const { root, checkout } = setup();
  try {
    fs.writeFileSync(path.join(checkout, "local.txt"), "unreleased\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "-q", "-m", "local work");
    for (let tick = 0; tick < 4; tick++) runWatcher(checkout);
    assert.equal(fs.existsSync(path.join(checkout, "deployed.txt")), false);
    const log = fs.readFileSync(path.join(checkout, "logs", "release-watch.log"), "utf8");
    assert.equal(log.match(/is not an ancestor/g)?.length, 1, log);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
