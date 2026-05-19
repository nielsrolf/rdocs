import assert from "node:assert/strict";
import test from "node:test";

import { parseBuildCommand, validateWidgetBuildCommand } from "../lib/research-workspace";

test("parseBuildCommand splits quoted arguments correctly", () => {
  assert.deepEqual(parseBuildCommand('python widgets/build.py --label "Rollout explorer"'), [
    "python",
    "widgets/build.py",
    "--label",
    "Rollout explorer"
  ]);
});

test("parseBuildCommand returns null on unterminated quotes", () => {
  assert.equal(parseBuildCommand('python "widgets/build.py'), null);
});

test("validateWidgetBuildCommand accepts allowed executables", () => {
  assert.equal(
    validateWidgetBuildCommand(["python", "widgets/build_demo.py", "--output", "assets/demo.html"], "/tmp/repo"),
    null
  );
});

test("validateWidgetBuildCommand rejects disallowed executables and absolute paths", () => {
  assert.match(
    validateWidgetBuildCommand(["rm", "-rf", "/"], "/tmp/repo") ?? "",
    /not allowed/
  );
  assert.match(
    validateWidgetBuildCommand(["/usr/bin/python", "widgets/build.py"], "/tmp/repo") ?? "",
    /executable name/
  );
});

test("validateWidgetBuildCommand rejects tokens with shell metacharacters", () => {
  assert.match(
    validateWidgetBuildCommand(["python", "widgets/$(whoami).py"], "/tmp/repo") ?? "",
    /unsupported characters/
  );
});

test("validateWidgetBuildCommand rejects script paths that escape the workspace", () => {
  assert.match(
    validateWidgetBuildCommand(["python", "../widgets/build.py"], "/tmp/repo") ?? "",
    /inside the repository workspace/
  );
});
