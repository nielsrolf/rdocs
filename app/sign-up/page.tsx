import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";

export default async function SignUpPage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="auth-shell">
      <AuthForm
        mode="sign-up"
        title="Create account"
        subtitle="Start a workspace, invite collaborators with permissioned links, and route comment threads through Claude."
      />
    </main>
  );
}
