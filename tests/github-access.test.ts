import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  acceptPendingRepoInvitation,
  checkRepoAccess,
  getGithubRepoFullName,
  resetGithubAccessCacheForTests,
  resolveGithubIdentity
} from "../lib/github-access";

type FakeRoute = {
  match: (url: string, init?: RequestInit) => boolean;
  status: number;
  body?: unknown;
};

function fakeFetch(routes: FakeRoute[], calls: Array<{ url: string; method: string }> = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status
    });
  }) as typeof fetch;
}

const userRoute: FakeRoute = {
  match: (url) => url.endsWith("/user"),
  status: 200,
  body: { login: "some-user", id: 12345 }
};

const TOKEN = "ghp_test-token";

beforeEach(() => {
  resetGithubAccessCacheForTests();
});

test("getGithubRepoFullName parses GitHub URL shapes", () => {
  assert.equal(getGithubRepoFullName("https://github.com/foo/bar"), "foo/bar");
  assert.equal(getGithubRepoFullName("https://github.com/foo/bar.git"), "foo/bar");
  assert.equal(getGithubRepoFullName("https://github.com/foo/bar/"), "foo/bar");
  assert.equal(getGithubRepoFullName("https://github.com/foo/bar.baz"), "foo/bar.baz");
  assert.equal(getGithubRepoFullName("git@github.com:foo/bar.git"), "foo/bar");
  assert.equal(getGithubRepoFullName("git@github.com:foo/bar"), "foo/bar");
  assert.equal(getGithubRepoFullName("https://huggingface.co/datasets/foo/bar"), null);
  assert.equal(getGithubRepoFullName("not a url"), null);
  assert.equal(getGithubRepoFullName(null), null);
});

test("resolveGithubIdentity caches per token and returns null without one", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = fakeFetch([userRoute], calls);
  assert.equal(await resolveGithubIdentity(null, fetchImpl), null);
  assert.deepEqual(await resolveGithubIdentity(TOKEN, fetchImpl), { login: "some-user", id: 12345 });
  await resolveGithubIdentity(TOKEN, fetchImpl);
  assert.equal(calls.length, 1, "second lookup must hit the cache");
});

test("checkRepoAccess reports ok for an accessible repo", async () => {
  const fetchImpl = fakeFetch([
    userRoute,
    {
      match: (url) => url.endsWith("/repos/foo/bar"),
      status: 200,
      body: { permissions: { push: true } }
    }
  ]);

  const result = await checkRepoAccess("https://github.com/foo/bar", TOKEN, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.login, "some-user");
  assert.equal(result.canPush, true);
  assert.equal(result.acceptedInvitation, false);
  assert.equal(result.reason, "ok");
});

test("checkRepoAccess works anonymously (public repo, no token)", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = fakeFetch(
    [{ match: (url) => url.endsWith("/repos/foo/public"), status: 200, body: {} }],
    calls
  );

  const result = await checkRepoAccess("https://github.com/foo/public", null, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.login, null);
  // Without a token there is nothing to accept invitations with.
  assert.equal(calls.some((c) => c.url.includes("repository_invitations")), false);
});

test("checkRepoAccess accepts a matching pending invitation and re-checks", async () => {
  let repoChecks = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = fakeFetch(
    [
      userRoute,
      {
        // First repo check misses (invite not yet accepted), second one hits.
        match: (url) => url.endsWith("/repos/foo/private-repo") && ++repoChecks === 1,
        status: 404
      },
      {
        match: (url) => url.endsWith("/repos/foo/private-repo"),
        status: 200,
        body: { permissions: { push: true } }
      },
      {
        match: (url, init) => url.includes("/user/repository_invitations?") && !init?.method,
        status: 200,
        body: [
          { id: 1, repository: { full_name: "someone/else" } },
          { id: 2, repository: { full_name: "Foo/Private-Repo" } }
        ]
      },
      {
        match: (url, init) =>
          url.endsWith("/user/repository_invitations/2") && init?.method === "PATCH",
        status: 204
      }
    ],
    calls
  );

  const result = await checkRepoAccess("https://github.com/foo/private-repo", TOKEN, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.acceptedInvitation, true);
  assert.equal(result.reason, "ok");
  // Only the matching invitation may be touched.
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.ok(patches[0].url.endsWith("/user/repository_invitations/2"));
});

test("checkRepoAccess reports no-access when there is no pending invitation", async () => {
  const fetchImpl = fakeFetch([
    userRoute,
    { match: (url) => url.endsWith("/repos/foo/hidden"), status: 404 },
    {
      match: (url, init) => url.includes("/user/repository_invitations?") && !init?.method,
      status: 200,
      body: []
    }
  ]);

  const result = await checkRepoAccess("https://github.com/foo/hidden", TOKEN, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-access");
  assert.equal(result.login, "some-user");
  assert.equal(result.acceptedInvitation, false);
});

test("checkRepoAccess skips non-GitHub URLs", async () => {
  const fetchImpl = fakeFetch([]);
  const result = await checkRepoAccess("https://huggingface.co/datasets/foo/bar", TOKEN, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "not-github");
});

test("acceptPendingRepoInvitation ignores non-matching invitations", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = fakeFetch(
    [
      {
        match: (url, init) => url.includes("/user/repository_invitations?") && !init?.method,
        status: 200,
        body: [{ id: 7, repository: { full_name: "someone/else" } }]
      }
    ],
    calls
  );

  const accepted = await acceptPendingRepoInvitation("foo/bar", TOKEN, fetchImpl);
  assert.equal(accepted, false);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("acceptPendingRepoInvitation does nothing without a token", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const accepted = await acceptPendingRepoInvitation("foo/bar", null, fakeFetch([], calls));
  assert.equal(accepted, false);
  assert.equal(calls.length, 0);
});
