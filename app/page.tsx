import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";

export default async function HomePage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="marketing-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Collaborative writing with AI in the loop</span>
          <h1>Write together, comment together, ask Claude inside every thread.</h1>
          <p>
            This MVP gives you a Google Docs-style editor, threaded comments, permissioned share
            links, and an AI button in each thread so Claude can jump into the discussion.
          </p>
          <div className="hero-actions">
            <Link href="/sign-up" className="primary-button">
              Create your workspace
            </Link>
            <Link href="/sign-in" className="ghost-button">
              Sign in
            </Link>
          </div>
        </div>
        <div className="hero-panel">
          <div className="feature-card">
            <h2>Included now</h2>
            <ul>
              <li>Rich text document editor</li>
              <li>Threaded comments with anchored selections</li>
              <li>Share links with view, comment, and edit permissions</li>
              <li>Claude-powered comment replies via `localrouter`</li>
            </ul>
          </div>
          <div className="feature-card muted">
            <h2>Prepared next</h2>
            <p>
              The codebase is structured so you can add AI rewrite-on-selection flows without
              reworking auth, permissions, or document persistence.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
