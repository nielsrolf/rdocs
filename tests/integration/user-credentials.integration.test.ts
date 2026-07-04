import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { db } from "../../lib/db";

// HTTP coverage of the per-user AI credential CRUD route (auth + validation +
// masking), mirroring the document environment route tests. Targets a RUNNING
// server (GDOCS_TEST_URL, default http://localhost:14141); skips if unreachable.
// The write path needs CREDENTIAL_ENCRYPTION_KEY set on the server — if it is
// missing the POST 500s and the write assertions skip rather than fail.

const BASE = process.env.GDOCS_TEST_URL ?? "http://localhost:14141";

let reachablePromise: Promise<boolean> | null = null;
function serverReachable(): Promise<boolean> {
  if (!reachablePromise) {
    reachablePromise = fetch(`${BASE}/api/documents`, { method: "GET" })
      .then(() => true)
      .catch(() => {
        console.warn(`[integration] server not reachable at ${BASE} — skipping credential suite.`);
        return false;
      });
  }
  return reachablePromise;
}

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
  for (const email of createdEmails) {
    await db.user.deleteMany({ where: { email } }).catch(() => undefined);
  }
  await db.$disconnect().catch(() => undefined);
});

function cookieFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

async function signUp(): Promise<string> {
  const email = `cred-${crypto.randomUUID()}@example.com`;
  createdEmails.push(email);
  const res = await fetch(`${BASE}/api/auth/sign-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Cred Test", email, password: "password1234" })
  });
  assert.equal(res.status, 200, "sign-up should succeed");
  const cookie = cookieFrom(res);
  assert.ok(cookie.includes("gdocs_ai_session"), "sign-up should set a session cookie");
  return cookie;
}

function authed(cookie: string, url: string, init: RequestInit = {}) {
  return fetch(`${BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) }
  });
}

itLive("credential CRUD: connect, mask, replace, and remove", async (t) => {
  const cookie = await signUp();

  // Initially none connected.
  let res = await authed(cookie, "/api/user/credentials");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).credential, null);

  // Connect an API key (kind auto-detected).
  res = await authed(cookie, "/api/user/credentials", {
    method: "POST",
    body: JSON.stringify({ value: "sk-ant-api03-abcdefghijklmnop" })
  });
  const created = await res.json().catch(() => null);
  if (res.status === 500 && /CREDENTIAL_ENCRYPTION_KEY/.test(created?.error ?? "")) {
    t.skip("server missing CREDENTIAL_ENCRYPTION_KEY — write path not exercised");
    return;
  }
  assert.equal(res.status, 200, "connect should succeed");
  assert.equal(created.credential.kind, "api_key");
  assert.match(created.credential.masked, /\*/, "value returned masked");
  assert.ok(
    !JSON.stringify(created).includes("abcdefghijklmnop"),
    "full secret never returned"
  );

  // Replace with an OAuth token.
  res = await authed(cookie, "/api/user/credentials", {
    method: "POST",
    body: JSON.stringify({ value: "sk-ant-oat01-zyxwvutsrqponml" })
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).credential.kind, "oauth");

  // Mismatched explicit kind is rejected.
  res = await authed(cookie, "/api/user/credentials", {
    method: "POST",
    body: JSON.stringify({ kind: "api_key", value: "sk-ant-oat01-zyxwvutsrqponml" })
  });
  assert.equal(res.status, 400, "mismatched kind rejected");

  // Unrecognized value rejected.
  res = await authed(cookie, "/api/user/credentials", {
    method: "POST",
    body: JSON.stringify({ value: "not-a-real-key" })
  });
  assert.equal(res.status, 400, "bad prefix rejected");

  // Remove.
  res = await authed(cookie, "/api/user/credentials", { method: "DELETE" });
  assert.equal(res.status, 200);
  res = await authed(cookie, "/api/user/credentials");
  assert.equal((await res.json()).credential, null);
});

itLive("credential route requires auth", async () => {
  const res = await fetch(`${BASE}/api/user/credentials`);
  assert.equal(res.status, 401, "unauthenticated GET is rejected");
});
