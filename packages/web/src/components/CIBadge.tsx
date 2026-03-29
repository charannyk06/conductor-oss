"use client";

import type { CIStatus } from "@/lib/types";

interface CIBadgeProps {
  status: CIStatus | string;
  failedCount?: number;
  compact?: boolean;
  prUrl?: string;
}

const statusConfig: Record<
  string,
  { label: string; bg: string; text: string; icon: string }
> = {
  passing: {
    label: "CI passing",
    bg: "color-mix(in srgb, var(--status-ready) 14%, transparent)",
    text: "var(--status-ready)",
    icon: "\u2713",
  },
  failing: {
    label: "CI failing",
    bg: "color-mix(in srgb, var(--status-error) 14%, transparent)",
    text: "var(--status-error)",
    icon: "\u2717",
  },
  pending: {
    label: "CI pending",
    bg: "color-mix(in srgb, var(--status-attention) 12%, transparent)",
    text: "var(--status-attention)",
    icon: "\u25CF",
  },
  none: {
    label: "\u2014",
    bg: "transparent",
    text: "var(--text-faint)",
    icon: "",
  },
};

export function CIBadge({ status, failedCount, compact, prUrl }: CIBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.none;

  if (status === "none" || !status) {
    return <span className="text-[10px] text-[var(--text-faint)]">\u2014</span>;
  }

  const label =
    status === "failing" && failedCount && failedCount > 0
      ? `${failedCount} check${failedCount > 1 ? "s" : ""} failing`
      : config.label;

  const inner = (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: config.bg, color: config.text }}
    >
      {!compact && <span>{config.icon}</span>}
      {label}
    </span>
  );

  if (prUrl) {
    return (
      <a
        href={`${prUrl}/checks`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="hover:opacity-80"
      >
        {inner}
      </a>
    );
  }

  return inner;
}

/* Individual CI check item */
interface CICheck {
  name: string;
  status: "passed" | "failed" | "running" | "pending" | "skipped";
  url?: string;
}

const checkIcons: Record<string, { icon: string; color: string }> = {
  passed: { icon: "\u2713", color: "var(--status-ready)" },
  failed: { icon: "\u2717", color: "var(--status-error)" },
  running: { icon: "\u25CF", color: "var(--status-attention)" },
  pending: { icon: "\u25CB", color: "var(--text-faint)" },
  skipped: { icon: "\u25CB", color: "var(--text-faint)" },
};

const checkSortOrder: Record<string, number> = {
  failed: 0,
  running: 1,
  pending: 2,
  passed: 3,
  skipped: 4,
};

interface CICheckListProps {
  checks: CICheck[];
}

export function CICheckList({ checks }: CICheckListProps) {
  const sorted = [...checks].sort(
    (a, b) => (checkSortOrder[a.status] ?? 9) - (checkSortOrder[b.status] ?? 9),
  );

  return (
    <div className="space-y-1">
      {sorted.map((check) => {
        const { icon, color } = checkIcons[check.status] ?? checkIcons.pending;
        return (
          <div key={check.name} className="flex items-center gap-2 text-[11px]">
            <span style={{ color }} className="w-3.5 shrink-0 text-center">
              {icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
              {check.name}
            </span>
            {check.url && (
              <a
                href={check.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-[10px] text-[var(--color-accent)] hover:underline"
              >
                view
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
