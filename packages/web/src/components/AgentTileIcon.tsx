"use client";

import { useEffect, useMemo, useState } from "react";

export type AgentTileIconSeed = {
  label: string;
  iconUrl?: string | null;
  homepage?: string | null;
};

function normalizeAgentName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function asSimpleIconSlug(value: string): string {
  return normalizeAgentName(value)
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseGithubRepo(url: string): { owner: string; name: string } | null {
  try {
    const normalized = new URL(url);
    const parts = normalized.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], name: parts[1] };
  } catch {
    return null;
  }
}

const BRANDED_ICON_HINTS: Record<string, string> = {
  "claude-code": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
  claudecode: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
  claude: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
  "claude code": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
  codex: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
  "openai-codex": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
  "openai codex": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
  "github-copilot": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
  "copilot-cli": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
  gemini: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
  "google-gemini": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
  amp: "https://ampcode.com/amp-mark-color.svg",
  "amp-code": "https://ampcode.com/amp-mark-color.svg",
  cursor: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
  "droid-cli": "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
  droid: "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
  "claude-code-router": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
};

function getSeededColor(seed: string): string {
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

function getAgentIconUrls(seed: AgentTileIconSeed): string[] {
  const urls: string[] = [];
  const iconSeed = normalizeAgentName(seed.label);
  if (!iconSeed) return [];

  if (seed.iconUrl) {
    const direct = seed.iconUrl.trim();
    if (direct) urls.push(direct);
  }

  if (BRANDED_ICON_HINTS[iconSeed]) {
    urls.push(BRANDED_ICON_HINTS[iconSeed]);
  }

  const simpleIconCandidates = [
    asSimpleIconSlug(seed.label),
    asSimpleIconSlug(iconSeed),
    asSimpleIconSlug(iconSeed).replace(/-cli$/u, ""),
  ];
  const simpleIconCandidatesUnique = [...new Set(simpleIconCandidates.filter(Boolean))];
  for (const candidate of simpleIconCandidatesUnique) {
    urls.push(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${candidate}.svg`);
  }

  if (seed.homepage) {
    try {
      const homepage = new URL(seed.homepage);
      const homepageOrigin = `${homepage.origin}`;
      const repo = parseGithubRepo(seed.homepage);
      urls.push(`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(homepageOrigin)}`);
      urls.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(homepage.hostname)}`);
      urls.push(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(homepage.hostname)}.ico`);
      urls.push(`https://api.faviconkit.com/${encodeURIComponent(homepage.hostname)}/64`);
      if (repo) {
        const owner = encodeURIComponent(repo.owner);
        const project = encodeURIComponent(repo.name);
        urls.push(`https://opengraph.githubassets.com/1/${owner}/${project}`);
        const repoIconFiles = [
          ".github/logo.png",
          ".github/favicon.png",
          ".github/logo.svg",
          "assets/logo.png",
          "assets/favicon.png",
          "favicon.ico",
          "public/favicon.ico",
          "assets/favicon.ico",
          "logo.png",
          "favicon.png",
          "logo.svg",
        ];
        urls.push(...repoIconFiles.map((file) => `https://raw.githubusercontent.com/${owner}/${project}/HEAD/${file}`));
      }
    } catch {
      // ignore malformed URL values
    }
  }

  return [...new Set(urls.filter(Boolean))];
}

function DefaultAgentIcon({ label, className }: { label: string; className: string }) {
  const display = label
    .split(/[^a-z0-9]/iu)
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase())
    .join("");

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-[0.2rem] text-[9px] font-semibold text-white ${className}`}
      style={{ backgroundColor: getSeededColor(`${label}:${label.length}`) }}
    >
      {display || "AI"}
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
  const label = seed?.label?.trim() ?? "";
  const [iconErrorIndex, setIconErrorIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const iconUrls = useMemo(() => {
    if (!label) return [];
    return getAgentIconUrls({ label, iconUrl: seed?.iconUrl, homepage: seed?.homepage });
  }, [label, seed?.iconUrl, seed?.homepage]);

  useEffect(() => {
    setIconErrorIndex(0);
    setLoaded(false);
  }, [iconUrls]);

  useEffect(() => {
    setLoaded(false);
  }, [iconErrorIndex]);

  const shouldUseFallback = !label || !iconUrls[iconErrorIndex];

  if (shouldUseFallback) {
    return <DefaultAgentIcon label={label || "AI"} className={className} />;
  }

  return (
    <span className="relative inline-flex">
      {!loaded && <DefaultAgentIcon label={label} className={className} />}
      <img
        src={iconUrls[iconErrorIndex]}
        alt={`${label} icon`}
        loading="lazy"
        className={`${className} shrink-0 rounded-[0.2rem] border border-[var(--color-border-subtle)] bg-white object-contain ${loaded ? "inline-flex" : "hidden"}`}
        onError={() => setIconErrorIndex((index) => index + 1)}
        onLoad={() => setLoaded(true)}
      />
    </span>
  );
}
