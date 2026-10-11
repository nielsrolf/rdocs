"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The Schedules overview (lib/schedules.ts): every scheduled task the viewer can
// see — created from Slack by claudex, by an integration such as forecasting, by
// an MCP client, or here — with pause / resume / run now / edit / cancel and the
// firing history. Rendered as a dashboard tab (all documents) and inside a
// document's agent screen (documentId set).

export type ScheduleView = {
  id: string;
  title: string;
  kind: string;
  context: string;
  instruction: string;
  cron: string | null;
  timezone: string | null;
  schedule: string;
  status: "active" | "paused" | "ended";
  endedReason: string | null;
  endedAt: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastRunId: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  document: { id: string; title: string; kind: string };
  slack: { teamId: string; channelId: string; threadTs: string | null; url: string } | null;
  link: string;
  canManage: boolean;
};

type Firing = {
  id: string;
  firedAt: string;
  outcome: string;
  trigger: string;
  runId: string | null;
  runStatus: string | null;
  detail: string | null;
};

export type ScheduleDocumentOption = { id: string; title: string; kind: string };

type Props = {
  /** Restrict to one document (agent screen). */
  documentId?: string;
  documentKind?: string;
  /** Documents the viewer can edit, for the New schedule picker on the dashboard. */
  documents?: ScheduleDocumentOption[];
};

const OUTCOME_LABEL: Record<string, string> = {
  started: "Started a run",
  injected: "Delivered to the running agent",
  deferred: "Deferred (thread busy)",
  skipped: "Skipped",
  disabled: "Disabled",
  error: "Failed"
};

function outcomeTone(outcome: string | null): "ok" | "warn" | "bad" | "none" {
  if (!outcome) return "none";
  if (outcome === "started" || outcome === "injected") return "ok";
  if (outcome === "deferred" || outcome === "skipped") return "warn";
  return "bad";
}

