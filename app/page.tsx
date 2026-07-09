import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";

function RepoGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="5.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.3v5.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11.5 7.3c0 2.6-2.6 3.1-5 3.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CommentGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6a1.7 1.7 0 0 1 1.7 1.7v5.1a1.7 1.7 0 0 1-1.7 1.7H7.4l-3.1 2.5v-2.5h-.1a1.7 1.7 0 0 1-1.7-1.7z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ParallelGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2.6" width="9" height="2.4" rx="1.2" fill="currentColor" />
      <rect x="2" y="6.8" width="12" height="2.4" rx="1.2" fill="currentColor" opacity="0.7" />
      <rect x="2" y="11" width="6.5" height="2.4" rx="1.2" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

export default async function HomePage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="marketing-shell landing">
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <span className="eyebrow">Docs + repos + agents</span>
          <h1>
            Google Docs,
            <br />
            meet <span className="lp-accent">Claude Code</span>.
          </h1>
          <p className="lp-lede">
            r-docs links every document to a repository and puts coding agents in the collaborator
            list. Brainstorm with your team in a familiar editor, then kick off agents that comment
            on the doc, edit it, and commit the work — while you oversee every run from the page.
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

        <div className="lp-visual" aria-hidden="true">
          <div className="lp-doc-card">
            <div className="lp-doc-titlebar">
              <span className="lp-doc-title">Rate limiting — rollout plan</span>
              <span className="lp-repo-chip">
                <RepoGlyph />
                acme/api
              </span>
            </div>
            <div className="lp-doc-body">
              <p className="lp-doc-h">Decision</p>
              <p>
                We start with the public API.{" "}
                <span className="lp-doc-selection">
                  Ship a token-bucket limiter with per-key quotas
                </span>
                , then extend to webhooks once the dashboards confirm headroom.
              </p>
              <p className="lp-doc-h">Open questions</p>
              <p>Do burst allowances need to differ for enterprise keys?</p>
            </div>
            <div className="lp-comment-card">
              <div className="lp-comment-head">
                <span className="lp-avatar">AI</span>
                <span className="lp-comment-author">Claude · agent</span>
              </div>
              <p>Implemented the token-bucket limiter and updated the load tests.</p>
              <span className="lp-commit-chip">✓ 3 files committed</span>
            </div>
          </div>

          <div className="lp-runs-card">
            <div className="lp-runs-head">Agent runs</div>
            <div className="lp-run-row">
              <span className="lp-run-dot running" />
              <span className="lp-run-label">Benchmark burst limits</span>
              <span className="lp-run-status">running</span>
            </div>
            <div className="lp-run-row">
              <span className="lp-run-dot running" />
              <span className="lp-run-label">Draft webhook section</span>
              <span className="lp-run-status">running</span>
            </div>
            <div className="lp-run-row">
              <span className="lp-run-dot done" />
              <span className="lp-run-label">Reply to Sam&rsquo;s thread</span>
              <span className="lp-run-status">commented</span>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-features">
        <div className="lp-feature">
          <span className="lp-feature-icon">
            <RepoGlyph />
          </span>
          <h2>Link docs to repos</h2>
          <p>
            Attach a GitHub repository to any document. Start by brainstorming with your
            colleagues, then kick off agents to execute the work — every run lands as commits on
            the linked repo.
          </p>
        </div>
        <div className="lp-feature">
          <span className="lp-feature-icon">
            <CommentGlyph />
          </span>
          <h2>Agents that collaborate like people</h2>
          <p>
            Agents don&rsquo;t live in a sidebar chat. They reply in comment threads, edit the doc
            directly, and anchor their results — plots, widgets, diffs — right where the discussion
            happened.
          </p>
        </div>
        <div className="lp-feature">
          <span className="lp-feature-icon">
            <ParallelGlyph />
          </span>
          <h2>Oversee many agents at once</h2>
          <p>
            Braindump prompts as fast as you think. Each agent works in an isolated git worktree,
            and the progress of every parallel run is visible without leaving the document.
          </p>
        </div>
      </section>

      <section className="lp-flow">
        <div className="lp-flow-step">
          <span className="lp-flow-num">1</span>
          <div>
            <h3>Brainstorm</h3>
            <p>Draft together in a rich-text editor with threaded, anchored comments.</p>
          </div>
        </div>
        <div className="lp-flow-step">
          <span className="lp-flow-num">2</span>
          <div>
            <h3>Kick off agents</h3>
            <p>Select text or open a thread and hand the task to an agent — or several.</p>
          </div>
        </div>
        <div className="lp-flow-step">
          <span className="lp-flow-num">3</span>
          <div>
            <h3>Review &amp; merge</h3>
            <p>Edits, comments, and widgets come back to the doc; code lands on the repo.</p>
          </div>
        </div>
      </section>

      <section className="lp-cta">
        <h2>Start writing. The agents are ready.</h2>
        <Link href="/sign-up" className="primary-button">
          Create your workspace
        </Link>
      </section>
    </main>
  );
}
