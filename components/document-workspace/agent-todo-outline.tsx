"use client";

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import { buildTodoOutline, todoStatusMark } from "./todo-outline";
import type { AiRunEventView } from "./types";

/**
 * Session plan rail: every todo the agent wrote during the conversation, with
 * its status as of now and the step it is currently on. Clicking a todo scrolls
 * the timeline to the TodoWrite event where that status was reached.
 */
export function AgentTodoOutline({ events }: { events: AiRunEventView[] }) {
  const outline = useMemo(() => buildTodoOutline(events), [events]);
  const [collapsed, setCollapsed] = useState(false);

  if (outline.items.length === 0) return null;

  const scrollTo = (eventId: string) => {
    if (typeof document === "undefined") return;
    const target = document.querySelector(`[data-agent-event-id="${CSS.escape(eventId)}"]`);
    if (!(target instanceof HTMLElement)) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("agent-event-flash");
    window.setTimeout(() => target.classList.remove("agent-event-flash"), 1200);
  };

  return (
    <aside className={cn("agent-plan", collapsed && "agent-plan-collapsed")} aria-label="Agent plan">
      <div className="agent-plan-header">
        <button
          aria-expanded={!collapsed}
          className="agent-plan-toggle"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Show plan" : "Hide plan"}
          type="button"
        >
          <span className="agent-plan-title">Plan</span>
          <span className="agent-plan-count">
            {outline.done}/{outline.items.length}
          </span>
        </button>
      </div>
      {collapsed ? null : (
        <ol className="agent-plan-list">
          {outline.items.map((item) => (
            <li key={item.key}>
              <button
                className={cn(
                  "agent-plan-item",
                  `agent-plan-${item.status}`,
                  item.current && "agent-plan-item-current"
                )}
                onClick={() => scrollTo(item.anchorEventId)}
                title={item.content}
                type="button"
              >
                <span className="agent-plan-mark" aria-hidden>
                  {todoStatusMark(item.status)}
                </span>
                <span className="agent-plan-text">{item.content}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
