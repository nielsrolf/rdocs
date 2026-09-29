import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

export default async function SignUpPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  const requested = (await searchParams).next || "/dashboard";
  const returnTo = requested.startsWith("/") && !requested.startsWith("//")
    ? requested : "/dashboard";

  if (user) {
    redirect(returnTo);
  }

  return (
    <main className="auth-shell">
      <AuthForm
        mode="sign-up"
        returnTo={returnTo}
        title="Create account"
        subtitle="Start a workspace, invite collaborators with permissioned links, and route comment threads through Claude."
      />
    </main>
  );
}