function formatWhen(iso: string, now = Date.now()) {
  const date = new Date(iso);
  const diff = date.getTime() - now;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const rel =
    minutes < 1
      ? "now"
      : minutes < 60
        ? `${minutes} min`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} h`
          : `${Math.round(minutes / (24 * 60))} days`;
  const relText = rel === "now" ? "now" : diff > 0 ? `in ${rel}` : `${rel} ago`;
  const absolute = date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return { relText, absolute };
}

function whereLabel(view: ScheduleView): string {
  if (view.context === "slack_thread") return view.slack?.channelId.startsWith("D") ? "Slack DM thread" : "Slack thread";
  if (view.context === "slack_channel") return "Slack channel (new thread per firing)";
  if (view.context === "api_channel") return "Integration channel";
  if (view.context === "document") return "Agent run on the document";
  return view.context;
}

function runHref(view: Pick<ScheduleView, "document">, runId: string) {
  return `/documents/${view.document.id}?run=${encodeURIComponent(runId)}`;
}

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ---------------------------------------------------------------------------
// Schedule builder: friendly presets that compile to cron, with a raw-cron escape hatch.

type Frequency = "daily" | "weekdays" | "weekly" | "hourly" | "once" | "custom";

type Timing = {
  frequency: Frequency;
  time: string; // HH:MM
  weekday: string; // 0-6
  minute: string; // for hourly
  customCron: string;
  at: string; // datetime-local
  timezone: string;
};

function timingFromView(view?: ScheduleView): Timing {
  const base: Timing = {
    frequency: "daily",
    time: "08:00",
    weekday: "1",
    minute: "0",
    customCron: "",
    at: "",
    timezone: view?.timezone || browserTimezone()
  };
  if (!view) return base;
  if (!view.cron) {
    const next = view.nextRunAt ? new Date(view.nextRunAt) : new Date(Date.now() + 3600_000);
    const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    return { ...base, frequency: "once", at: local };
  }
  const [minute, hour, dom, month, dow] = view.cron.trim().split(/\s+/);
  const num = (value: string | undefined) => value !== undefined && /^\d+$/.test(value);
  const time = num(hour) && num(minute) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : base.time;
  if (dom === "*" && month === "*" && num(minute) && num(hour)) {
    if (dow === "*") return { ...base, frequency: "daily", time };
    if (dow === "1-5") return { ...base, frequency: "weekdays", time };
    if (num(dow)) return { ...base, frequency: "weekly", time, weekday: String(Number(dow) % 7) };
  }
  if (dom === "*" && month === "*" && dow === "*" && hour === "*" && num(minute)) {
    return { ...base, frequency: "hourly", minute };
  }
  return { ...base, frequency: "custom", customCron: view.cron };
}

function timingToPayload(timing: Timing): { cron: string | null; at: string | null; timezone: string | null } {
  const [hh, mm] = (timing.time || "08:00").split(":").map((part) => String(Number(part)));
  switch (timing.frequency) {
    case "daily":
      return { cron: `${mm} ${hh} * * *`, at: null, timezone: timing.timezone || null };
    case "weekdays":
      return { cron: `${mm} ${hh} * * 1-5`, at: null, timezone: timing.timezone || null };
    case "weekly":
      return { cron: `${mm} ${hh} * * ${timing.weekday}`, at: null, timezone: timing.timezone || null };
    case "hourly":
      return { cron: `${Number(timing.minute) || 0} * * * *`, at: null, timezone: timing.timezone || null };
    case "custom":
      return { cron: timing.customCron.trim() || null, at: null, timezone: timing.timezone || null };
    case "once":
      // datetime-local is the viewer's local time; send an absolute instant.
      return { cron: null, at: timing.at ? new Date(timing.at).toISOString() : null, timezone: null };
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function TimingFields({ timing, onChange, allowOnce }: { timing: Timing; onChange: (t: Timing) => void; allowOnce: boolean }) {
  const [preview, setPreview] = useState<{ description?: string; nextRuns?: string[]; error?: string } | null>(null);
  const payload = useMemo(() => timingToPayload(timing), [timing]);

  useEffect(() => {
    if (!payload.cron && !payload.at) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      fetch("/api/schedules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then((response) => response.json())
        .then((data) => setPreview(data))
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(handle);
  }, [payload]);

  const set = (patch: Partial<Timing>) => onChange({ ...timing, ...patch });

  return (
    <div className="schedule-timing">
      <div className="schedule-form-row">
        <label className="schedule-field">
          <span>Repeats</span>
          <select value={timing.frequency} onChange={(event) => set({ frequency: event.target.value as Frequency })}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekly">Once a week</option>
            <option value="hourly">Every hour</option>
            {allowOnce ? <option value="once">Once</option> : null}
            <option value="custom">Custom (cron)</option>
          </select>
        </label>
        {timing.frequency === "weekly" ? (
          <label className="schedule-field">
            <span>On</span>
            <select value={timing.weekday} onChange={(event) => set({ weekday: event.target.value })}>
              {WEEKDAY_NAMES.map((name, index) => (
                <option key={name} value={String(index)}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {timing.frequency === "daily" || timing.frequency === "weekdays" || timing.frequency === "weekly" ? (
          <label className="schedule-field">
            <span>At</span>
            <input type="time" value={timing.time} onChange={(event) => set({ time: event.target.value })} />
          </label>
        ) : null}
        {timing.frequency === "hourly" ? (
          <label className="schedule-field">
            <span>Minute past the hour</span>
            <input
              inputMode="numeric"
              max={59}
              min={0}
              type="number"
              value={timing.minute}
              onChange={(event) => set({ minute: event.target.value })}
            />
          </label>
        ) : null}
        {timing.frequency === "custom" ? (
          <label className="schedule-field schedule-field-grow">
            <span>Cron expression (minute hour day month weekday)</span>
            <input
              placeholder="0 9 * * 1-5"
              value={timing.customCron}
              onChange={(event) => set({ customCron: event.target.value })}
            />
          </label>
        ) : null}
        {timing.frequency === "once" ? (
          <label className="schedule-field">
            <span>When (your local time)</span>
            <input type="datetime-local" value={timing.at} onChange={(event) => set({ at: event.target.value })} />
          </label>
        ) : (
          <label className="schedule-field">
            <span>Timezone</span>
            <input
              list="schedule-timezones"
              placeholder="Europe/Berlin"
              value={timing.timezone}
              onChange={(event) => set({ timezone: event.target.value })}
            />
          </label>
        )}
      </div>
      <datalist id="schedule-timezones">
        {["UTC", "Europe/Berlin", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", browserTimezone()]
          .filter((value, index, all) => all.indexOf(value) === index)
          .map((zone) => (
            <option key={zone} value={zone} />
          ))}
      </datalist>
      {preview?.error ? (
        <p className="schedule-preview schedule-preview-error">{preview.error}</p>
      ) : preview?.nextRuns ? (
        <p className="schedule-preview">
          {preview.description} — next:{" "}
          {preview.nextRuns.map((iso) => formatWhen(iso).absolute).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ScheduleEditor({
  view,
  onSaved,
  onCancel
}: {
  view: ScheduleView;
  onSaved: (view: ScheduleView) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(view.title);
  const [instruction, setInstruction] = useState(view.instruction);
  const [timing, setTiming] = useState<Timing>(() => timingFromView(view));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isWakeup = view.kind === "wakeup";

  async function save() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { title, instruction };
    const original = timingFromView(view);
    if (JSON.stringify(original) !== JSON.stringify(timing)) Object.assign(body, timingToPayload(timing));
    try {
      const response = await fetch(`/api/schedules/${view.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Saving failed.");
        return;
      }
      onSaved(data.schedule as ScheduleView);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="schedule-editor">
      <label className="schedule-field">
        <span>Name</span>
        <input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="schedule-field">
        <span>Instruction (what the agent does at each firing)</span>
        <textarea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      </label>
      <TimingFields allowOnce={!view.cron || isWakeup} timing={timing} onChange={setTiming} />
      {error ? <p className="schedule-preview schedule-preview-error">{error}</p> : null}
      <div className="schedule-actions">
        <button className="primary-button" disabled={busy} onClick={() => void save()} type="button">
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="ghost-button" disabled={busy} onClick={onCancel} type="button">
          Discard
        </button>
      </div>
    </div>
  );
}

