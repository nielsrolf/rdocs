import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";
import { getCurrentUser } from "@/lib/auth";

export default async function ForgotPasswordPage() {
  if (await getCurrentUser()) {
    redirect("/dashboard");
  }

  return (
    <main className="auth-shell">
      <ForgotPasswordForm />
    </main>
  );
}
