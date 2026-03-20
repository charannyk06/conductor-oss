"use client";

import { CircleDot } from "lucide-react";
import { useEffect, useState } from "react";
import { buildBridgeHttpUrl, hasBridgeSettings } from "@/lib/bridge";
import { cn } from "@/lib/cn";

type BridgeListResponse = {
  bridges?: Array<{
    bridge_id?: string;
    browser_count?: number;
    connected?: boolean;
    last_status?: {
      hostname?: string;
      os?: string;
      connected?: boolean;
    } | null;
  }>;
};

async function fetchBridgeStatus(): Promise<{
  online: boolean;
  hostname: string | null;
}> {
  const url = buildBridgeHttpUrl("/api/bridges");
  if (!url) {
    return { online: false, hostname: null };
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    return { online: false, hostname: null };
  }

  const payload = (await response.json().catch(() => null)) as BridgeListResponse | null;
  const connectedBridge = payload?.bridges?.find((bridge) => bridge.connected === true && bridge.last_status?.connected !== false) ?? null;
  return {
    online: connectedBridge !== null,
    hostname: connectedBridge?.last_status?.hostname?.trim() || null,
  };
}

export function BridgeStatusPill() {
  const [connected, setConnected] = useState(false);
  const [hostname, setHostname] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;

    const refresh = async () => {
      if (!hasBridgeSettings()) {
        if (!cancelled) {
          setConnected(false);
          setHostname(null);
        }
        return;
      }

      try {
        const status = await fetchBridgeStatus();
        if (!cancelled) {
          setConnected(status.online);
          setHostname(status.hostname);
        }
      } catch {
        if (!cancelled) {
          setConnected(false);
          setHostname(null);
        }
      }
    };

    void refresh();
    pollTimer = window.setInterval(() => {
      void refresh();
    }, 15000);

    const onStorage = () => {
      void refresh();
    };

    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium",
        connected
          ? "border-[rgba(24,197,143,0.35)] bg-[rgba(24,197,143,0.12)] text-[var(--vk-green)]"
          : "border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.04)] text-[var(--vk-text-muted)]",
      )}
      title={hostname ? `Bridge host: ${hostname}` : undefined}
    >
      <CircleDot className="h-3.5 w-3.5" />
      Bridge {connected ? "online" : "offline"}
    </span>
  );
}
