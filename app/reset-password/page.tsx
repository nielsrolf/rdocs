import { ResetPasswordForm } from "@/components/password-reset-forms";

// Deliberately does not redirect signed-in users: the link may be opened in a
// browser that is still signed in (possibly as someone else), and the reset
// replaces that session anyway. The token is only checked on submit, so mail
// scanners that prefetch the link cannot use it up.
export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";

  return (
    <main className="auth-shell">
      <ResetPasswordForm token={token} />
    </main>
  );
}
