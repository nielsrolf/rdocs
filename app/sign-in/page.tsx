import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

export default async function SignInPage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="auth-shell">
      <AuthForm
        mode="sign-in"
        title="Sign in"
        subtitle="Open your documents and keep collaboration tied to real user accounts."
      />
    </main>
  );
}
