"use client";

import { useEffect, useMemo, useState } from "react";

export type AgentTileIconSeed = {
  label: string;
  iconUrl?: string | null;
  homepage?: string | null;
};

type AgentIconKey =
  | "amp"
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "droid"
  | "gemini"
  | "opencode"
  | "qwen";

const AGENT_ICON_ALIASES: Record<AgentIconKey, string[]> = {
  amp: ["amp", "amp-code", "amp-cli", "ampcode", "agent-amp"],
  claude: [
    "claude",
    "claude-code",
    "claude-cli",
    "claudecode",
    "ccr",
    "claude-code-router",
    "claude-mcp",
    "claude-mcp-cli",
    "claude-mcp-agent",
    "agent-claude-code",
  ],
  codex: ["codex", "openai-codex", "codex-cli", "codexcli", "openai", "agent-codex"],
  copilot: ["copilot", "github-copilot", "githubcopilot", "copilot-cli", "agent-github-copilot"],
  cursor: ["cursor", "cursor-cli", "cursor-agent", "cursoragent", "agent-cursor-cli"],
  droid: ["droid", "factory-droid", "factory_droid", "agent-droid"],
  gemini: ["gemini", "gemini-cli", "google-gemini", "googlegemini", "agent-gemini"],
  opencode: ["opencode", "open-code", "open_code", "open-code-cli", "agent-opencode"],
  qwen: ["qwen", "qwen-code", "qwen_code", "qwen-code-cli", "agent-qwen-code"],
};

const ALIAS_TO_ICON = new Map<string, AgentIconKey>();
for (const [iconKey, aliases] of Object.entries(AGENT_ICON_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_ICON.set(normalize(alias), iconKey as AgentIconKey);
  }
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveAlias(value: string): AgentIconKey | null {
  const normalized = normalize(value);
  if (!normalized) return null;

  const direct = ALIAS_TO_ICON.get(normalized);
  if (direct) return direct;

  for (const token of normalized.split("-")) {
    const byToken = ALIAS_TO_ICON.get(token);
    if (byToken) return byToken;
  }

  for (const [alias, iconKey] of ALIAS_TO_ICON.entries()) {
    if (
      normalized === alias ||
      normalized.startsWith(`${alias}-`) ||
      normalized.endsWith(`-${alias}`) ||
      normalized.includes(`-${alias}-`)
    ) {
      return iconKey;
    }
  }

  return null;
}

function resolveFromUrl(value: string): AgentIconKey | null {
  try {
    const parsed = new URL(value);
    const hostKey = resolveAlias(parsed.hostname.replace(/^www\./, "").replace(/\./g, "-"));
    if (hostKey) return hostKey;
    return resolveAlias(parsed.pathname.replace(/\//g, "-"));
  } catch {
    return resolveAlias(value);
  }
}

function resolveAgentIconKey(seed: AgentTileIconSeed): AgentIconKey | null {
  return resolveAlias(seed.label) ??
    (seed.homepage ? resolveFromUrl(seed.homepage) : null) ??
    (seed.iconUrl ? resolveFromUrl(seed.iconUrl) : null);
}

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
    const key = resolveAgentIconKey({ label, iconUrl: seed?.iconUrl, homepage: seed?.homepage });
    const externalSrc = typeof seed?.iconUrl === "string" && seed.iconUrl.trim().length > 0
      ? seed.iconUrl.trim()
      : null;

    const list: string[] = [];
    if (key) {
      // The app uses a dark surface; prefer high-contrast dark variants first.
      list.push(`/agents/${key}-dark.svg`);
      list.push(`/agents/${key}-light.svg`);
    }
    if (externalSrc) list.push(externalSrc);
    return list;
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
