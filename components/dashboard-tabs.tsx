"use client";

import { useState } from "react";

import { CommentInbox, type InboxThreadView } from "@/components/comment-inbox";
import { DocumentList, type DashboardDoc } from "@/components/document-list";

type DashboardTab = "documents" | "channels" | "comments";

type DashboardTabsProps = {
  documents: DashboardDoc[];
  inboxThreads: InboxThreadView[];
  inboxTags: string[];
  initialTab?: DashboardTab;
};

export function DashboardTabs({
  documents,
  inboxThreads,
  inboxTags,
  initialTab = "documents"
}: DashboardTabsProps) {
  const [tab, setTab] = useState<DashboardTab>(initialTab);
  const channelDocs = documents.filter((d) => d.kind === "slack_channel");
  const regularDocs = documents.filter((d) => d.kind !== "slack_channel");

  return (
    <div className="dashboard-tabs">
      <div className="dashboard-tabs-bar" role="tablist">
        <button
          aria-selected={tab === "documents"}
          className={tab === "documents" ? "dashboard-tab dashboard-tab-active" : "dashboard-tab"}
          onClick={() => setTab("documents")}
          role="tab"
          type="button"
        >
          Documents
        </button>
        <button
          aria-selected={tab === "channels"}
          className={tab === "channels" ? "dashboard-tab dashboard-tab-active" : "dashboard-tab"}
          onClick={() => setTab("channels")}
          role="tab"
          type="button"
        >
          Slack channels
        </button>
        <button
          aria-selected={tab === "comments"}
          className={tab === "comments" ? "dashboard-tab dashboard-tab-active" : "dashboard-tab"}
          onClick={() => setTab("comments")}
          role="tab"
          type="button"
        >
          Comments
        </button>
      </div>

      {tab === "documents" ? (
        <DocumentList documents={regularDocs} />
      ) : tab === "channels" ? (
        channelDocs.length > 0 ? (
          <>
            <p className="channels-tab-note">
              Each Slack conversation where claudex runs gets a workspace here. Open one to configure
              the bot for that channel (model, skills, environment), review its run history, or pin
              shared context in the notebook body — the agent reads it on every run.
            </p>
            <DocumentList documents={channelDocs} />
          </>
        ) : (
          <section className="surface-card slack-onboarding">
            <h2>Use claudex in Slack</h2>
            <p>
              claudex is this workspace&apos;s agent as a Slack bot: mention it in a channel or send
              it a DM, and it runs with <strong>your</strong> credentials and replies in the thread.
            </p>
            <ol>
              <li>
                Invite <code>@claudex</code> to a Slack channel (or just open a DM with it).
              </li>
              <li>
                Send it a message. The first time, it replies with a <em>connect link</em> — open
                it while signed in here to link your Slack identity to this account.
              </li>
              <li>Message it again: 👀 means it&apos;s working, and the reply lands in the thread.</li>
            </ol>
            <h3>How it works</h3>
            <ul>
              <li>
                <strong>One channel → one workspace.</strong> Every channel (and your DM) gets a
                document here: agent settings (model, skills, environment variables) configure the
                bot for that channel, runs appear in its agent panel, and the document body is a
                shared notebook the agent reads on every run.
              </li>
              <li>
                <strong>Runs as you.</strong> When you trigger claudex, it uses your connected
                credentials (AI provider, GitHub) plus the channel&apos;s environment — teammates
                trigger it with theirs.
              </li>
              <li>
                <strong>DMs are your overview agent.</strong> In a direct message, claudex can see
                recent agent activity across all documents and channels you have access to — ask it
                &quot;what&apos;s been going on?&quot;. It also takes voice messages (with an OpenAI
                key connected) and can schedule recurring tasks.
              </li>
              <li>
                <strong>In-thread controls.</strong> One thread is one conversation; reply in the
                thread to continue it, send &quot;wait&quot; to stop a running task.
              </li>
            </ul>
            <p className="channels-tab-note">
              Once you link your account and message claudex, its channels appear in this tab.
            </p>
          </section>
        )
      ) : (
        <CommentInbox initialThreads={inboxThreads} allTags={inboxTags} />
      )}
    </div>
  );
}
