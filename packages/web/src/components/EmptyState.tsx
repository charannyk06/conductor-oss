"use client";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      {/* Illustrated icon */}
      <div className="mb-6 flex items-center justify-center">
        <div className="relative">
          <svg
            width="80"
            height="80"
            viewBox="0 0 80 80"
            fill="none"
            className="opacity-30"
          >
            <rect
              x="12"
              y="16"
              width="56"
              height="48"
              rx="6"
              stroke="var(--color-text-tertiary)"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
            <path
              d="M28 36L36 44L52 28"
              stroke="var(--color-accent)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-60"
            />
            <circle
              cx="40"
              cy="36"
              r="20"
              stroke="var(--color-text-muted)"
              strokeWidth="1.5"
              strokeDasharray="3 4"
              className="opacity-40"
            />
          </svg>
        </div>
      </div>

      <h3 className="text-[15px] font-semibold text-[var(--color-text-primary)] mb-2">
        No sessions yet
      </h3>
      <p className="text-[13px] text-[var(--color-text-secondary)] max-w-sm leading-relaxed mb-4">
        Write a task in your <code className="rounded bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[12px] font-mono text-[var(--color-accent)]">CONDUCTOR.md</code> to get started.
      </p>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Sessions will appear here once agents begin working.
      </p>
    </div>
  );
}
