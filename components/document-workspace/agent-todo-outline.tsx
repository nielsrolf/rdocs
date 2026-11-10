"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { buildTodoOutline, todoStatusMark } from "./todo-outline";
import { buildTrajectoryOutline, type TrajectoryEntry } from "./trajectory-outline";
import type { AiRunEventView } from "./types";

const RAIL_COLLAPSED_KEY = "gdocs.agentRailCollapsed";

function findEventElement(eventId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const target = document.querySelector(`[data-agent-event-id="${CSS.escape(eventId)}"]`);
  return target instanceof HTMLElement ? target : null;
}

function scrollToEvent(eventId: string) {
  const target = findEventElement(eventId);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("agent-event-flash");
  window.setTimeout(() => target.classList.remove("agent-event-flash"), 1200);
}

const TRAJECTORY_MARK: Record<TrajectoryEntry["kind"], string> = {
  prompt: "❯",
  agent: "●",
  reply: "✓",
  error: "!",
  action: "·"
};

/**
 * Right-hand rail of the agent view: the agent's own plan (every todo it wrote,
 * with its status as of now) and, below it, the trajectory outline — what it
 * actually did, as a table of contents of the timeline. Clicking either jumps
 * to the event; the trajectory entry currently at the top of the timeline is
 * highlighted while scrolling.
 */
export function AgentTodoOutline({ events, isRunning = false }: { events: AiRunEventView[]; isRunning?: boolean }) {
  const outline = useMemo(() => buildTodoOutline(events), [events]);
  const trajectory = useMemo(() => buildTrajectoryOutline(events, isRunning), [events, isRunning]);
  const [collapsed, setCollapsed] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1");
    } catch {
      /* private mode: default open */
    }
  }, []);
  const toggle = () =>
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(RAIL_COLLAPSED_KEY, value ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !value;
    });

  // Scroll spy: the last entry whose element has reached the top of the
  // timeline viewport is "where you are".
  useEffect(() => {
    const scroller = railRef.current?.parentElement?.querySelector(".agent-timeline");
    if (!(scroller instanceof HTMLElement) || trajectory.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const limit = scroller.getBoundingClientRect().top + 96;
      const tops = new Map<string, number>();
      scroller.querySelectorAll<HTMLElement>("[data-agent-event-id]").forEach((element) => {
        tops.set(element.dataset.agentEventId ?? "", element.getBoundingClientRect().top);
      });
      let current: string | null = trajectory[0]?.key ?? null;
      for (const entry of trajectory) {
        const top = tops.get(entry.anchorEventId);
        if (top === undefined) continue;
        if (top > limit) break;
        current = entry.key;
      }
      setActiveKey(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [trajectory]);

  // Keep the highlighted entry visible inside the rail itself.
  useEffect(() => {
    if (!activeKey || collapsed) return;
    const rail = railRef.current;
    const item = rail?.querySelector<HTMLElement>(".agent-trajectory-item-active");
    if (!rail || !item) return;
    const railBox = rail.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    if (box.top < railBox.top + 40 || box.bottom > railBox.bottom - 8) {
      rail.scrollTop += box.top - railBox.top - railBox.height / 2;
    }
  }, [activeKey, collapsed]);

  if (outline.items.length === 0 && trajectory.length === 0) return null;

  const failures = trajectory.filter((entry) => entry.failed || entry.kind === "error").length;

  return (
    <aside className={cn("agent-plan", collapsed && "agent-plan-collapsed")} aria-label="Outline" ref={railRef}>
      <div className="agent-plan-header">
        <button
          aria-expanded={!collapsed}
          className="agent-plan-toggle"
          onClick={toggle}
          title={collapsed ? "Show outline" : "Hide outline"}
          type="button"
        >
          <span className="agent-plan-title">{collapsed ? "Outline ‹" : "Outline"}</span>
          {collapsed ? null : (
            <span className="agent-plan-count">
              {trajectory.length} steps{failures > 0 ? ` · ${failures} failed` : ""}
            </span>
          )}
        </button>
      </div>
      {collapsed ? null : (
        <>
          {outline.items.length > 0 ? (
            <section className="agent-plan-section">
              <h4 className="agent-plan-section-title">
                Plan <span className="agent-plan-count">{outline.done}/{outline.items.length}</span>
              </h4>
              <ol className="agent-plan-list">
                {outline.items.map((item) => (
                  <li key={item.key}>
                    <button
                      className={cn(
                        "agent-plan-item",
                        `agent-plan-${item.status}`,
                        item.current && "agent-plan-item-current"
                      )}
                      onClick={() => scrollToEvent(item.anchorEventId)}
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
            </section>
          ) : null}
          {trajectory.length > 0 ? (
            <section className="agent-plan-section">
              {outline.items.length > 0 ? <h4 className="agent-plan-section-title">Trajectory</h4> : null}
              <ol className="agent-plan-list agent-trajectory-list">
                {trajectory.map((entry) => (
                  <li key={entry.key}>
                    <button
                      className={cn(
                        "agent-plan-item agent-trajectory-item",
                        `agent-trajectory-${entry.kind}`,
                        entry.failed && "agent-trajectory-failed",
                        entry.key === activeKey && "agent-trajectory-item-active"
                      )}
                      onClick={() => scrollToEvent(entry.anchorEventId)}
                      title={entry.label}
                      type="button"
                    >
                      <span className="agent-plan-mark" aria-hidden>
                        {entry.running ? "◌" : entry.failed ? "✕" : TRAJECTORY_MARK[entry.kind]}
                      </span>
                      <span className="agent-plan-text">{entry.label}</span>
                      {entry.hint ? <span className="agent-trajectory-hint">{entry.hint}</span> : null}
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      )}
    </aside>
  );
}
