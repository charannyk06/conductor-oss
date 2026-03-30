"use client";

import { useEffect, useMemo, useState } from "react";
import {
  resolveAgentIconSources,
  type AgentTileIconSeed,
} from "@/components/agentIconSources";

function getFallbackColor(seed: string): string {
  const palette = [
    "#14b8a6",
    "#06b6d4",
    "#0ea5e9",
    "#8b5cf6",
    "#ec4899",
    "#f97316",
    "#f59e0b",
    "#ef4444",
    "#22c55e",
    "#84cc16",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % palette.length;
  }
  return palette[Math.abs(hash) % palette.length] ?? "#6b7280";
}

function DefaultAgentIcon({ label, className }: { label: string; className: string }) {
  const initials = label
    .split(/[^a-z0-9]/iu)
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase())
    .join("");

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-[0.2rem] text-[9px] font-semibold text-white ${className}`}
      style={{ backgroundColor: getFallbackColor(`${label}:${label.length}`) }}
    >
      {initials || "AI"}
    </span>
  );
}

export function AgentTileIcon({
  seed,
  className = "h-6 w-6",
}: {
  seed: AgentTileIconSeed | null | undefined;
  className?: string;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const label = seed?.label?.trim() ?? "";

  const sources = useMemo(() => {
    if (!label) return [] as string[];
    return resolveAgentIconSources({ label, iconUrl: seed?.iconUrl, homepage: seed?.homepage });
  }, [label, seed?.homepage, seed?.iconUrl]);

  useEffect(() => {
    setSourceIndex(0);
  }, [label, sources]);

  if (!label) {
    return <DefaultAgentIcon label="AI" className={className} />;
  }

  const src = sources[sourceIndex] ?? null;
  if (!src) {
    return <DefaultAgentIcon label={label} className={className} />;
  }

  return (
    <img
      src={src}
      alt={`${label} icon`}
      loading="lazy"
      className={`${className} shrink-0 rounded-[0.2rem] object-contain scale-125`}
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}
