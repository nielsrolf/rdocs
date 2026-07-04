import assert from "node:assert/strict";
import test from "node:test";

import { planDivergenceRecovery } from "../components/document-workspace/collaboration";

// When a divergence can no longer be auto-rebased, recovery depends ONLY on
// whether anyone else is connected. This decision is now reached from every
// divergence-detection site (the push 409 rebase, the fallback poll, and the
// live SSE "steps" event) — previously only the push path recovered, which is
// why an idle / freshly-opened sole-client tab stranded on "Save failed".

test("a sole client force-pushes its state (git push --force)", () => {
  assert.equal(planDivergenceRecovery({ otherClientsPresent: false }), "force-push");
});

test("with a collaborator present we never clobber — resolve via manual merge", () => {
  assert.equal(planDivergenceRecovery({ otherClientsPresent: true }), "manual-merge");
});
