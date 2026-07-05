import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { db } from "../../lib/db";
import { seedUser } from "./helpers";

// End-to-end HTTP coverage of the real Next.js API routes (auth cookies +
// routing + serialization + persistence) for the bug classes that depend on the
// full request path: saving, comment create/reply/display, and commenting on
// block nodes. The Claude agent (LLM) is NOT triggered here — agent routes are
// covered by the async unit/smoke tests; here we assert the cheap guards.
//
// Targets a RUNNING server (GDOCS_TEST_URL, default http://localhost:14141).
// If none is reachable the whole suite skips with a clear message rather than
// failing — run `npm run test:integration` against a live server.

const BASE = process.env.GDOCS_TEST_URL ?? "http://localhost:14141";

// Cached connectivity probe (no top-level await — unsupported under CJS output).
let reachablePromise: Promise<boolean> | null = null;
function serverReachable(): Promise<boolean> {
  if (!reachablePromise) {
    reachablePromise = fetch(`${BASE}/api/documents`, { method: "GET" })
      .then(() => true)
      .catch(() => {
        console.warn(`[integration] server not reachable at ${BASE} — skipping HTTP integration suite.`);
        return false;
      });
  }
  return reachablePromise;
}

// Register a test that first checks the server is up and skips otherwise.
function itLive(name: string, fn: (t: import("node:test").TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await serverReachable())) {
      t.skip(`server not reachable at ${BASE}`);
      return;
    }
    await fn(t);
  });
}

const createdEmails: string[] = [];

after(async () => {
  // Tidy up users (and their cascade-deleted documents/threads) created here.
  for (const email of createdEmails) {
    await db.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await db.$disconnect().catch(() => undefined);
});

function cookieFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  // Keep just the name=value of each cookie.
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

// Seed via Prisma + mint the JWT locally — the HTTP sign-up route is rate
// limited to 10/min/IP, and this suite creates a user per test. Real route
// coverage lives in the dedicated sign-up test below.
async function signUp(): Promise<string> {
  const seeded = await seedUser();
  createdEmails.push(seeded.email);
  return seeded.cookie;
}

itLive("the HTTP sign-up route issues a session cookie", async () => {
  const email = `int-${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  const res = await fetch(`${BASE}/api/auth/sign-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Integration Test", email, password: "password1234" })
  });
  assert.equal(res.status, 200, "sign-up should succeed");
  const cookie = cookieFrom(res);
  assert.ok(cookie.includes("gdocs_ai_session"), "sign-up should set a session cookie");
});

function authed(cookie: string, url: string, init: RequestInit = {}) {
  return fetch(`${BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) }
  });
}

async function createDocument(cookie: string): Promise<string> {
  const res = await authed(cookie, "/api/documents", { method: "POST" });
  assert.equal(res.status, 200, "document creation should succeed");
  const data = await res.json();
  assert.ok(data.id, "document id returned");
  return data.id as string;
}

itLive("title save persists across a reload (PATCH then GET)", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  const patch = await authed(cookie, `/api/documents/${docId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "A renamed document" })
  });
  assert.equal(patch.status, 200);

  const get = await authed(cookie, `/api/documents/${docId}`);
  assert.equal(get.status, 200);
  const data = await get.json();
  assert.equal(data.document.title, "A renamed document");
});

itLive("creating a comment thread persists and is displayed on reload", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  const create = await authed(cookie, `/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "first comment", anchorText: "some text" })
  });
  assert.equal(create.status, 200, "comment creation should succeed");
  const created = await create.json();
  assert.ok(created.thread?.id, "thread returned");
  assert.equal(created.thread.comments[0].body, "first comment");

  const get = await authed(cookie, `/api/documents/${docId}`);
  const data = await get.json();
  const thread = data.threads.find((t: { id: string }) => t.id === created.thread.id);
  assert.ok(thread, "thread is displayed after reload");
  assert.equal(thread.comments[0].body, "first comment");
});

itLive("replying to a thread persists and appears in the thread", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);
  const create = await authed(cookie, `/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "original", anchorText: "anchor" })
  });
  const threadId = (await create.json()).thread.id as string;

  const reply = await authed(cookie, `/api/comments/${threadId}/reply`, {
    method: "POST",
    body: JSON.stringify({ body: "a reply" })
  });
  assert.equal(reply.status, 200, "reply should succeed");

  const get = await authed(cookie, `/api/documents/${docId}`);
  const data = await get.json();
  const thread = data.threads.find((t: { id: string }) => t.id === threadId);
  const bodies = thread.comments.map((c: { body: string }) => c.body);
  assert.deepEqual(bodies, ["original", "a reply"]);
});

