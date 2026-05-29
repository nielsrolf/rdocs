import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

const clientLogSchema = z.object({
  scope: z.string().min(1).max(120),
  level: z.enum(["info", "warn", "error"]).optional(),
  message: z.string().min(1).max(2000),
  data: z.unknown().optional()
});

// Strip CR/LF so attacker-controlled strings can't forge extra log lines
// (the logs/ files are parsed by line + prefix per CLAUDE.md).
function sanitizeLogField(value: string) {
  return value.replace(/[\r\n]+/g, " ");
}

export async function POST(request: Request) {
  const user = await getCurrentUser().catch(() => null);

  // Authenticated callers get a generous per-user budget; anonymous callers
  // (e.g. share-link viewers) are throttled harder by IP. Either way the open
  // log sink can no longer be used to flood disk or poison greps.
  const limitKey = user ? `client-log:user:${user.id}` : `client-log:ip:${getClientIp(request)}`;
  const limit = rateLimit(limitKey, user ? 240 : 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = clientLogSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const level = parsed.data.level ?? "info";
  const payload = {
    scope: sanitizeLogField(parsed.data.scope),
    userId: user?.id ?? null,
    message: sanitizeLogField(parsed.data.message),
    data: parsed.data.data ?? null
  };
  const line = `[client-log:${level}] ${JSON.stringify(payload)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  return NextResponse.json({ ok: true });
}
