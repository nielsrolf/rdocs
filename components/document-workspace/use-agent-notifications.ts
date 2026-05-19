"use client";

import { useCallback, useRef, useState } from "react";

import { truncate } from "@/lib/utils";

import type { ActiveAiRunView, AgentToast } from "./types";

type CompletedRunInput = {
  id: string;
  triggerType: string;
  triggerId?: string | null;
  instruction: string;
  status?: string;
};

export function useAgentNotifications() {
  const [agentToast, setAgentToast] = useState<AgentToast | null>(null);
  const permissionPromiseRef = useRef<Promise<boolean> | null>(null);
  const notifiedRunsRef = useRef<Set<string>>(new Set());

  const ensurePermission = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }

    if (permissionPromiseRef.current) {
      return permissionPromiseRef.current;
    }

    permissionPromiseRef.current = (async () => {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }

      if (Notification.permission !== "granted") {
        return false;
      }

      if ("serviceWorker" in navigator) {
        await navigator.serviceWorker.register("/agent-notifications-sw.js").catch(() => null);
      }

      return true;
    })();

    return permissionPromiseRef.current;
  }, []);

  const showSystemNotification = useCallback(async (title: string, body: string) => {
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    if ("serviceWorker" in navigator) {
      const registration =
        (await navigator.serviceWorker.getRegistration("/agent-notifications-sw.js").catch(() => null)) ??
        (await navigator.serviceWorker.register("/agent-notifications-sw.js").catch(() => null));
      if (registration?.showNotification) {
        await registration.showNotification(title, {
          body,
          icon: "/favicon.ico",
          tag: `agent-${Date.now()}`
        });
        return;
      }
    }

    new Notification(title, { body });
  }, []);

  const notifyDone = useCallback(
    (run: ActiveAiRunView) => {
      if (notifiedRunsRef.current.has(run.id)) {
        return;
      }
      notifiedRunsRef.current.add(run.id);

      const ok = run.status === "SUCCEEDED";
      const title = ok ? "Agent finished" : "Agent needs attention";
      const body =
        run.triggerType === "CONVERSATION"
          ? truncate(run.instruction, 120)
          : `${run.triggerType.replace("_", " ").toLowerCase()} completed`;

      setAgentToast({ id: run.id, title, body });
      window.setTimeout(() => {
        setAgentToast((current) => (current?.id === run.id ? null : current));
      }, 6500);

      void showSystemNotification(title, body);
    },
    [showSystemNotification]
  );

  const notifyCompleted = useCallback(
    (input: CompletedRunInput) => {
      notifyDone({
        ...input,
        status: input.status ?? "SUCCEEDED",
        progress: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
    },
    [notifyDone]
  );

  const dismissToast = useCallback(() => setAgentToast(null), []);

  return {
    ensurePermission,
    notifyDone,
    notifyCompleted,
    agentToast,
    dismissToast
  };
}