itLive("commenting on a block node (widget) succeeds when its commentThreadIds anchor is present", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);
  const threadId = `widget-thread-${crypto.randomUUID().slice(0, 8)}`;

  // Seed the document content with a widget block carrying the thread id.
  const patch = await authed(cookie, `/api/documents/${docId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: "With widget",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
          {
            type: "embeddedWidget",
            attrs: {
              widgetId: "w1",
              label: "Explorer",
              buildCmd: "python w.py",
              embedSource: "assets/w.html",
              src: "/api/documents/x/widgets/w1/source",
              commentThreadIds: [threadId]
            }
          }
        ]
      }
    })
  });
  assert.equal(patch.status, 200);

  const create = await authed(cookie, `/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ threadId, body: "comment on the widget", anchorText: "Explorer" })
  });
  assert.equal(create.status, 200, "commenting on a widget block should succeed");
});

itLive("rejects an orphan comment whose anchor is not in the document", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);
  const create = await authed(cookie, `/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ threadId: "never-anchored", body: "orphan", anchorText: "x" })
  });
  assert.equal(create.status, 409, "orphan comment (no anchor in doc) must be refused");
});

itLive("ai-edit rejects unauthenticated and invalid requests without running the agent", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  // Invalid payload (missing required fields) => 400, no agent run.
  const invalid = await authed(cookie, `/api/documents/${docId}/ai-edit`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(invalid.status, 400);

  // No auth => 403/401.
  const noauth = await fetch(`${BASE}/api/documents/${docId}/ai-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedText: "x", instruction: "do it" })
  });
  assert.ok(noauth.status === 401 || noauth.status === 403, `expected 401/403, got ${noauth.status}`);
});

itLive("exports the document as Markdown with a download filename", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);
  await authed(cookie, `/api/documents/${docId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "My Export Doc" })
  });

  const res = await authed(cookie, `/api/documents/${docId}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="my-export-doc\.md"/);
  const body = await res.text();
  assert.match(body, /^# My Export Doc/);
});

