"use client";

function getDiffSizeLabel(additions: number, deletions: number): string {
  const total = additions + deletions;
  if (total < 10) return "XS";
  if (total < 50) return "S";
  if (total < 200) return "M";
  if (total < 500) return "L";
  return "XL";
}

interface DiffSizeBadgeProps {
  additions: number;
  deletions: number;
  compact?: boolean;
}

export function DiffSizeBadge({ additions, deletions, compact }: DiffSizeBadgeProps) {
  const sizeLabel = getDiffSizeLabel(additions, deletions);

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--vk-bg-panel)] px-1.5 py-0.5 font-mono text-[10px] font-semibold">
      <span className="text-[var(--status-ready)]">+{additions}</span>
      <span className="text-[var(--status-error)]">-{deletions}</span>
      {!compact && (
        <span className="text-[var(--text-faint)]">{sizeLabel}</span>
      )}
    </span>
  );
}
