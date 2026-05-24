import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";

const clientLogSchema = z.object({
  scope: z.string().min(1).max(120),
  level: z.enum(["info", "warn", "error"]).optional(),
  message: z.string().min(1).max(2000),
  data: z.unknown().optional()
});

export async function POST(request: Request) {
  const user = await getCurrentUser().catch(() => null);
  const body = await request.json().catch(() => null);
  const parsed = clientLogSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const level = parsed.data.level ?? "info";
  const payload = {
    scope: parsed.data.scope,
    userId: user?.id ?? null,
    message: parsed.data.message,
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