itLive("a comment author can edit their comment; unauthenticated edits are rejected", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);
  const create = await authed(cookie, `/api/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "typo here", anchorText: "anchor" })
  });
  const commentId = (await create.json()).thread.comments[0].id as string;

  const edit = await authed(cookie, `/api/comments/comment/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body: "fixed now" })
  });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).comment.body, "fixed now");

  // The edit is visible on reload.
  const get = await authed(cookie, `/api/documents/${docId}`);
  const data = await get.json();
  const thread = data.threads.find((t: { comments: Array<{ id: string }> }) =>
    t.comments.some((c) => c.id === commentId)
  );
  assert.equal(thread.comments.find((c: { id: string }) => c.id === commentId).body, "fixed now");

  // Unauthenticated edit is refused.
  const noauth = await fetch(`${BASE}/api/comments/comment/${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "hijack" })
  });
  assert.ok(noauth.status === 401 || noauth.status === 403, `expected 401/403, got ${noauth.status}`);
});

itLive("agent model PATCH accepts canonical ids, legacy aliases, and openrouter slugs — and rejects junk", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  for (const agentModel of [
    "claude-fable-5",
    "sonnet",
    "openrouter/openai/gpt-5.2",
    "litellm/anthropic/claude-opus-4-8",
    "litellm/openrouter/openai/gpt-5",
    "openrouter/deepseek/deepseek-v3.2:free"
  ]) {
    const res = await authed(cookie, `/api/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "model test", agentModel })
    });
    assert.equal(res.status, 200, `expected 200 for ${agentModel}`);
  }

  const get = await authed(cookie, `/api/documents/${docId}`);
  const data = await get.json();
  assert.equal(data.document.agentModel, "openrouter/deepseek/deepseek-v3.2:free");

  for (const agentModel of ["gpt-5", "openrouter/", "openrouter/../../etc/passwd", "openrouter/a b/c", "litellm/", "litellm/../etc/passwd"]) {
    const res = await authed(cookie, `/api/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "model test", agentModel })
    });
    assert.equal(res.status, 400, `expected 400 for ${agentModel}`);
  }
});

itLive("document GET reports OPENROUTER_API_KEY presence (never the value)", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  const before = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(before.document.hasOpenRouterKey, false);

  const add = await authed(cookie, `/api/documents/${docId}/environment`, {
    method: "POST",
    body: JSON.stringify({ key: "OPENROUTER_API_KEY", value: "sk-or-v1-test" })
  });
  assert.equal(add.status, 200);

  const after = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(after.document.hasOpenRouterKey, true);
  assert.ok(!JSON.stringify(after).includes("sk-or-v1-test"), "key value must never appear in the document payload");

  const del = await authed(cookie, `/api/documents/${docId}/environment`, {
    method: "DELETE",
    body: JSON.stringify({ key: "OPENROUTER_API_KEY" })
  });
  assert.equal(del.status, 200);
  const cleared = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(cleared.document.hasOpenRouterKey, false);
});

itLive("a per-user provider credential unlocks third-party models on the owner's documents", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  const before = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(before.document.hasOpenRouterKey, false);
  assert.equal(before.document.hasLiteLlmKey, false);

  // Connect user-level keys (no document env involved).
  for (const [provider, value] of [
    ["openrouter", "sk-or-v1-user-test"],
    ["litellm", "sk-litellm-user-test"]
  ]) {
    const res = await authed(cookie, "/api/user/credentials", {
      method: "POST",
      body: JSON.stringify({ provider, value })
    });
    assert.equal(res.status, 200, `expected 200 connecting ${provider} credential`);
  }

  const list = await (await authed(cookie, "/api/user/credentials")).json();
  assert.deepEqual(
    list.credentials.map((c: { provider: string }) => c.provider).sort(),
    ["litellm", "openrouter"]
  );
  assert.ok(
    !JSON.stringify(list).includes("sk-or-v1-user-test"),
    "credential value must never be returned in full"
  );

  const after = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(after.document.hasOpenRouterKey, true, "owner openrouter key should gate the selector");
  assert.equal(after.document.hasLiteLlmKey, true, "owner litellm key should gate the selector");

  // Removing the user-level keys locks the groups again.
  for (const provider of ["openrouter", "litellm"]) {
    const res = await authed(cookie, "/api/user/credentials", {
      method: "DELETE",
      body: JSON.stringify({ provider })
    });
    assert.equal(res.status, 200);
  }
  const cleared = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(cleared.document.hasOpenRouterKey, false);
  assert.equal(cleared.document.hasLiteLlmKey, false);
});

itLive("document GET reports LITELLM_API_KEY presence (never the value)", async () => {
  const cookie = await signUp();
  const docId = await createDocument(cookie);

  const before = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(before.document.hasLiteLlmKey, false);

  const add = await authed(cookie, `/api/documents/${docId}/environment`, {
    method: "POST",
    body: JSON.stringify({ key: "LITELLM_API_KEY", value: "sk-litellm-test" })
  });
  assert.equal(add.status, 200);

  const after = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(after.document.hasLiteLlmKey, true);
  assert.ok(!JSON.stringify(after).includes("sk-litellm-test"), "key value must never appear in the document payload");

  const del = await authed(cookie, `/api/documents/${docId}/environment`, {
    method: "DELETE",
    body: JSON.stringify({ key: "LITELLM_API_KEY" })
  });
  assert.equal(del.status, 200);
  const cleared = await (await authed(cookie, `/api/documents/${docId}`)).json();
  assert.equal(cleared.document.hasLiteLlmKey, false);
});
