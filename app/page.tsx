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
          <span className="eyebrow">AI-assisted research workspace</span>
          <h1>Supervise research in a document with a linked repo beside it.</h1>
          <p>
            Draft, comment, ask Claude to investigate, and keep the resulting code or experiment
            artifacts committed back to the repository attached to the document.
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
              <li>Rich text research document editor</li>
              <li>Threaded comments with anchored selections</li>
              <li>GitHub repo linkage with checked-out AI workspaces</li>
              <li>Claude Agent SDK runs with automatic commit links</li>
              <li>Interactive embedded widgets for experiment explorers</li>
            </ul>
          </div>
          <div className="feature-card muted">
            <h2>Research loop</h2>
            <p>
              Parallel agents run in isolated Git worktrees, with progress visible from the
              document while each run works.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
