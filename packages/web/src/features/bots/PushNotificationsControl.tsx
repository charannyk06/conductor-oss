"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import { SERVICE_WORKER_URL } from "@/components/layout/ServiceWorkerRegistration";
import { Button } from "@/components/ui/Button";
import { MobileDropdownMenuContent } from "@/components/ui/MobileDropdownMenu";
import {
  fetchPushPublicKey,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
} from "@/lib/botsApi";
import {
  base64UrlToUint8Array,
  isValidVapidPublicKey,
  resolvePushSupportState,
  toPushSubscriptionPayload,
  type PushSupportState,
} from "@/lib/pushSubscription";

function readSupportState(): PushSupportState {
  return resolvePushSupportState({
    hasServiceWorker: "serviceWorker" in navigator && window.isSecureContext,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : null,
  });
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** Lets the user turn phone/desktop push notifications on or off for this browser. */
export function PushNotificationsControl() {
  const [support, setSupport] = useState<PushSupportState | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const state = readSupportState();
    setSupport(state);
    if (state === "unsupported") return;
    let cancelled = false;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (!cancelled) setSubscribed(Boolean(subscription));
      } catch {
        // Treated as not subscribed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const report = useCallback((text: string, isFailure = false) => {
    setMessage(text);
    setFailed(isFailure);
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      setSupport(readSupportState());
      if (permission !== "granted") {
        report("Notifications are blocked for this site. Allow them in your browser settings.", true);
        return;
      }
      const { publicKey, enabled } = await fetchPushPublicKey();
      if (!enabled || !isValidVapidPublicKey(publicKey)) {
        report("Push notifications are not available on this Conductor backend.", true);
        return;
      }
      const registration = await getRegistration();
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        });
      const payload = toPushSubscriptionPayload(subscription.toJSON());
      if (!payload) {
        report("This browser returned an incomplete push subscription.", true);
        return;
      }
      await savePushSubscription(payload);
      setSubscribed(true);
      report("Notifications are on for this device.");
    } catch (err) {
      report(err instanceof Error ? err.message : "Could not enable notifications.", true);
    } finally {
      setBusy(false);
    }
  }, [report]);

  const disable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await removePushSubscription(endpoint);
      }
      setSubscribed(false);
      report("Notifications are off for this device.");
    } catch (err) {
      report(err instanceof Error ? err.message : "Could not disable notifications.", true);
    } finally {
      setBusy(false);
    }
  }, [report]);

  const test = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const sent = await sendTestPush();
      report(sent > 0
        ? `Test sent to ${sent} ${sent === 1 ? "device" : "devices"}.`
        : "No subscribed devices received the test.", sent === 0);
    } catch (err) {
      report(err instanceof Error ? err.message : "Could not send a test notification.", true);
    } finally {
      setBusy(false);
    }
  }, [report]);

  if (support === null) {
    return null;
  }

  const enabled = support === "granted" && subscribed;
  const Icon = enabled ? BellRing : support === "granted" || support === "default" ? Bell : BellOff;
  const label = enabled ? "Notifications on" : "Notifications";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="oc-mobile-touch-target inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-[12px] font-medium text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] sm:h-8"
          aria-label={label}
          title={label}
        >
          <Icon className={enabled ? "h-4 w-4 text-[var(--vk-text-normal)]" : "h-4 w-4"} />
          <span className="hidden md:inline">{label}</span>
        </button>
      </DropdownMenu.Trigger>
      <MobileDropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-[min(20rem,calc(100vw-1rem))] rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
      >
        <p className="text-[13px] font-medium text-[var(--vk-text-normal)]">Push notifications</p>
        <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
          {support === "unsupported"
            ? "This browser cannot receive push notifications here. On iPhone, add Conductor to your Home Screen first; other browsers need HTTPS or localhost."
            : support === "denied"
              ? "Notifications are blocked for this site. Allow them in your browser's site settings, then reload."
              : enabled
                ? "This device is notified when a bot needs your approval, input, or attention."
                : "Get notified on this device when a bot needs your approval, input, or attention."}
        </p>
        {support === "default" || support === "granted" ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {enabled ? (
              <>
                <Button type="button" size="sm" variant="primary" onClick={() => void test()} disabled={busy}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Send test
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void disable()} disabled={busy}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="primary" onClick={() => void enable()} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Enable notifications
              </Button>
            )}
          </div>
        ) : null}
        {message ? (
          <p
            role="status"
            className={failed
              ? "mt-3 text-[12px] leading-5 text-[var(--vk-red)]"
              : "mt-3 text-[12px] leading-5 text-[var(--vk-text-muted)]"}
          >
            {message}
          </p>
        ) : null}
      </MobileDropdownMenuContent>
    </DropdownMenu.Root>
  );
}
