"use client";

import { useEffect, useState } from "react";

import { SchedulesList } from "@/components/schedules-list";

// Scheduled tasks of this workspace, in the agent screen's config bar. The list
// itself is the same component as the dashboard's Schedules tab, filtered to
// this document; it loads only once the menu is opened.
export function SchedulesMenu({ documentId, documentKind }: { documentId: string; documentKind?: string }) {
  const [open, setOpen] = useState(false);
  const [activeCount, setActiveCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/schedules?documentId=${encodeURIComponent(documentId)}`)
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.schedules) setActiveCount((data.schedules as unknown[]).length);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [documentId, open]);

  return (
    <details className="header-menu header-menu-wide" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>{activeCount ? `Schedules · ${activeCount}` : "Schedules"}</summary>
      <div className="header-menu-panel schedules-menu-panel">{open ? <SchedulesList documentId={documentId} documentKind={documentKind} /> : null}</div>
    </details>
  );
}
