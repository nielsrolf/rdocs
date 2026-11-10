"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { groupAgentEvents, toolResultFailed } from "./timeline-model";
import { buildTodoOutline, todoStatusMark } from "./todo-outline";
import { buildTrajectoryOutline } from "./trajectory-outline";
import type { ActiveAiRunView, AiRunEventView } from "./types";

const RAIL_EXPANDED_KEY = "gdocs.agentRailExpanded";
/** Outlines are fetched for the newest turns of a conversation only. */
const OUTLINE_RUN_LIMIT = 8;
const OUTLINE_PENDING_POLL_MS = 2500;
const OUTLINE_LIVE_POLL_MS = 40_000;

type OutlineSectionView = { startEventId: string; title: string };
type RunOutlineState = { status: "ready" | "pending" | "unavailable"; sections: OutlineSectionView[] };

export type OutlineMarker = {
  key: string;
  anchorEventId: string;
  title: string;
  kind: "prompt" | "section" | "agent" | "reply" | "error";
  toolCalls: number;
  failed: number;
};

function findEventElement(eventId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const target = document.querySelector(`[data-agent-event-id="${CSS.escape(eventId)}"]`);
  return target instanceof HTMLElement ? target : null;
}

/** The element standing in for `element` on screen: itself, or the outermost
 * collapsed block (a folded run of tool calls) that hides it. */
function visibleStandIn(element: HTMLElement): HTMLElement {
  let shown = element;
  let closed = element.parentElement?.closest<HTMLElement>("details:not([open])") ?? null;
  while (closed) {
    shown = closed;
    closed = closed.parentElement?.closest<HTMLElement>("details:not([open])") ?? null;
  }
  return shown;
}

