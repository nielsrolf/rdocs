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
        {channelDocs.length > 0 ? (
          <button
            aria-selected={tab === "channels"}
            className={tab === "channels" ? "dashboard-tab dashboard-tab-active" : "dashboard-tab"}
            onClick={() => setTab("channels")}
            role="tab"
            type="button"
          >
            Slack channels
          </button>
        ) : null}
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
        <>
          <p className="channels-tab-note">
            Each Slack conversation where claudex runs gets a workspace here. Open one to configure
            the bot for that channel (model, skills, environment), review its run history, or pin
            shared context in the notebook body — the agent reads it on every run.
          </p>
          <DocumentList documents={channelDocs} />
        </>
      ) : (
        <CommentInbox initialThreads={inboxThreads} allTags={inboxTags} />
      )}
    </div>
  );
}
