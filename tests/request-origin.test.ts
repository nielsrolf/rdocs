import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getPublicOrigin, getRequestOrigin } from "../lib/request-origin";

const originalAppUrl = process.env.APP_URL;
const originalAllowed = process.env.ALLOWED_HOSTS;

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  if (originalAllowed === undefined) delete process.env.ALLOWED_HOSTS;
  else process.env.ALLOWED_HOSTS = originalAllowed;
});

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

test("getPublicOrigin uses canonical APP_URL even when the page is opened on localhost", () => {
  // This is the share-link bug: a user browsing localhost still expects the
  // shared link to point at the public domain.
  process.env.APP_URL = "https://docs.nielsrolf.com";
  delete process.env.ALLOWED_HOSTS;

  const origin = getPublicOrigin(headers({ host: "localhost:14141" }), "http://localhost:14141/api/share-links");

  assert.equal(origin, "https://docs.nielsrolf.com");
});

test("getPublicOrigin falls back to the request origin when APP_URL is unset", () => {
  delete process.env.APP_URL;
  delete process.env.ALLOWED_HOSTS;

  const origin = getPublicOrigin(headers({ host: "localhost:14141" }), "http://localhost:14141/api/share-links");

  assert.equal(origin, "http://localhost:14141");
});

test("getRequestOrigin keeps the user on an allow-listed host they arrived on", () => {
  // Redirect builders (sign-out) should stay on the current allow-listed host.
  process.env.APP_URL = "https://docs.nielsrolf.com";
  process.env.ALLOWED_HOSTS = "localhost:14141";

  const request = new Request("http://localhost:14141/api/auth/sign-out", {
    headers: { host: "localhost:14141", "x-forwarded-proto": "http" }
  });

  assert.equal(getRequestOrigin(request), "http://localhost:14141");
});
