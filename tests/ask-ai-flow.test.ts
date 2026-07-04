import assert from "node:assert/strict";
import { test } from "node:test";

import { submitPendingReplyThenAskAi } from "../components/document-workspace/ask-ai-flow";

test("sends the pending reply before asking AI", async () => {
  const calls: string[] = [];
  const result = await submitPendingReplyThenAskAi({
    draft: "please double-check the numbers",
    sendReply: async () => {
      calls.push("reply");
      return true;
    },
    askAi: async () => {
      calls.push("ask-ai");
    }
  });

  assert.equal(result, "asked");
  assert.deepEqual(calls, ["reply", "ask-ai"]);
});

test("does not ask AI when sending the pending reply fails", async () => {
  const calls: string[] = [];
  const result = await submitPendingReplyThenAskAi({
    draft: "please double-check the numbers",
    sendReply: async () => {
      calls.push("reply");
      return false;
    },
    askAi: async () => {
      calls.push("ask-ai");
    }
  });

  assert.equal(result, "reply-failed");
  assert.deepEqual(calls, ["reply"]);
});

test("asks AI directly when the draft is empty or whitespace", async () => {
  for (const draft of ["", "   \n"]) {
    const calls: string[] = [];
    const result = await submitPendingReplyThenAskAi({
      draft,
      sendReply: async () => {
        calls.push("reply");
        return true;
      },
      askAi: async () => {
        calls.push("ask-ai");
      }
    });

    assert.equal(result, "asked");
    assert.deepEqual(calls, ["ask-ai"]);
  }
});
