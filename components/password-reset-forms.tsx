"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

async function postJson(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({ error: "Unexpected server response." }));
  return { ok: response.ok, error: typeof data.error === "string" ? data.error : null };
}

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const result = await postJson("/api/auth/forgot-password", { email });
    setIsSubmitting(false);
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return;
    }
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <section className="auth-card">
        <div className="section-heading">
          <h1>Check your inbox</h1>
          <p>
            If an account exists for <strong>{sentTo}</strong>, we sent it a link to choose a new password. The
            link is valid for 1 hour. It can take a minute to arrive, and it can land in the spam folder.
          </p>
        </div>
        <p className="inline-note">
          <Link href="/sign-in">Back to sign in</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <div className="section-heading">
        <h1>Forgot your password?</h1>
        <p>Enter the email address of your account and we&apos;ll send you a link to choose a new one.</p>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          <span>Email</span>
          <input autoComplete="email" name="email" placeholder="you@example.com" required type="email" />
        </label>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <button className="primary-button wide-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Sending..." : "Send reset link"}
        </button>
      </form>
      <p className="inline-note">
        Remembered it? <Link href="/sign-in">Sign in</Link>
      </p>
    </section>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    if (password !== String(formData.get("confirm") ?? "")) {
      setError("The two passwords don't match.");
      return;
    }
    setIsSubmitting(true);
    const result = await postJson("/api/auth/reset-password", { token, password });
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      setIsSubmitting(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <section className="auth-card">
      <div className="section-heading">
        <h1>Choose a new password</h1>
        <p>You&apos;ll be signed in right away, and signed out on every other device.</p>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          <span>New password</span>
          <input autoComplete="new-password" minLength={8} name="password" placeholder="At least 8 characters" required type="password" />
        </label>
        <label>
          <span>Repeat new password</span>
          <input autoComplete="new-password" minLength={8} name="confirm" required type="password" />
        </label>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <button className="primary-button wide-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Saving..." : "Set new password"}
        </button>
      </form>
      <p className="inline-note">
        Link expired? <Link href="/forgot-password">Request a new one</Link>
      </p>
    </section>
  );
}
