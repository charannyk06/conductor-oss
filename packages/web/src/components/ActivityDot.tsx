"use client";

import type { ActivityState } from "@/lib/types";

interface ActivityConfig {
  label: string;
  dot: string;
  bg: string;
  text: string;
}

const activityConfig: Record<ActivityState, ActivityConfig> = {
  active: {
    label: "active",
    dot: "var(--status-working)",
    bg: "color-mix(in srgb, var(--status-working) 18%, transparent)",
    text: "var(--status-working)",
  },
  ready: {
    label: "ready",
    dot: "var(--status-ready)",
    bg: "color-mix(in srgb, var(--status-ready) 18%, transparent)",
    text: "var(--status-ready)",
  },
  idle: {
    label: "idle",
    dot: "var(--status-idle)",
    bg: "color-mix(in srgb, var(--status-idle) 20%, transparent)",
    text: "var(--text-muted)",
  },
  waiting_input: {
    label: "waiting",
    dot: "var(--status-attention)",
    bg: "color-mix(in srgb, var(--status-attention) 16%, transparent)",
    text: "var(--status-attention)",
  },
  blocked: {
    label: "blocked",
    dot: "var(--status-error)",
    bg: "color-mix(in srgb, var(--status-error) 16%, transparent)",
    text: "var(--status-error)",
  },
  exited: {
    label: "exited",
    dot: "var(--status-idle)",
    bg: "color-mix(in srgb, var(--status-idle) 18%, transparent)",
    text: "var(--text-faint)",
  },
};

const fallbackConfig: ActivityConfig = {
  label: "unknown",
  dot: "var(--text-faint)",
  bg: "color-mix(in srgb, var(--text-faint) 16%, transparent)",
  text: "var(--text-faint)",
};

interface ActivityDotProps {
  activity: ActivityState | null;
  dotOnly?: boolean;
  size?: number;
}

export function ActivityDot({ activity, dotOnly = false, size = 6 }: ActivityDotProps) {
  const c = activity !== null && activity in activityConfig
    ? activityConfig[activity]
    : { ...fallbackConfig, label: activity ?? "unknown" };
  const isPulsing = activity === "active";

  if (dotOnly) {
    return (
      <div
        className={`shrink-0 rounded-full ${isPulsing ? "attention-glow" : ""}`}
        style={{ width: size, height: size, background: c.dot }}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5"
      style={{ background: c.bg }}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${isPulsing ? "attention-glow" : ""}`}
        style={{ background: c.dot }}
      />
      <span className="text-[10px] font-medium" style={{ color: c.text }}>
        {c.label}
      </span>
    </span>
  );
}
