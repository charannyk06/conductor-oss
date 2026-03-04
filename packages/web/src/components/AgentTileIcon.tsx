"use client";

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";

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
  className = "h-4 w-4",
}: {
  seed: AgentTileIconSeed | null | undefined;
  className?: string;
}) {
  const { theme } = useTheme();
  const [failed, setFailed] = useState(false);
  const label = seed?.label?.trim() ?? "";

  const { localSrc, externalSrc } = useMemo(() => {
    if (!label) return { localSrc: null as string | null, externalSrc: null as string | null };
    const key = resolveAgentIconKey({ label, iconUrl: seed?.iconUrl, homepage: seed?.homepage });
    const suffix = theme === "light" ? "-light" : "-dark";
    return {
      localSrc: key ? `/agents/${key}${suffix}.svg` : null,
      externalSrc: typeof seed?.iconUrl === "string" && seed.iconUrl.trim().length > 0 ? seed.iconUrl.trim() : null,
    };
  }, [label, seed?.homepage, seed?.iconUrl, theme]);

  useEffect(() => {
    setFailed(false);
  }, [localSrc, externalSrc, label]);

  if (!label) {
    return <DefaultAgentIcon label="AI" className={className} />;
  }

  const src = failed ? null : (localSrc ?? externalSrc);
  if (!src) {
    return <DefaultAgentIcon label={label} className={className} />;
  }

  return (
    <img
      src={src}
      alt={`${label} icon`}
      loading="lazy"
      className={`${className} shrink-0 rounded-[0.2rem] object-contain`}
      onError={() => setFailed(true)}
    />
  );
}
