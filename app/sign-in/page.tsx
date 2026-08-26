import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

export default async function SignInPage({ searchParams }: {
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
        mode="sign-in"
        title="Sign in"
        subtitle="Open your documents and keep collaboration tied to real user accounts."
        returnTo={returnTo}
      />
    </main>
  );
}