function ScheduleCreator({
  documentId,
  documentKind,
  documents,
  onCreated,
  onCancel
}: {
  documentId?: string;
  documentKind?: string;
  documents?: ScheduleDocumentOption[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [targetDocumentId, setTargetDocumentId] = useState(documentId ?? documents?.[0]?.id ?? "");
  const kind = documentId ? documentKind : documents?.find((d) => d.id === targetDocumentId)?.kind;
  const isChannel = kind === "slack_channel";
  const [target, setTarget] = useState<"document" | "slack_channel">(isChannel ? "slack_channel" : "document");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [timing, setTiming] = useState<Timing>(() => timingFromView());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTarget(isChannel ? "slack_channel" : "document");
  }, [isChannel]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: targetDocumentId, title, instruction, target, ...timingToPayload(timing) })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Could not create the schedule.");
        return;
      }
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="schedule-editor surface-card">
      <strong>New scheduled task</strong>
      {!documentId ? (
        <label className="schedule-field">
          <span>Document or channel workspace</span>
          <select value={targetDocumentId} onChange={(event) => setTargetDocumentId(event.target.value)}>
            {(documents ?? []).map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.kind === "slack_channel" ? `Slack: ${doc.title}` : doc.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {isChannel ? (
        <label className="schedule-field">
          <span>Where it runs</span>
          <select value={target} onChange={(event) => setTarget(event.target.value as "document" | "slack_channel")}>
            <option value="slack_channel">claudex posts in the Slack channel (new thread each time)</option>
            <option value="document">Agent run on the workspace, no Slack message</option>
          </select>
        </label>
      ) : (
        <p className="schedule-hint">Each firing runs an agent on this document as you; it can edit the document directly.</p>
      )}
      <label className="schedule-field">
        <span>Name</span>
        <input maxLength={80} placeholder="Daily dashboard refresh" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="schedule-field">
        <span>Instruction — write it so a fresh agent with no memory of this conversation can do the job</span>
        <textarea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      </label>
      <TimingFields allowOnce timing={timing} onChange={setTiming} />
      {error ? <p className="schedule-preview schedule-preview-error">{error}</p> : null}
      <div className="schedule-actions">
        <button
          className="primary-button"
          disabled={busy || !instruction.trim() || !targetDocumentId}
          onClick={() => void create()}
          type="button"
        >
          {busy ? "Scheduling…" : "Schedule"}
        </button>
        <button className="ghost-button" disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ScheduleHistory({ view }: { view: ScheduleView }) {
  const [firings, setFirings] = useState<Firing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/schedules/${view.id}`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error ?? "Could not load history.");
        setFirings(data.firings as Firing[]);
      })
      .catch((err: Error) => setError(err.message));
  }, [view.id, view.lastFiredAt]);

  if (error) return <p className="schedule-preview schedule-preview-error">{error}</p>;
  if (!firings) return <p className="schedule-hint">Loading history…</p>;
  if (firings.length === 0) {
    return (
      <p className="schedule-hint">
        {view.lastFiredAt
          ? `Last fired ${formatWhen(view.lastFiredAt).absolute} (before history was recorded).`
          : "Has not fired yet."}
      </p>
    );
  }
  return (
    <ol className="schedule-history">
      {firings.map((firing) => (
        <li key={firing.id}>
          <span className={`schedule-dot schedule-dot-${outcomeTone(firing.outcome)}`} aria-hidden />
          <span className="schedule-history-when">{formatWhen(firing.firedAt).absolute}</span>
          <span>
            {OUTCOME_LABEL[firing.outcome] ?? firing.outcome}
            {firing.trigger === "manual" ? " (Run now)" : ""}
          </span>
          {firing.runId ? (
            <a className="schedule-link" href={runHref(view, firing.runId)}>
              run{firing.runStatus ? ` · ${firing.runStatus.toLowerCase()}` : ""}
            </a>
          ) : null}
          {firing.detail ? <span className="schedule-history-detail">{firing.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ScheduleCard({
  view,
  highlighted,
  showDocument,
  onChanged
}: {
  view: ScheduleView;
  highlighted: boolean;
  showDocument: boolean;
  onChanged: (view: ScheduleView | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  async function act(label: string, request: () => Promise<Response>, after: (data: Record<string, unknown>) => void) {
    setBusy(label);
    setMessage(null);
    try {
      const response = await request();
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const result = data.result as { detail?: string } | undefined;
        setMessage({ text: (data.error as string) ?? result?.detail ?? `${label} failed.`, tone: "bad" });
        return;
      }
      after(data);
    } finally {
      setBusy(null);
    }
  }

  const setPaused = (paused: boolean) =>
    act(
      paused ? "Pause" : "Resume",
      () =>
        fetch(`/api/schedules/${view.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused })
        }),
      (data) => onChanged(data.schedule as ScheduleView)
    );

  const runNow = () =>
    act(
      "Run now",
      () => fetch(`/api/schedules/${view.id}/run`, { method: "POST" }),
      (data) => {
        const result = data.result as { runId?: string; outcome: string };
        setMessage({ text: result.outcome === "injected" ? "Delivered to the agent already running there." : "Started.", tone: "ok" });
        onChanged({ ...view, lastFiredAt: new Date().toISOString(), lastOutcome: result.outcome, lastRunId: result.runId ?? view.lastRunId });
      }
    );

  const cancel = () => {
    if (!window.confirm(`Cancel "${view.title}" for good? (Pause it instead to stop it temporarily.)`)) return;
    void act(
      "Cancel",
      () => fetch(`/api/schedules/${view.id}`, { method: "DELETE" }),
      (data) => onChanged(data.schedule as ScheduleView)
    );
  };

  const next = view.nextRunAt ? formatWhen(view.nextRunAt) : null;
  const last = view.lastFiredAt ? formatWhen(view.lastFiredAt) : null;
  const statusTone = view.status === "active" ? (outcomeTone(view.lastOutcome) === "bad" ? "bad" : "ok") : view.status === "paused" ? "warn" : "none";

  return (
    <li className={`schedule-card${highlighted ? " schedule-card-highlight" : ""}${view.status === "ended" ? " schedule-card-ended" : ""}`} id={`schedule-${view.id}`}>
      <div className="schedule-card-head">
        <div className="schedule-card-title">
          <span className={`schedule-dot schedule-dot-${statusTone}`} aria-hidden />
          <strong>{view.title}</strong>
          {view.kind === "wakeup" ? <span className="subtle-pill">agent wake-up</span> : null}
          {view.status === "paused" ? <span className="subtle-pill">paused</span> : null}
          {view.status === "ended" ? <span className="subtle-pill">ended · {view.endedReason ?? "disabled"}</span> : null}
        </div>
        {view.canManage && view.status !== "ended" && !editing ? (
          <div className="schedule-card-buttons">
            <button className="ghost-button" disabled={Boolean(busy)} onClick={() => void runNow()} type="button" title="Fire once now; the schedule stays as it is">
              {busy === "Run now" ? "Starting…" : "Run now"}
            </button>
            {view.cron && view.kind !== "wakeup" ? (
              <button className="ghost-button" disabled={Boolean(busy)} onClick={() => void setPaused(view.status !== "paused")} type="button">
                {view.status === "paused" ? "Resume" : "Pause"}
              </button>
            ) : null}
            <button className="ghost-button" disabled={Boolean(busy)} onClick={() => setEditing(true)} type="button">
              Edit
            </button>
            <button className="ghost-button danger-button" disabled={Boolean(busy)} onClick={cancel} type="button">
              Cancel
            </button>
          </div>
        ) : null}
      </div>

      <div className="schedule-card-meta">
        <span>{view.schedule}</span>
        {next ? (
          <span title={next.absolute}>
            next {next.relText} · {next.absolute}
          </span>
        ) : null}
      </div>
      <div className="schedule-card-meta">
        <span>
          {whereLabel(view)}
          {view.slack ? (
            <>
              {" "}
              <a className="schedule-link" href={view.slack.url} rel="noreferrer" target="_blank">
                open in Slack ↗
              </a>
            </>
          ) : null}
        </span>
        {showDocument ? (
          <span>
            in{" "}
            <a className="schedule-link" href={`/documents/${view.document.id}`}>
              {view.document.kind === "slack_channel" ? `Slack: ${view.document.title}` : view.document.title}
            </a>
          </span>
        ) : null}
        {view.createdBy ? <span>by {view.createdBy.name}</span> : null}
      </div>
      <div className="schedule-card-meta">
        {last ? (
          <span title={last.absolute}>
            <span className={`schedule-dot schedule-dot-${outcomeTone(view.lastOutcome)}`} aria-hidden /> Last {last.relText}:{" "}
            {view.lastOutcome ? OUTCOME_LABEL[view.lastOutcome] ?? view.lastOutcome : "fired"}
            {view.lastRunId ? (
              <>
                {" · "}
                <a className="schedule-link" href={runHref(view, view.lastRunId)}>
                  view run
                </a>
              </>
            ) : null}
          </span>
        ) : (
          <span>Has not fired yet</span>
        )}
        {view.lastError ? <span className="schedule-error-text">{view.lastError}</span> : null}
      </div>

      {message ? <p className={`schedule-preview${message.tone === "bad" ? " schedule-preview-error" : ""}`}>{message.text}</p> : null}

      {editing ? (
        <ScheduleEditor
          view={view}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            onChanged(updated);
          }}
        />
      ) : (
        <div className="schedule-card-toggles">
          <details>
            <summary>Instruction</summary>
            <pre className="schedule-instruction">{view.instruction}</pre>
          </details>
          <details onToggle={(event) => setShowHistory((event.target as HTMLDetailsElement).open)}>
            <summary>History</summary>
            {showHistory ? <ScheduleHistory view={view} /> : null}
          </details>
        </div>
      )}
    </li>
  );
}

