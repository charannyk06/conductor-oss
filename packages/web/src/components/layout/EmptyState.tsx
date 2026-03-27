"use client";

import { Compass } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";

interface LayoutEmptyStateProps {
  totalSessions: number;
  activeSessions: number;
  totalCost: number;
}

export function LayoutEmptyState({
  totalSessions,
  activeSessions,
  totalCost,
}: LayoutEmptyStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-5 py-8">
      <Card className="w-full max-w-2xl">
        <CardContent className="flex flex-col items-center gap-4 py-9 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border-soft)] bg-[var(--bg-panel)]">
            <Compass className="h-7 w-7 text-[var(--accent)]" />
          </div>

          <div>
            <h2 className="text-[17px] font-semibold text-[var(--text-strong)]">Select a session</h2>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">
              Pick a live session from the left rail to open the terminal, preview, and diff views.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-left sm:grid-cols-3">
            <Metric label="Total" value={String(totalSessions)} />
            <Metric label="Active" value={String(activeSessions)} />
            <Metric
              label="Est. Cost"
              value={totalCost > 0 ? `$${totalCost.toFixed(2)}` : "$0.00"}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-panel min-w-[120px] rounded-[var(--radius-sm)] border px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">{label}</p>
      <p className="mt-1 text-[14px] font-semibold tabular-nums text-[var(--text-normal)]">{value}</p>
    </div>
  );
}
