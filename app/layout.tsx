import type { Metadata, Viewport } from "next";
import Link from "next/link";

import "@/app/globals.css";
import "katex/dist/katex.min.css";
import { BrandMark } from "@/components/brand-mark";
import { ChunkReloadRecovery } from "@/components/chunk-reload-recovery";
import { UserCredentialMenu } from "@/components/user-credential-menu";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "r-docs",
  description:
    "Google Docs meets Claude Code: collaborative documents linked to repositories, where humans and AI agents write, comment, and commit together."
};

export const viewport: Viewport = {
  themeColor: "#1a73e8",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
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
        <ChunkReloadRecovery />
        <div className="app-frame">
          <header className="topbar">
            <Link href="/" className="brand">
              <BrandMark />
              <span>r-docs</span>
            </Link>
            <nav className="topbar-nav">
              {user ? (
                <>
                  <span className="user-chip">{user.name}</span>
                  <UserCredentialMenu />
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
