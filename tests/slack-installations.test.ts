import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { db } from "../lib/db";
import { notifyCommentPosted } from "../lib/comment-notifications";
import {
  exchangeSlackOAuthCode,
  listSlackInstallations,
  parseSlackOAuthAccess,
  removeSlackInstallation,
  saveSlackInstallation,
  slackInstallationForTeam,
  slackOAuthAuthorizeUrl,
  slackTeamContext,
  SLACK_BOT_SCOPES
} from "../lib/slack/installations";
import { createSlackInstallStateToken, verifySlackInstallStateToken } from "../lib/slack/link-token";
import { isEncryptedSecret } from "../lib/secret-crypto";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.CREDENTIAL_ENCRYPTION_KEY =
  process.env.CREDENTIAL_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
// The .env workspace must not leak into these tests.
delete process.env.SLACK_BOT_TOKEN;

const teamA = `T-A-${crypto.randomUUID().slice(0, 8)}`;
const teamB = `T-B-${crypto.randomUUID().slice(0, 8)}`;

test.after(async () => {
  await removeSlackInstallation(teamA);
  await removeSlackInstallation(teamB);
  await db.$disconnect();
});

test("an OAuth installation is stored encrypted and resolved per team", async () => {
  const saved = await saveSlackInstallation({
    teamId: teamA,
    teamName: "Acme",
    botToken: "xoxb-acme-secret",
    botUserId: "UBOT-A"
  });
  assert.equal(saved.botToken, "xoxb-acme-secret");
  assert.equal(saved.source, "oauth");

  const row = await db.slackInstallation.findUnique({ where: { teamId: teamA } });
  assert.ok(row && isEncryptedSecret(row.botToken), "bot token is encrypted at rest");
  assert.notEqual(row?.botToken, "xoxb-acme-secret");

  const resolved = await slackInstallationForTeam(teamA);
  assert.equal(resolved?.botToken, "xoxb-acme-secret");
  assert.equal(resolved?.botUserId, "UBOT-A");
  assert.equal(await slackInstallationForTeam("T-nobody"), null);

  const context = await slackTeamContext(teamA);
  assert.equal(context?.botUserId, "UBOT-A");
  assert.equal(await slackTeamContext("T-nobody"), null);

  // Re-installing (token rotation) overwrites, never duplicates.
  await saveSlackInstallation({ teamId: teamA, botToken: "xoxb-acme-rotated", botUserId: "UBOT-A2" });
  assert.equal((await slackInstallationForTeam(teamA))?.botToken, "xoxb-acme-rotated");
  const all = await listSlackInstallations();
  assert.equal(all.filter((installation) => installation.teamId === teamA).length, 1);
});

test("comment notifications DM each recipient through their own workspace's bot", async () => {
  await saveSlackInstallation({ teamId: teamB, botToken: "xoxb-b", botUserId: "UBOT-B" });
  const suffix = crypto.randomUUID().slice(0, 8);
  const author = await db.user.create({
    data: { email: `inst-author-${suffix}@example.com`, name: "Author", passwordHash: "x" }
  });
  // Recipient in an installed workspace and one in a workspace with no installation.
  const inTeamB = await db.user.create({
    data: {
      email: `inst-b-${suffix}@example.com`,
      name: "B",
      passwordHash: "x",
      commentNotificationScope: "all",
      slackLinks: { create: { slackTeamId: teamB, slackUserId: `U-${suffix}-b` } }
    }
  });
  const inUnknownTeam = await db.user.create({
    data: {
      email: `inst-x-${suffix}@example.com`,
      name: "X",
      passwordHash: "x",
      commentNotificationScope: "all",
      slackLinks: { create: { slackTeamId: `T-none-${suffix}`, slackUserId: `U-${suffix}-x` } }
    }
  });
  const document = await db.document.create({
    data: {
      title: "Installations",
      content: JSON.stringify({ type: "doc", content: [] }),
      ownerId: author.id,
      memberships: {
        create: [
          { userId: inTeamB.id, permission: "EDIT" },
          { userId: inUnknownTeam.id, permission: "EDIT" }
        ]
      }
    }
  });
  const thread = await db.commentThread.create({
    data: { documentId: document.id, anchorText: "x", createdById: author.id }
  });
  try {
    // Slack delivery is short-circuited under the test runner, so a resolved
    // team yields a successful (silent) post; a team without an installation is
    // skipped rather than failing the dispatch.
    const result = await notifyCommentPosted({
      threadId: thread.id,
      documentId: document.id,
      commentBody: "hello",
      authorLabel: "Author",
      excludeUserIds: [author.id]
    });
    assert.equal(result.notified, 1);
  } finally {
    await db.document.delete({ where: { id: document.id } });
    await db.user.deleteMany({ where: { id: { in: [author.id, inTeamB.id, inUnknownTeam.id] } } });
  }
});

test("oauth.v2.access payloads are validated before anything is stored", () => {
  assert.equal(parseSlackOAuthAccess(null), null);
  assert.equal(parseSlackOAuthAccess({ ok: false, error: "invalid_code" }), null);
  assert.equal(parseSlackOAuthAccess({ ok: true, access_token: "xoxb", team: { id: "T1" } }), null, "needs bot_user_id");
  assert.equal(
    parseSlackOAuthAccess({ ok: true, access_token: "xoxp", token_type: "user", bot_user_id: "U", team: { id: "T1" } }),
    null,
    "user-token installs are rejected"
  );
  assert.deepEqual(
    parseSlackOAuthAccess({
      ok: true,
      access_token: "xoxb-1",
      token_type: "bot",
      bot_user_id: "UB",
      team: { id: "T1", name: "One" }
    }),
    { teamId: "T1", teamName: "One", botToken: "xoxb-1", botUserId: "UB" }
  );
});

test("the code exchange posts client credentials + redirect_uri and surfaces Slack errors", async () => {
  const config = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://docs.example/api/slack/oauth/callback" };
  let seenBody: URLSearchParams | null = null;
  const okFetch: typeof fetch = async (_url, init) => {
    seenBody = init?.body as URLSearchParams;
    return new Response(
      JSON.stringify({ ok: true, access_token: "xoxb-2", token_type: "bot", bot_user_id: "UB", team: { id: "T2", name: "Two" } }),
      { headers: { "Content-Type": "application/json" } }
    );
  };
  const result = await exchangeSlackOAuthCode(config, "the-code", okFetch);
  assert.equal(result.teamId, "T2");
  assert.equal(seenBody!.get("client_id"), "cid");
  assert.equal(seenBody!.get("client_secret"), "csecret");
  assert.equal(seenBody!.get("code"), "the-code");
  assert.equal(seenBody!.get("redirect_uri"), config.redirectUri);

  const badFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { headers: { "Content-Type": "application/json" } });
  await assert.rejects(() => exchangeSlackOAuthCode(config, "bad", badFetch), /invalid_code/);
});

test("the authorize URL requests exactly the bot scopes and the install state is bound to a user", async () => {
  const url = new URL(slackOAuthAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/cb" }, "state-1"));
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.deepEqual(url.searchParams.get("scope")?.split(","), [...SLACK_BOT_SCOPES]);

  const token = await createSlackInstallStateToken({ userId: "user-1" });
  assert.deepEqual(await verifySlackInstallStateToken(token), { userId: "user-1" });
  assert.equal(await verifySlackInstallStateToken("garbage"), null);
});
