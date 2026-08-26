"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type AuthFormProps = {
  mode: "sign-in" | "sign-up";
  title: string;
  subtitle: string;
  returnTo?: string;
};

export function AuthForm({ mode, title, subtitle, returnTo = "/dashboard" }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
            password: String(formData.get("password") ?? "")
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
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <button className="primary-button wide-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Working..." : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
      </form>
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
