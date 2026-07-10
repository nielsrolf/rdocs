import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("agent-authored widget scripts run in an opaque sandbox, never the app origin", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/document-workspace/nodes.tsx"),
    "utf8"
  );
  const sandbox = source.match(/sandbox="([^"]+)"/)?.[1] ?? "";
  assert.match(sandbox, /(?:^|\s)allow-scripts(?:\s|$)/);
  assert.doesNotMatch(sandbox, /(?:^|\s)allow-same-origin(?:\s|$)/);
});

test("widget documents cannot be embedded outside their sandbox frame", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/api/documents/[id]/widgets/[widgetId]/source/route.ts"),
    "utf8"
  );
  assert.match(source, /frame-ancestors 'self'/);
});
