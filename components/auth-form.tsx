"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type AuthFormProps = {
  mode: "sign-in" | "sign-up";
  title: string;
  subtitle: string;
  returnTo?: string;
  notice?: string | null;
};

export function AuthForm({ mode, title, subtitle, returnTo = "/dashboard", notice = null }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Set once the server says this address still has to be confirmed: after
  // sign-up, or on signing in to an unconfirmed account.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  async function resendVerification() {
    if (!pendingEmail) return;
    setError(null);
    setResendState("sending");
    const response = await fetch("/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pendingEmail, returnTo })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error ?? "The email could not be sent.");
      setResendState("idle");
      return;
    }
    setResendState("sent");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const payload =
      mode === "sign-up"
        ? {
            name: String(formData.get("name") ?? ""),
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
            returnTo
          }
        : {
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? "")
          };

    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({ error: "Unexpected server response." }));

    if (data.needsVerification) {
      setPendingEmail(String(payload.email).toLowerCase());
      setResendState("idle");
      setIsSubmitting(false);
      if (response.ok) return;
    }

    if (!response.ok) {
      setError(data.error ?? "Authentication failed.");
      setIsSubmitting(false);
      return;
    }

    // Preserve a one-time credential carried in the URL fragment. Fragments are
    // never sent to either server, but browser-driven setup flows need it after
    // authentication.
    router.push(`${returnTo}${window.location.hash || ""}`);
    router.refresh();
  }

  if (pendingEmail && mode === "sign-up") {
    return (
      <section className="auth-card">
        <div className="section-heading">
          <h1>Check your inbox</h1>
          <p>
            We sent a confirmation link to <strong>{pendingEmail}</strong>. Open it to finish creating your
            account — it may take a minute, and it can land in the spam folder.
          </p>
        </div>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <button className="ghost-button wide-button" disabled={resendState !== "idle"} onClick={resendVerification} type="button">
          {resendState === "sending" ? "Sending..." : resendState === "sent" ? "Sent — check your inbox" : "Resend email"}
        </button>
        <p className="inline-note">
          Wrong address?{" "}
          <button className="link-button" onClick={() => setPendingEmail(null)} type="button">Sign up again</button>
        </p>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <div className="section-heading">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        {mode === "sign-up" && (
          <label>
            <span>Name</span>
            <input autoComplete="name" name="name" placeholder="Ada Lovelace" required type="text" />
          </label>
        )}
        <label>
          <span>Email</span>
          <input autoComplete="email" name="email" placeholder="you@example.com" required type="email" />
        </label>
        <label>
          <span>Password</span>
          <input
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            minLength={8}
            name="password"
            placeholder="At least 8 characters"
            required
            type="password"
          />
        </label>
        {notice && !error ? <div className="inline-note" role="status">{notice}</div> : null}
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {pendingEmail && mode === "sign-in" ? (
          <button className="ghost-button wide-button" disabled={resendState !== "idle"} onClick={resendVerification} type="button">
            {resendState === "sending" ? "Sending..." : resendState === "sent" ? "Sent — check your inbox" : "Resend confirmation email"}
          </button>
        ) : null}
        <button className="primary-button wide-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Working..." : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
      </form>
      {mode === "sign-in" ? (
        <p className="inline-note">
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
      ) : null}
      <p className="inline-note">
        {mode === "sign-up" ? "Already have an account?" : "Need an account?"}{" "}
        <Link href={`${mode === "sign-up" ? "/sign-in" : "/sign-up"}${
          returnTo === "/dashboard" ? "" : `?next=${encodeURIComponent(returnTo)}`
        }`}>
          {mode === "sign-up" ? "Sign in" : "Create one"}
        </Link>
      </p>
    </section>
  );
}
