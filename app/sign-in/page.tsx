import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

// ?notice= values set by redirects from the email-link routes.
const SIGN_IN_NOTICES: Record<string, string> = {
  "verify-invalid": "That confirmation link has expired or was replaced by a newer one. Sign in to get a new link."
};

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ next?: string; notice?: string }>;
}) {
  const user = await getCurrentUser();
  const params = await searchParams;
  const requested = params.next || "/dashboard";
  const returnTo = requested.startsWith("/") && !requested.startsWith("//")
    ? requested : "/dashboard";

  if (user) {
    redirect(returnTo);
  }

  return (
    <main className="auth-shell">
      <AuthForm
        mode="sign-in"
        title="Sign in"
        subtitle="Open your documents and keep collaboration tied to real user accounts."
        returnTo={returnTo}
        notice={params.notice ? SIGN_IN_NOTICES[params.notice] ?? null : null}
      />
    </main>
  );
}
