"use client";

import { type MutableRefObject, useEffect, useRef } from "react";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import {
  primeNotificationAudio,
  playNotificationSound,
  resolveNotificationSoundId,
  type NotificationSoundId,
} from "@/lib/notificationSounds";

type NotificationPriority = "high" | "medium" | "low";

type NotificationRecord = {
  id: string;
  priority: NotificationPriority;
  message: string;
  timestamp: string;
  sessionId: string;
  projectId: string;
  type: string;
};

type NotificationResponse = {
  notifications?: unknown;
};

interface NotificationPreferences {
  soundEnabled: boolean;
  soundFile: string | null;
}

interface UseNotificationAlertsOptions {
  enabled: boolean;
  projectId: string | null;
  preferences: NotificationPreferences | null;
  bridgeId?: string | null;
}

const POLL_INTERVAL_MS = 10_000;

function isVisiblePage(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function isNotificationPriority(value: unknown): value is NotificationPriority {
  return value === "high" || value === "medium" || value === "low";
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizeNotification(value: unknown): NotificationRecord | null {
  const payload = toObject(value);
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const timestamp = typeof payload.timestamp === "string" ? payload.timestamp.trim() : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
  const type = typeof payload.type === "string" ? payload.type.trim() : "";
  const priority = isNotificationPriority(payload.priority) ? payload.priority : "low";

  if (!id || !message || !timestamp || !sessionId || !projectId || !type) {
    return null;
  }

  return {
    id,
    priority,
    message,
    timestamp,
    sessionId,
    projectId,
    type,
  };
}

function normalizeNotificationResponse(value: unknown): NotificationRecord[] {
  const payload = toObject(value);
  const notifications = Array.isArray(payload.notifications)
    ? payload.notifications
    : [];
  return notifications
    .map((notification) => normalizeNotification(notification))
    .filter((notification): notification is NotificationRecord => notification !== null)
    .sort((left, right) => {
      const timestampOrder = Date.parse(right.timestamp) - Date.parse(left.timestamp);
      if (timestampOrder !== 0) return timestampOrder;
      return right.id.localeCompare(left.id);
    });
}

function latestTimestamp(notifications: NotificationRecord[]): string | null {
  return notifications[0]?.timestamp ?? null;
}

function shouldAlert(notification: NotificationRecord): boolean {
  return notification.priority !== "low";
}

function pickAlertNotification(notifications: NotificationRecord[]): NotificationRecord | null {
  return notifications.find((notification) => notification.priority === "high")
    ?? notifications.find((notification) => notification.priority === "medium")
    ?? notifications[0]
    ?? null;
}

function notificationKey(notification: NotificationRecord): string {
  return `${notification.id}::${notification.timestamp}`;
}

function clearTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

export function useNotificationAlerts({
  enabled,
  projectId,
  preferences,
  bridgeId,
}: UseNotificationAlertsOptions): void {
  const soundEnabledRef = useRef(preferences?.soundEnabled !== false);
  const soundFileRef = useRef<NotificationSoundId>(resolveNotificationSoundId(preferences?.soundFile));
  const seenNotificationKeysRef = useRef(new Set<string>());
  const latestTimestampRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const activeScopeKeyRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    soundEnabledRef.current = preferences?.soundEnabled !== false;
    soundFileRef.current = resolveNotificationSoundId(preferences?.soundFile);
  }, [preferences?.soundEnabled, preferences?.soundFile]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const normalizedProjectId = projectId?.trim() || null;
    const normalizedBridgeId = bridgeId?.trim() || null;
    const scopeKey = `${normalizedBridgeId ?? "local"}::${normalizedProjectId ?? ""}`;
    if (activeScopeKeyRef.current !== scopeKey) {
      activeScopeKeyRef.current = scopeKey;
      seenNotificationKeysRef.current = new Set();
      latestTimestampRef.current = null;
      initializedRef.current = false;
    }

    let cancelled = false;

    const loadNotifications = async (initial: boolean): Promise<void> => {
      if (cancelled || !isVisiblePage()) {
        return;
      }

      if (inFlightRef.current) {
        await inFlightRef.current;
        return;
      }

      const load = (async () => {
        const params = new URLSearchParams({
          limit: "20",
        });
        if (normalizedProjectId) {
          params.set("project", normalizedProjectId);
        }
        if (!initial && latestTimestampRef.current) {
          params.set("since", latestTimestampRef.current);
        }

        try {
          const response = await fetch(
            withBridgeQuery(`/api/notifications?${params.toString()}`, normalizedBridgeId),
            {
              cache: "no-store",
            },
          );
          if (!response.ok) {
            return;
          }

          const payload = (await response.json().catch(() => null)) as NotificationResponse | null;
          const notifications = normalizeNotificationResponse(payload);
          if (notifications.length === 0) {
            initializedRef.current = true;
            return;
          }

          latestTimestampRef.current = latestTimestamp(notifications);

          if (initial || !initializedRef.current) {
            for (const notification of notifications) {
              seenNotificationKeysRef.current.add(notificationKey(notification));
            }
            initializedRef.current = true;
            return;
          }

          const unseenNotifications = notifications.filter(
            (notification) => !seenNotificationKeysRef.current.has(notificationKey(notification)),
          );

          for (const notification of notifications) {
            seenNotificationKeysRef.current.add(notificationKey(notification));
          }

          if (unseenNotifications.length === 0) {
            return;
          }

          const alertNotification = pickAlertNotification(unseenNotifications);
          if (!alertNotification || !shouldAlert(alertNotification) || !soundEnabledRef.current) {
            return;
          }

          await playNotificationSound(soundFileRef.current);
        } catch {
          // Ignore transient notification polling failures.
        }
      })();

      inFlightRef.current = load;
      try {
        await load;
      } finally {
        if (inFlightRef.current === load) {
          inFlightRef.current = null;
        }
        initializedRef.current = true;
      }
    };

    const scheduleNextPoll = () => {
      clearTimer(pollTimerRef);
      if (cancelled || !isVisiblePage()) {
        return;
      }

      pollTimerRef.current = window.setTimeout(() => {
        void loadNotifications(false).finally(() => {
          scheduleNextPoll();
        });
      }, POLL_INTERVAL_MS);
    };

    const startPolling = () => {
      if (cancelled || !isVisiblePage()) {
        return;
      }

      void loadNotifications(!initializedRef.current).finally(() => {
        scheduleNextPoll();
      });
    };

    const handleVisibilityChange = () => {
      if (!isVisiblePage()) {
        clearTimer(pollTimerRef);
        return;
      }
      startPolling();
    };

    const handleFocus = () => {
      if (isVisiblePage()) {
        startPolling();
      }
    };

    const handleAudioPrime = () => {
      void primeNotificationAudio();
    };

    startPolling();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pointerdown", handleAudioPrime, true);
    window.addEventListener("touchstart", handleAudioPrime, true);
    window.addEventListener("keydown", handleAudioPrime, true);

    return () => {
      cancelled = true;
      clearTimer(pollTimerRef);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pointerdown", handleAudioPrime, true);
      window.removeEventListener("touchstart", handleAudioPrime, true);
      window.removeEventListener("keydown", handleAudioPrime, true);
    };
  }, [bridgeId, enabled, projectId]);
}