function scrollToEvent(eventId: string) {
  const target = findEventElement(eventId);
  if (!target) return;
  // A section can start inside a folded run of tool calls: open it.
  let closed = target.parentElement?.closest<HTMLDetailsElement>("details:not([open])") ?? null;
  while (closed) {
    closed.open = true;
    closed = closed.parentElement?.closest<HTMLDetailsElement>("details:not([open])") ?? null;
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("agent-event-flash");
  window.setTimeout(() => target.classList.remove("agent-event-flash"), 1200);
}

/**
 * Markers of the outline rail. Model-written sections where a run has them
 * (plus every user message, which always starts a section); otherwise the
 * rule-based headings: the prompt, each piece of agent commentary, errors and
 * the final reply. Each marker carries the tool-call tally of its stretch.
 */
export function buildOutlineMarkers(
  events: AiRunEventView[],
  sections: OutlineSectionView[],
  isRunning: boolean
): OutlineMarker[] {
  const order = new Map(events.map((event, index) => [event.id, index]));
  const headings = buildTrajectoryOutline(events, isRunning).filter((entry) => entry.kind !== "action");
  let markers: Array<Omit<OutlineMarker, "toolCalls" | "failed">>;
  const known = sections.filter((section) => order.has(section.startEventId));
  if (known.length > 0) {
    const anchors = new Set(known.map((section) => section.startEventId));
    markers = [
      ...known.map((section) => ({
        key: `s:${section.startEventId}`,
        anchorEventId: section.startEventId,
        title: section.title,
        kind: "section" as const
      })),
      ...headings
        .filter((entry) => entry.kind === "prompt" && !anchors.has(entry.anchorEventId))
        .map((entry) => ({ key: entry.key, anchorEventId: entry.anchorEventId, title: entry.label, kind: "prompt" as const }))
    ];
  } else {
    markers = headings.map((entry) => ({
      key: entry.key,
      anchorEventId: entry.anchorEventId,
      title: entry.label,
      kind: entry.kind as OutlineMarker["kind"]
    }));
  }
  markers.sort((a, b) => (order.get(a.anchorEventId) ?? 0) - (order.get(b.anchorEventId) ?? 0));
  const tools = groupAgentEvents(events)
    .filter((item) => item.kind === "tool")
    .map((item) => ({ at: order.get(item.call.id) ?? 0, failed: toolResultFailed(item.result) }));
  return markers.map((marker, index) => {
    const from = order.get(marker.anchorEventId) ?? 0;
    const to = index + 1 < markers.length ? (order.get(markers[index + 1].anchorEventId) ?? Infinity) : Infinity;
    const inside = tools.filter((tool) => tool.at >= from && tool.at < to);
    return { ...marker, toolCalls: inside.length, failed: inside.filter((tool) => tool.failed).length };
  });
}

/** Model-written outlines of the conversation's runs, fetched (and, for a
 * live run, refreshed) from the outline route. */
function useRunOutlines(documentId: string, runs: ActiveAiRunView[], shareToken: string | null) {
  const [outlines, setOutlines] = useState<Record<string, RunOutlineState>>({});
  const runKey = runs
    .slice(-OUTLINE_RUN_LIMIT)
    .map((run) => `${run.id}:${run.status}`)
    .join(",");

  useEffect(() => {
    let cancelled = false;
    const timers = new Set<number>();
    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    const load = (runId: string, live: boolean) => {
      fetch(`/api/documents/${documentId}/ai-runs/${runId}/outline${shareQuery}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { outline?: RunOutlineState } | null) => {
          if (cancelled) return;
          const outline = payload?.outline;
          if (outline) setOutlines((current) => ({ ...current, [runId]: outline }));
          const delay = outline?.status === "pending" ? OUTLINE_PENDING_POLL_MS : live ? OUTLINE_LIVE_POLL_MS : 0;
          if (delay) {
            const timer = window.setTimeout(() => {
              timers.delete(timer);
              load(runId, live);
            }, delay);
            timers.add(timer);
          }
        })
        .catch(() => {
          /* The rule-based outline stays. */
        });
    };
    for (const entry of runKey ? runKey.split(",") : []) {
      const [runId, status] = entry.split(":");
      load(runId, status === "RUNNING" || status === "PENDING");
    }
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [documentId, runKey, shareToken]);

  return outlines;
}

/**
 * Right-hand rail of the agent view. By default a thin strip of markers, one
 * per section of the trajectory; hovering a marker shows the section title,
 * clicking jumps there, and the section being read is highlighted. Expanded,
 * it lists the titles together with the agent's own plan.
 */
export function AgentTodoOutline({
  documentId,
  events,
  isRunning = false,
  runs,
  shareToken = null
}: {
  documentId: string;
  events: AiRunEventView[];
  isRunning?: boolean;
  runs: ActiveAiRunView[];
  shareToken?: string | null;
}) {
  const plan = useMemo(() => buildTodoOutline(events), [events]);
  const outlines = useRunOutlines(documentId, runs, shareToken);
  const sections = useMemo(() => Object.values(outlines).flatMap((outline) => outline.sections), [outlines]);
  const annotating = Object.values(outlines).some((outline) => outline.status === "pending");
  const markers = useMemo(() => buildOutlineMarkers(events, sections, isRunning), [events, sections, isRunning]);
  const [expanded, setExpanded] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tip, setTip] = useState<{ marker: OutlineMarker; top: number; right: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      setExpanded(window.localStorage.getItem(RAIL_EXPANDED_KEY) === "1");
    } catch {
      /* private mode: default strip */
    }
  }, []);
  const toggle = () =>
    setExpanded((value) => {
      try {
        window.localStorage.setItem(RAIL_EXPANDED_KEY, value ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !value;
    });

  // Scroll spy: the last marker whose section start has reached the top of
  // the timeline viewport is "where you are".
  useEffect(() => {
    const scroller = railRef.current?.parentElement?.querySelector(".agent-timeline");
    if (!(scroller instanceof HTMLElement) || markers.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const limit = scroller.getBoundingClientRect().top + 96;
      let current: string | null = markers[0]?.key ?? null;
      for (const marker of markers) {
        const element = findEventElement(marker.anchorEventId);
        if (!element) continue;
        if (visibleStandIn(element).getBoundingClientRect().top > limit) break;
        current = marker.key;
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
  }, [markers]);

  if (plan.items.length === 0 && markers.length === 0) return null;

  const showTip = (marker: OutlineMarker, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    setTip({ marker, top: box.top + box.height / 2, right: window.innerWidth - box.left + 6 });
  };
  const tally = (marker: OutlineMarker) =>
    marker.toolCalls > 0
      ? `${marker.toolCalls} tool call${marker.toolCalls === 1 ? "" : "s"}${marker.failed > 0 ? ` · ${marker.failed} failed` : ""}`
      : null;

  return (
    <aside className={cn("agent-plan", !expanded && "agent-plan-strip")} aria-label="Outline" ref={railRef}>
      <div className="agent-plan-header">
        <button
          aria-expanded={expanded}
          className="agent-plan-toggle"
          onClick={toggle}
          title={expanded ? "Collapse the outline to markers" : "Show section titles and the plan"}
          type="button"
        >
          {expanded ? (
            <>
              <span className="agent-plan-title">Outline</span>
              <span className="agent-plan-count">{annotating ? "annotating…" : `${markers.length} sections`}</span>
              <span className="agent-plan-chevron" aria-hidden>›</span>
            </>
          ) : (
            <span className="agent-plan-chevron" aria-hidden>‹</span>
          )}
        </button>
      </div>
      {expanded ? (
        <>
          {plan.items.length > 0 ? (
            <section className="agent-plan-section">
              <h4 className="agent-plan-section-title">
                Plan <span className="agent-plan-count">{plan.done}/{plan.items.length}</span>
              </h4>
              <ol className="agent-plan-list">
                {plan.items.map((item) => (
                  <li key={item.key}>
                    <button
                      className={cn("agent-plan-item", `agent-plan-${item.status}`, item.current && "agent-plan-item-current")}
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
          {markers.length > 0 ? (
            <section className="agent-plan-section">
              {plan.items.length > 0 ? <h4 className="agent-plan-section-title">Sections</h4> : null}
              <ol className="agent-plan-list">
                {markers.map((marker) => (
                  <li key={marker.key}>
                    <button
                      className={cn(
                        "agent-plan-item agent-outline-row",
                        `agent-outline-${marker.kind}`,
                        marker.failed > 0 && "agent-outline-has-failures",
                        marker.key === activeKey && "agent-outline-active"
                      )}
                      onClick={() => scrollToEvent(marker.anchorEventId)}
                      title={tally(marker) ?? undefined}
                      type="button"
                    >
                      <span className="agent-outline-dash" aria-hidden />
                      <span className="agent-plan-text">{marker.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      ) : (
        <>
          {plan.items.length > 0 ? (
            <button className="agent-outline-plan-chip" onClick={toggle} title={`Plan: ${plan.done} of ${plan.items.length} done`} type="button">
              {plan.done}/{plan.items.length}
            </button>
          ) : null}
          <ol className="agent-outline-markers">
            {markers.map((marker) => (
              <li key={marker.key}>
                <button
                  aria-label={marker.title}
                  className={cn(
                    "agent-outline-marker",
                    `agent-outline-${marker.kind}`,
                    marker.failed > 0 && "agent-outline-has-failures",
                    marker.key === activeKey && "agent-outline-active"
                  )}
                  onBlur={() => setTip(null)}
                  onClick={() => scrollToEvent(marker.anchorEventId)}
                  onFocus={(event) => showTip(marker, event.currentTarget)}
                  onMouseEnter={(event) => showTip(marker, event.currentTarget)}
                  onMouseLeave={() => setTip(null)}
                  type="button"
                >
                  <span className="agent-outline-dash" aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          {annotating ? <span className="agent-outline-annotating" title="Writing section titles…" /> : null}
          {tip ? (
            <div className="agent-outline-tip" role="tooltip" style={{ top: tip.top, right: tip.right }}>
              <span className="agent-outline-tip-title">{tip.marker.title}</span>
              {tally(tip.marker) ? <span className="agent-outline-tip-meta">{tally(tip.marker)}</span> : null}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
