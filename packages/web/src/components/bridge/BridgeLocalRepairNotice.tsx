"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, Wrench } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { describeLegacyBridgeBuild } from "@/lib/bridgeBuildCompatibility";
import { buildBridgeBootstrapConnectCommand, buildBridgeRepairHref } from "@/lib/bridgeOnboarding";

type BridgeLocalRepairNoticeProps = {
  deviceId: string;
  deviceName: string;
  dashboardUrl: string;
  installScriptUrl: string;
  relayUrl?: string | null;
  className?: string;
};

export function BridgeLocalRepairNotice({
  deviceId,
  deviceName,
  dashboardUrl,
  installScriptUrl,
  relayUrl,
  className,
}: BridgeLocalRepairNoticeProps) {
  const [copied, setCopied] = useState(false);
  const repairCommand = useMemo(
    () => buildBridgeBootstrapConnectCommand(installScriptUrl, dashboardUrl, relayUrl),
    [dashboardUrl, installScriptUrl, relayUrl],
  );
  const repairHref = useMemo(
    () => buildBridgeRepairHref(deviceId),
    [deviceId],
  );

  return (
    <div
      className={cn(
        "mt-3 rounded-[14px] border border-[color:color-mix(in_srgb,var(--vk-orange)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-orange)_10%,transparent)] px-3 py-3",
        className,
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
        One-time local repair
      </div>
      <div className="mt-2 text-[12px] leading-5 text-[var(--vk-text-normal)]">
        {describeLegacyBridgeBuild(deviceName)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (!navigator.clipboard?.writeText) {
              setCopied(false);
              return;
            }

            setCopied(false);
            void navigator.clipboard.writeText(repairCommand)
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                setCopied(false);
              });
          }}
        >
          {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Repair command copied" : "Copy repair command"}
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={repairHref}>
            <Wrench className="h-4 w-4" />
            Open repair steps
          </Link>
        </Button>
      </div>
    </div>
  );
}
