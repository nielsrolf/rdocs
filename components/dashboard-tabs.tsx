"use client";

import { useState } from "react";

import { CommentInbox, type InboxThreadView } from "@/components/comment-inbox";
import { DocumentList, type DashboardDoc } from "@/components/document-list";

type DashboardTabsProps = {
  documents: DashboardDoc[];
  inboxThreads: InboxThreadView[];
  inboxTags: string[];
  initialTab?: "documents" | "comments";
};

export function DashboardTabs({
  documents,
  inboxThreads,
  inboxTags,
  initialTab = "documents"
}: DashboardTabsProps) {
  const [tab, setTab] = useState<"documents" | "comments">(initialTab);

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
        <DocumentList documents={documents} />
      ) : (
        <CommentInbox initialThreads={inboxThreads} allTags={inboxTags} />
      )}
    </div>
  );
}