export function SchedulesList({ documentId, documentKind, documents }: Props) {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [showWakeups, setShowWakeups] = useState(false);
  const [creating, setCreating] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const scrolled = useRef(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (documentId) params.set("documentId", documentId);
    if (showEnded) params.set("includeEnded", "1");
    if (showWakeups) params.set("includeWakeups", "1");
    fetch(`/api/schedules?${params}`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error ?? "Could not load schedules.");
        setSchedules(data.schedules as ScheduleView[]);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [documentId, showEnded, showWakeups]);

  useEffect(() => {
    load();
  }, [load]);

  // Deep links from agent replies: /dashboard?tab=schedules#schedule-<id>.
  useEffect(() => {
    if (!schedules || scrolled.current) return;
    const match = /^#schedule-(.+)$/.exec(window.location.hash);
    if (!match) return;
    scrolled.current = true;
    const id = match[1];
    if (!schedules.some((s) => s.id === id) && !showEnded) {
      // The linked task may have ended since the link was posted.
      scrolled.current = false;
      setShowEnded(true);
      return;
    }
    setHighlight(id);
    requestAnimationFrame(() => document.getElementById(`schedule-${id}`)?.scrollIntoView({ block: "center" }));
  }, [schedules, showEnded]);

  const editableDocuments = documents ?? [];
  const canCreate = Boolean(documentId) || editableDocuments.length > 0;

  return (
    <section className="schedules">
      <div className="schedules-toolbar">
        <p className="schedules-note">
          {documentId
            ? "Standing jobs on this workspace — from claudex in Slack, integrations, MCP clients or created here."
            : "Every scheduled agent task you created, plus the ones on documents you can edit — whether claudex set it up in Slack, an integration like forecasting installed it, or you created it here."}
        </p>
        <div className="schedules-filters">
          <label>
            <input checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} type="checkbox" /> Show ended
          </label>
          <label>
            <input checked={showWakeups} onChange={(event) => setShowWakeups(event.target.checked)} type="checkbox" /> Show agent wake-ups
          </label>
          {canCreate && !creating ? (
            <button className="primary-button" onClick={() => setCreating(true)} type="button">
              New schedule
            </button>
          ) : null}
        </div>
      </div>

      {creating ? (
        <ScheduleCreator
          documentId={documentId}
          documentKind={documentKind}
          documents={editableDocuments}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {error ? <p className="schedule-preview schedule-preview-error">{error}</p> : null}
      {!schedules && !error ? <p className="schedule-hint">Loading…</p> : null}
      {schedules && schedules.length === 0 ? (
        <div className="surface-card schedules-empty">
          <strong>No scheduled tasks{showEnded ? "" : " running"}.</strong>
          <p>
            Ask claudex in Slack (&ldquo;every weekday at 9, summarize …&rdquo;), let an integration install one, or create
            one here with <em>New schedule</em>.
          </p>
        </div>
      ) : null}
      {schedules && schedules.length > 0 ? (
        <ul className="schedule-list">
          {schedules.map((view) => (
            <ScheduleCard
              highlighted={highlight === view.id}
              key={view.id}
              showDocument={!documentId}
              view={view}
              onChanged={(updated) => {
                if (!updated) return load();
                setSchedules((current) =>
                  (current ?? [])
                    .map((item) => (item.id === updated.id ? updated : item))
                    .filter((item) => showEnded || item.status !== "ended")
                );
              }}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
