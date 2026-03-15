import type { Metadata } from "next";
import Link from "next/link";

import "@/app/globals.css";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "GDocs AI",
  description: "A collaborative document editor with comments, share links, and AI-assisted replies."
};

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();

  return (
    <html lang="en">
      <body>
        <div className="app-frame">
          <header className="topbar">
            <Link href="/" className="brand">
              GDocs AI
            </Link>
            <nav className="topbar-nav">
              {user ? (
                <>
                  <Link href="/dashboard" className="ghost-button">
                    Dashboard
                  </Link>
                  <span className="user-chip">{user.name}</span>
                  <form action="/api/auth/sign-out" method="post">
                    <button className="ghost-button" type="submit">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/sign-in" className="ghost-button">
                    Sign in
                  </Link>
                  <Link href="/sign-up" className="primary-button">
                    Create account
                  </Link>
                </>
              )}
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
