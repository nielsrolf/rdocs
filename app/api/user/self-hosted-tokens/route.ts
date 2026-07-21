import { NextResponse } from "next/server";
import { z } from "zod";

import { createApiToken, listApiTokens, revokeApiToken } from "@/lib/api-tokens";
import { getCurrentUser } from "@/lib/auth";
import { getPublicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

// Self-hosted runner worker tokens ("Self-hosted setup" panel in document
// settings). Reuses the exact same ApiToken store as "Connect via MCP" — the
// token is a plain personal bearer credential either way — just labeled and
// surfaced with a docker one-liner suited to a poll-loop worker instead of an
// MCP client. One worker process can serve every "selfHosted" document the
// user owns; it polls /api/self-hosted/jobs/claim and posts to
// /api/self-hosted/jobs/:id/result with the same token.
//
// NOTE: the docker image itself is NOT built yet — see
// runner/self-hosted/README.md. The command below documents the intended
// interface for when it exists.

function buildRunCommand(origin: string, token: string) {
  // Env names must match runner/self-hosted/worker.ts. The published image is
  // overridable for forks/staging via SELF_HOSTED_WORKER_IMAGE.
  const image = process.env.SELF_HOSTED_WORKER_IMAGE?.trim() || "nielsrolf/rdocs-worker:latest";
  return [
    `docker run -d --restart unless-stopped --name rdocs-worker \\`,
    `  -e APP_URL=${origin} \\`,
    `  -e SELF_HOSTED_TOKEN=${token} \\`,
    `  -e ANTHROPIC_API_KEY=sk-ant-your-key \\`,
    `  ${image}`
  ].join("\n");
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  return NextResponse.json({ tokens: await listApiTokens(user.id) });
}

const createSchema = z.object({ label: z.string().max(120).optional() });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const { token, record } = await createApiToken(
    user.id,
    parsed.data.label?.trim() || "self-hosted runner"
  );
  const origin = getPublicOrigin(request.headers);
  return NextResponse.json({
    token,
    command: buildRunCommand(origin, token),
    record,
    tokens: await listApiTokens(user.id)
  });
}

const deleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }
  const revoked = await revokeApiToken(user.id, parsed.data.id);
  if (!revoked) {
    return NextResponse.json({ error: "Token not found." }, { status: 404 });
  }
  return NextResponse.json({ tokens: await listApiTokens(user.id) });
}
