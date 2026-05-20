import { NextResponse } from "next/server";

import { clearSessionCookie } from "@/lib/auth";
import { getRequestOrigin } from "@/lib/request-origin";

export async function POST(request: Request) {
  await clearSessionCookie();

  if (request.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ ok: true });
  }

  return NextResponse.redirect(new URL("/", getRequestOrigin(request)));
}
