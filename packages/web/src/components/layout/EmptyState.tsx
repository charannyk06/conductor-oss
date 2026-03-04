"use client";

import { MousePointer } from "lucide-react";

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
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--color-bg-elevated)]">
        <MousePointer className="h-7 w-7 text-[var(--color-text-muted)]" />
      </div>

      <div>
        <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
          Select a session
        </h2>
        <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">
          Choose a session from the sidebar to view details.
        </p>
      </div>

      <div className="mt-2 flex items-center gap-6 text-[12px] text-[var(--color-text-muted)]">
        <span>
          <strong className="text-[var(--color-text-secondary)]">{totalSessions}</strong> total
        </span>
        <span>
          <strong className="text-[var(--color-text-secondary)]">{activeSessions}</strong> active
        </span>
        {totalCost > 0 && (
          <span>
            <strong className="text-[var(--color-text-secondary)]">${totalCost.toFixed(2)}</strong> cost
          </span>
        )}
      </div>
    </div>
  );
}
