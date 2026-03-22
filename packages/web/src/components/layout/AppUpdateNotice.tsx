"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Check, Copy, Download, Loader2, RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { subscribeToAppUpdateEvents } from "@/lib/liveEvents";
import { resolveBridgeIdFromLocation, withBridgeQuery } from "@/lib/bridgeQuery";
import { describeAutoUpdateSkip } from "@/lib/bridgeAppUpdate";
import type { AppInstallMode, AppUpdateStatus } from "@/lib/types";
import { cn } from "@/lib/cn";

const DISMISSED_VERSION_STORAGE_KEY = "conductor-dismissed-update-version";

function installModeHint(mode: AppInstallMode): string | null {
  switch (mode) {
    case "npx":
      return "This session was launched through npx. Copy the restart command, run it in a terminal, and the next launch will use the latest package.";
    case "unknown":
      return "Automatic updates are unavailable for this install.";
    default:
      return null;
  }
}

function noticeTitle(update: AppUpdateStatus): string {
  if (!update.enabled && update.reason) {
    return "Conductor update unavailable";
  }
  if (update.restarting) return "Restarting Conductor";
  if (update.jobStatus === "running") return "Updating Conductor";
  if (update.jobStatus === "completed") return "Conductor updated";
  if (update.jobStatus === "failed") return "Update failed";
  return update.latestVersion ? `Conductor ${update.latestVersion} is available` : "Conductor update available";
}

function noticeDescription(update: AppUpdateStatus): string {
  if (!update.enabled && update.reason) {
    return describeAutoUpdateSkip(update);
  }
  if (update.restarting) {
    return "The launcher is restarting the runtime. This tab will reconnect automatically once it is ready.";
  }
  if (update.jobStatus === "running") {
    return update.jobMessage ?? "Installing the latest version in the background.";
  }
  if (update.jobStatus === "completed") {
    return update.jobMessage ?? "The latest version has been installed. Restart Conductor to use it.";
  }
  if (update.jobStatus === "failed") {
    return update.jobMessage ?? "The update command did not finish successfully.";
  }

  const currentVersion = update.currentVersion ? `You are running ${update.currentVersion}. ` : "";
  if (update.canAutoUpdate) {
    return `${currentVersion}Install the new release now and restart when it finishes.`;
  }
  if (update.installMode === "npx") {
    return `${currentVersion}Copy the restart command, run it in a terminal, and the next launch will use the latest release.`;
  }
  return `${currentVersion}Copy the update command, run it in a terminal, then restart Conductor.`;
}

function manualActionLabel(update: AppUpdateStatus): string {
  return update.installMode === "npx" ? "Copy restart command" : "Copy command";
}

