import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { integrationSigninEnabled, parseRedirectUri } from "@/lib/integration-signin";

// Consent page for "Sign in with r-docs" (see lib/integration-signin.ts). The
// form posts to /api/authorize, which issues the id token and redirects back.
export default async function AuthorizePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const get = (key: string) => typeof query[key] === "string" ? query[key] as string : "";
  const user = await getCurrentUser();
  if (!user) {
    const params = new URLSearchParams();
    for (const key of ["redirect_uri", "state"]) if (get(key)) params.set(key, get(key));
    redirect(`/sign-in?next=${encodeURIComponent(`/authorize?${params}`)}`);
  }
  const redirectUri = integrationSigninEnabled() ? parseRedirectUri(get("redirect_uri")) : null;
  return (
    <main className="auth-shell">
      <section className="auth-card">
        {redirectUri ? (
          <form method="post" action="/api/authorize">
            <h1>Continue to {redirectUri.host}?</h1>
            <p>
              <strong>{redirectUri.origin}</strong> will learn your name and email address
              ({user!.name}, {user!.email}) so it can sign you in. It does not get access to your documents.
            </p>
            <input type="hidden" name="redirect_uri" value={redirectUri.toString()} />
            <input type="hidden" name="state" value={get("state")} />
            <button type="submit" className="primary">Continue as {user!.name}</button>
          </form>
        ) : (
          <>
            <h1>Sign-in request not allowed</h1>
            <p>This site is not on the list of integrations that may sign users in with r-docs.</p>
          </>
        )}
      </section>
    </main>
  );
}
