import { NextResponse } from "next/server";

import { tokenMatchesPassword, verifyVerificationToken } from "@/lib/account-email";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPublicOrigin } from "@/lib/request-origin";

// Target of the link in the confirmation email. Confirms the address, signs
// the user in and forwards them to where they were headed at sign-up.
export async function GET(request: Request) {
  const origin = getPublicOrigin(request.headers, request.url);
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const claims = await verifyVerificationToken(token);

  const user = claims
    ? await db.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true, passwordHash: true, emailVerificationPending: true }
      })
    : null;

  if (!claims || !user || user.email !== claims.email || !tokenMatchesPassword(claims.fingerprint, user.passwordHash)) {
    return NextResponse.redirect(`${origin}/sign-in?notice=verify-invalid`, 303);
  }

  if (user.emailVerificationPending) {
    await db.user.update({ where: { id: user.id }, data: { emailVerificationPending: false } });
  }

  await setSessionCookie(await createSessionToken(user.id));
  return NextResponse.redirect(`${origin}${claims.returnTo}`, 303);
}