export function AppUpdateNotice() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [update, setUpdate] = useState<AppUpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [requestingUpdate, setRequestingUpdate] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const activeBridgeId = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return resolveBridgeIdFromLocation(window.location.href);
  }, [pathname, searchParams]);

  const resolveCurrentBridgeId = useCallback(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return resolveBridgeIdFromLocation(window.location.href);
  }, []);

  const buildAppUpdatePath = useCallback((force = false) => {
    const basePath = withBridgeQuery("/api/app-update", resolveCurrentBridgeId());
    if (!force) {
      return basePath;
    }

    const url = new URL(basePath, "http://127.0.0.1");
    url.searchParams.set("force", "1");
    return `${url.pathname}${url.search}${url.hash}`;
  }, [resolveCurrentBridgeId]);

  const refreshUpdate = useCallback(async (force = false): Promise<AppUpdateStatus | null> => {
    try {
      const response = await fetch(buildAppUpdatePath(force), { cache: "no-store" });
      const payload = await response.json().catch(() => null) as AppUpdateStatus | { error?: string } | null;
      if (response.status === 412) {
        setLoadError(null);
        return null;
      }
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `Failed to load update status (${response.status})`);
      }
      const next = payload as AppUpdateStatus;
      setUpdate(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load update status.");
      return null;
    }
  }, [buildAppUpdatePath, resolveCurrentBridgeId]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DISMISSED_VERSION_STORAGE_KEY);
      setDismissedVersion(stored && stored.length > 0 ? stored : null);
    } catch {
      // Ignore localStorage read failures.
    }

    void refreshUpdate(true);
    const unsubscribe = activeBridgeId
      ? () => {}
      : subscribeToAppUpdateEvents((next) => {
        if (!next) return;
        setUpdate(next);
        setLoadError(null);
      });

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshUpdate(false);
      }
    };

    window.addEventListener("focus", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", handleVisibilityChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeBridgeId, refreshUpdate]);

  const hiddenForVersion = update?.latestVersion && dismissedVersion === update.latestVersion;
  const restarting = Boolean(update?.restarting) || reconnecting;
  const visible = useMemo(() => {
    if (!update) return false;
    if (restarting || update.jobStatus !== "idle") return true;
    if (!update.enabled && update.reason) return true;
    if (hiddenForVersion) return false;
    return update.updateAvailable;
  }, [hiddenForVersion, restarting, update]);

  async function handleCopyCommand() {
    if (!update?.updateCommand) return;
    await navigator.clipboard.writeText(update.updateCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function handleDismiss() {
    if (update?.latestVersion) {
      try {
        window.localStorage.setItem(DISMISSED_VERSION_STORAGE_KEY, update.latestVersion);
      } catch {
        // Ignore localStorage write failures.
      }
      setDismissedVersion(update.latestVersion);
      return;
    }
    setUpdate((current) => (current ? { ...current, reason: null, enabled: true } : current));
  }

  async function handleUpdateNow() {
    setRequestingUpdate(true);
    try {
      const response = await fetch(withBridgeQuery("/api/app-update", resolveCurrentBridgeId()), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      });
      const payload = await response.json().catch(() => null) as AppUpdateStatus | { error?: string } | null;
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `Update failed (${response.status})`);
      }
      setUpdate(payload as AppUpdateStatus);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to trigger update.");
    } finally {
      setRequestingUpdate(false);
    }
  }

  const waitForRestartToFinish = useCallback(async () => {
    const deadline = Date.now() + 60_000;
    if (activeBridgeId) {
      while (Date.now() < deadline) {
        const next = await refreshUpdate(false);
        if (!next?.restarting) {
          setReconnecting(false);
          return;
        }
        await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 1000));
      }

      setReconnecting(false);
      setLoadError("Restart started on the paired device, but it did not reconnect in time. Retry from the bridge controls.");
      return;
    }

    while (Date.now() < deadline) {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (response.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // Conductor is still restarting.
      }
      await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 1000));
    }

    setReconnecting(false);
    setLoadError("Restart started, but the dashboard did not come back in time. Reload manually.");
  }, [activeBridgeId, refreshUpdate]);

  useEffect(() => {
    if (!update?.restarting || reconnecting) return;
    setReconnecting(true);
    void waitForRestartToFinish();
  }, [reconnecting, update?.restarting, waitForRestartToFinish]);

  async function handleRestartNow() {
    try {
      const response = await fetch(withBridgeQuery("/api/app-update", resolveCurrentBridgeId()), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "restart" }),
      });
      const payload = await response.json().catch(() => null) as AppUpdateStatus | { error?: string } | null;
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `Restart failed (${response.status})`);
      }
      setUpdate(payload as AppUpdateStatus);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to restart Conductor.");
    }
  }

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[70] w-[min(calc(100vw-1.5rem),24rem)] sm:bottom-4 sm:right-4">
      <section
        className={cn(
          "pointer-events-auto rounded-[14px] border bg-[var(--vk-bg-panel)] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.35)]",
          update?.jobStatus === "failed"
            ? "border-[color:color-mix(in_srgb,var(--vk-red)_55%,var(--vk-border))]"
            : "border-[var(--vk-border)]",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {restarting ? (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--vk-orange)]" />
              ) : update?.jobStatus === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--vk-orange)]" />
              ) : update?.jobStatus === "completed" ? (
                <Check className="h-4 w-4 text-[var(--status-ready)]" />
              ) : update?.jobStatus === "failed" ? (
                <RefreshCcw className="h-4 w-4 text-[var(--vk-red)]" />
              ) : (
                <Download className="h-4 w-4 text-[var(--vk-orange)]" />
              )}
              <h2 className="truncate text-[13px] font-semibold text-[var(--vk-text-normal)]">
                {update ? noticeTitle(update) : "Conductor update"}
              </h2>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[var(--vk-text-muted)]">
              {update ? noticeDescription(update) : "Checking for updates..."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Dismiss update notice"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {update?.updateCommand ? (
          <div className="mt-3 rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--vk-text-muted)]">
            {update.updateCommand}
          </div>
        ) : null}

        {update ? (
          <p className="mt-2 text-[11px] leading-5 text-[var(--vk-text-faint)]">
            {installModeHint(update.installMode) ?? (update.restartRequired
              ? "Restart the current Conductor process after the installer completes."
              : "Update state streams from the running Conductor runtime.")}
          </p>
        ) : null}

        {loadError ? (
          <p className="mt-2 text-[11px] text-[var(--vk-red)]">{loadError}</p>
        ) : update?.error ? (
          <p className="mt-2 text-[11px] text-[var(--vk-red)]">{update.error}</p>
        ) : null}

        {update?.logsTail && update.jobStatus === "failed" ? (
          <pre className="mt-2 max-h-32 overflow-auto rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-2 text-[10px] leading-4 text-[var(--vk-text-faint)]">
            {update.logsTail}
          </pre>
        ) : null}

        <div className="mt-3 flex items-center justify-end gap-2">
          {update?.jobStatus === "failed" && update.canAutoUpdate ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => void handleUpdateNow()}
              disabled={requestingUpdate}
            >
              {requestingUpdate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Retry
            </Button>
          ) : null}

          {update?.jobStatus === "idle" && update.canAutoUpdate ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => void handleUpdateNow()}
              disabled={requestingUpdate}
            >
              {requestingUpdate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Update now
            </Button>
          ) : null}

          {update?.jobStatus === "idle" && !update.canAutoUpdate && update.updateCommand ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleCopyCommand()}
            >
              {copied ? <Check className="h-3.5 w-3.5 text-[var(--status-ready)]" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : manualActionLabel(update)}
            </Button>
          ) : null}

          {update?.restartRequired && update.canRestart && !update.restarting && !reconnecting ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => void handleRestartNow()}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              Restart now
            </Button>
          ) : null}

          {update?.restarting || reconnecting ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Restarting
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
