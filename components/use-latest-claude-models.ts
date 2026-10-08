"use client";

import { useEffect, useState } from "react";

// alias ("claude-opus-latest") → current version label ("Opus 5.5"), from
// GET /api/agent-models/latest. One request per page load, shared by every
// picker; until it answers (or if it fails) labels use agent-core's built-in
// fallbacks via agentModelOptionLabel.
let pending: Promise<Record<string, string>> | null = null;

function loadLatestClaudeModelLabels(): Promise<Record<string, string>> {
  pending ??= fetch("/api/agent-models/latest", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return {};
      const body = (await response.json()) as { aliases?: Record<string, { label?: string }> };
      return Object.fromEntries(
        Object.entries(body.aliases ?? {}).flatMap(([alias, info]) =>
          typeof info?.label === "string" ? [[alias, info.label]] : []
        )
      );
    })
    .catch(() => {
      pending = null;
      return {};
    });
  return pending;
}

export function useLatestClaudeModelLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void loadLatestClaudeModelLabels().then((next) => {
      if (!cancelled) setLabels(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return labels;
}
