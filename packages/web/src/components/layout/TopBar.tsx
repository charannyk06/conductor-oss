"use client";

import type { DashboardSession } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { ActivityDot } from "@/components/ActivityDot";

interface TopBarProps {
  session: DashboardSession | null;
}

function parseCostUsd(meta: Record<string, string>): number {
  const raw = meta["cost"];
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { estimatedCostUsd?: number; totalUSD?: number };
    return parsed.estimatedCostUsd ?? parsed.totalUSD ?? 0;
  } catch {
    return 0;
  }
}

export function TopBar({ session }: TopBarProps) {
  if (!session) return null;

  const attention = getAttentionLevel(session);
  const cost = parseCostUsd(session.metadata);

  const attentionVariant: Record<string, "success" | "warning" | "error" | "info" | "default"> = {
    merge: "success",
    respond: "error",
    review: "warning",
    pending: "info",
    working: "info",
    done: "default",
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4">
      <h1 className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
        {session.summary ?? session.id}
      </h1>

      <ActivityDot activity={session.activity} dotOnly={false} size={6} />

      <Badge variant={attentionVariant[attention] ?? "default"}>
        {attention}
      </Badge>

      {session.metadata["agent"] && (
        <Badge variant="outline">{session.metadata["agent"]}</Badge>
      )}

      {cost > 0 && (
        <span className="ml-auto text-[12px] tabular-nums text-[var(--color-text-secondary)]">
          ${cost.toFixed(2)}
        </span>
      )}
    </div>
  );
}
