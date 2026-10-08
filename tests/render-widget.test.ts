import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { addWidgetIsolationBridge } from "../lib/widget-source";

// runner/render-widget.py (baked into the agent images) must reproduce exactly how
// the document page sizes a widget, or agents would approve charts that readers
// see cut off. Its copy of the height bridge has to match the injected one.
test("render-widget's bridge is identical to the one the widget source route injects", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "runner", "render-widget.py"), "utf8");
  const copy = script.match(/BRIDGE = """([\s\S]*?)"""/)?.[1];
  assert.ok(copy, "BRIDGE block not found in render-widget.py");
  const injected = addWidgetIsolationBridge("<html><body></body></html>").replace("<html><body>", "").replace("</body></html>", "");
  assert.equal(copy, injected);
});
