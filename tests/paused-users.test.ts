import assert from "node:assert/strict";
import test from "node:test";

import { parsePausedEmails } from "../lib/paused-users";

test("paused emails: comments, blanks and case", () => {
  const set = parsePausedEmails("# paused today\n\nA@Example.org  # reason\n b@example.org\n");
  assert.deepEqual([...set].sort(), ["a@example.org", "b@example.org"]);
});
