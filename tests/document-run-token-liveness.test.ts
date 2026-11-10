import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SESSION_SECRET ||= "test-session-secret-test-session-secret";

import { createDocumentRunToken, isDocumentRunTokenLive, verifyDocumentRunToken } from "../lib/document-run-token";

const claims = { userId: "u1", documentId: "docA", aiRunId: "run1" };
const run = (status: string, documentId = "docA") => async () => ({ status, documentId });

test("a document-run token works only while its run is RUNNING", async () => {
  const verified = await verifyDocumentRunToken(await createDocumentRunToken(claims));
  assert.deepEqual(verified, claims);
  assert.equal(await isDocumentRunTokenLive(verified!, run("RUNNING")), true);
  for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"]) {
    assert.equal(await isDocumentRunTokenLive(verified!, run(status)), false, status);
  }
});

test("a token is dead when its run is gone or belongs to another document", async () => {
  assert.equal(await isDocumentRunTokenLive(claims, async () => null), false);
  assert.equal(await isDocumentRunTokenLive(claims, run("RUNNING", "docB")), false);
});
