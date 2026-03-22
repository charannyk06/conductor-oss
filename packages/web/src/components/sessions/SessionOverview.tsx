"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  DollarSign,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  Timer,
} from "lucide-react";
import type { DashboardSession } from "@/lib/types";
import { AgentTileIcon } from "@/components/AgentTileIcon";

const SessionDiff = dynamic(
  () => import("./SessionDiff").then((mod) => mod.SessionDiff),
  {
    loading: () => (
      <div className="flex h-32 items-center justify-center text-[12px] text-[var(--vk-text-muted)]">
        Loading changes…
      </div>
    ),
    ssr: false,
  },
);

type SessionData = DashboardSession & {
  agent?: string;
  worktree?: string | null;
  cost?: number;
  task?: string;
  prompt?: string;
  startedAt?: string;
  finishedAt?: string;
};

interface SessionOverviewProps {
  session: SessionData;
  sessionId: string;
  active: boolean;
}

type OverviewTab = "changes" | "files";

/* ─── File tree types ───────────────────────────────────────────────── */

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  isDir: boolean;
}

interface FilesPayload {
  workspacePath: string;
  files: string[];
  truncated: boolean;
}

/* ─── Helpers ───────────────────────────────────────────────────────── */

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // silently fail
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex max-w-[180px] items-center gap-1 font-mono text-[11px] text-[var(--vk-text-muted)] transition-colors hover:text-[var(--vk-text-normal)]"
    >
      <span className="truncate">{text}</span>
      {copied
        ? <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        : <Copy className="h-3 w-3 shrink-0 opacity-50" />}
    </button>
  );
}

function getDuration(start?: string | null, finish?: string | null): string {
  if (!start || !finish) return "";
  const startMs = new Date(start).getTime();
  const finishMs = new Date(finish).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return "";
  const minutes = Math.floor((finishMs - startMs) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseCost(session: SessionData): number {
  if (typeof session.cost === "number") return session.cost;
  const raw = session.metadata["cost"];
  if (typeof raw !== "string") return 0;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // HUMAN-REVIEWED: display-only, no billing impact
    const estimated = typeof parsed.estimatedCostUsd === "number" ? parsed.estimatedCostUsd : 0;
    const total = typeof parsed.totalUSD === "number" ? parsed.totalUSD : 0;
    return estimated ?? total;
  } catch {
    return 0;
  }
}

function pickMetadata(session: SessionData, key: string): string | undefined {
  const value = session.metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parsePositiveInteger(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/* ─── File tree builder ─────────────────────────────────────────────── */

function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], isDir: true };

  for (const filePath of paths) {
    const parts = filePath.split("/");
    let current = root;
    let accumulated = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const isLast = i === parts.length - 1;

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: accumulated, children: [], isDir: !isLast };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort: directories first, then alphabetical
  function sortTree(nodes: TreeNode[]): TreeNode[] {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) {
      if (node.children.length > 0) sortTree(node.children);
    }
    return nodes;
  }

  return sortTree(root.children);
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) return nodes;
  const lowerQuery = query.toLowerCase();

  function matches(node: TreeNode): boolean {
    if (node.name.toLowerCase().includes(lowerQuery)) return true;
    if (node.path.toLowerCase().includes(lowerQuery)) return true;
    return node.children.some(matches);
  }

  function prune(nodeList: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    for (const node of nodeList) {
      if (!matches(node)) continue;
      if (node.isDir) {
        result.push({ ...node, children: prune(node.children) });
      } else {
        result.push(node);
      }
    }
    return result;
  }

  return prune(nodes);
}

/* ─── File tree node component ──────────────────────────────────────── */

function FileTreeNode({
  node,
  depth,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = node.path === selectedPath;
  const paddingLeft = 8 + depth * 16;

  if (node.isDir) {
    return (
      <>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          className="flex w-full items-center gap-1.5 py-1.5 text-left text-[12px] text-[var(--vk-text-muted)] hover:bg-white/4 active:bg-white/6"
          style={{ paddingLeft }}
        >
          {isExpanded
            ? <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            : <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
          {isExpanded
            ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
            : <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />}
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded ? (
          node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))
        ) : null}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      className={`flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-[12px] transition-colors ${
        isSelected
          ? "bg-blue-500/10 text-[var(--vk-text-strong)]"
          : "text-[var(--vk-text-normal)] hover:bg-white/4"
      }`}
      style={{ paddingLeft: paddingLeft + 16 }}
    >
      <File className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/* ─── File language detection ──────────────────────────────────────── */

const EXT_TO_LANG: Record<string, string> = {
  // Web
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  vue: "vue", svelte: "svelte", astro: "astro",
  // Data / Config
  json: "json", jsonc: "jsonc", json5: "json5",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  xml: "xml", svg: "xml", plist: "xml",
  csv: "csv", tsv: "csv",
  // Docs / Markup
  md: "markdown", mdx: "mdx", tex: "latex", rst: "rst",
  // Systems
  rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
  hpp: "cpp", hh: "cpp", cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin",
  scala: "scala", swift: "swift", m: "objective-c", mm: "objective-cpp",
  zig: "zig", nim: "nim", v: "v", d: "d",
  // Scripting
  py: "python", pyi: "python", rb: "ruby", php: "php",
  pl: "perl", pm: "perl", lua: "lua", r: "r", R: "r",
  jl: "julia", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang",
  hs: "haskell", lhs: "haskell", clj: "clojure", cljs: "clojure",
  ml: "ocaml", mli: "ocaml", fs: "fsharp", fsx: "fsharp",
  // Shell / Ops
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat",
  dockerfile: "dockerfile", containerfile: "dockerfile",
  // DevOps / IaC
  tf: "hcl", hcl: "hcl", nix: "nix",
  // Query
  sql: "sql", graphql: "graphql", gql: "graphql", prisma: "prisma",
  // Other
  proto: "protobuf", thrift: "thrift",
  makefile: "makefile", cmake: "cmake",
  asm: "asm", s: "asm",
  diff: "diff", patch: "diff",
  log: "log", txt: "plaintext",
  env: "dotenv",
  lock: "json",
};

/** Known file names without extensions */
const FILENAME_TO_LANG: Record<string, string> = {
  makefile: "makefile", Makefile: "makefile",
  dockerfile: "dockerfile", Dockerfile: "dockerfile",
  containerfile: "dockerfile", Containerfile: "dockerfile",
  gemfile: "ruby", Gemfile: "ruby",
  rakefile: "ruby", Rakefile: "ruby",
  cmakelists: "cmake", CMakeLists: "cmake",
  ".gitignore": "gitignore", ".dockerignore": "gitignore",
  ".editorconfig": "ini", ".prettierrc": "json",
  ".eslintrc": "json", ".babelrc": "json",
  ".env": "dotenv", ".env.local": "dotenv", ".env.production": "dotenv",
  "tsconfig.json": "jsonc", "jsconfig.json": "jsonc",
};

/** Image extensions we can show inline */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

function getLangFromPath(filePath: string): string {
  const fileName = filePath.split("/").pop() ?? "";

  // Check exact filename match
  if (FILENAME_TO_LANG[fileName]) return FILENAME_TO_LANG[fileName];

  // Check extension
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = fileName.slice(dotIdx + 1).toLowerCase();
    if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  }

  return "plaintext";
}

function getExtension(filePath: string): string {
  const fileName = filePath.split("/").pop() ?? "";
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "";
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(getExtension(filePath));
}

/* ─── Syntax-highlighted code viewer ───────────────────────────────── */

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const codeRef = useRef<string>(code);
  const langRef = useRef<string>(lang);

  useEffect(() => {
    codeRef.current = code;
    langRef.current = lang;
    let cancelled = false;

    void (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        if (cancelled) return;
        const result = await codeToHtml(code, {
          lang,
          theme: "github-dark-default",
        });
        if (!cancelled && codeRef.current === code && langRef.current === lang) {
          setHtml(result);
        }
      } catch {
        // If lang isn't supported, fall back to plaintext
        if (cancelled) return;
        try {
          const { codeToHtml } = await import("shiki");
          if (cancelled) return;
          const result = await codeToHtml(code, {
            lang: "plaintext",
            theme: "github-dark-default",
          });
          if (!cancelled) setHtml(result);
        } catch {
          // Give up on highlighting
          if (!cancelled) setHtml(null);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code, lang]);

  // Show plain text with line numbers while shiki loads (or if it fails)
  if (!html) {
    const lines = code.split("\n");
    const gutterWidth = String(lines.length).length;
    return (
      <div className="inline-block min-w-full align-top">
        <table className="min-w-full border-collapse font-mono text-[11px] leading-5">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-white/3">
                <td className="select-none whitespace-nowrap border-r border-white/6 px-2 text-right text-[var(--vk-text-muted)] opacity-40" style={{ minWidth: `${gutterWidth + 2}ch` }}>
                  {i + 1}
                </td>
                <td className="whitespace-pre px-3 text-[var(--vk-text-normal)]">
                  {line || "\u00A0"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div
      className="shiki-viewer inline-block min-w-full align-top [&_.shiki]:!bg-transparent [&_.shiki]:p-0 [&_code]:text-[11px] [&_code]:leading-5 [&_pre]:!bg-transparent [&_pre]:!p-0"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is trusted
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* ─── File viewer panel ─────────────────────────────────────────────── */

function FileContentViewer({ sessionId, filePath }: { sessionId: string; filePath: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [fileSize, setFileSize] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setBinary(false);
    setTruncated(false);
    setFileSize(0);

    const params = new URLSearchParams({ path: filePath });
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?${params.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        return res.json() as Promise<{ content?: string | null; binary?: boolean; size?: number; truncated?: boolean }>;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.binary) {
          setBinary(true);
        } else {
          setContent(typeof data.content === "string" ? data.content : "");
        }
        setTruncated(Boolean(data.truncated));
        setFileSize(typeof data.size === "number" ? data.size : 0);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [sessionId, filePath]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--vk-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-red-400">
        {error}
      </div>
    );
  }

  /* Binary but an image — attempt inline preview */
  if (binary && isImageFile(filePath)) {
    const params = new URLSearchParams({ path: filePath, raw: "1" });
    const src = `/api/sessions/${encodeURIComponent(sessionId)}/files?${params.toString()}`;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={filePath} className="max-h-[60vh] max-w-full rounded-md object-contain" />
        <span className="text-[11px] text-[var(--vk-text-muted)]">
          {filePath.split("/").pop()}
          {fileSize > 0 ? ` · ${formatBytes(fileSize)}` : ""}
        </span>
      </div>
    );
  }

  if (binary) {
    const ext = getExtension(filePath);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <div className="rounded-lg bg-white/4 p-4">
          <File className="mx-auto h-8 w-8 text-[var(--vk-text-muted)]" />
        </div>
        <p className="text-[12px] text-[var(--vk-text-muted)]">
          Binary file{ext ? ` (.${ext})` : ""} — preview not available
        </p>
        {fileSize > 0 ? (
          <p className="text-[11px] text-[var(--vk-text-muted)] opacity-60">{formatBytes(fileSize)}</p>
        ) : null}
      </div>
    );
  }

  const lang = getLangFromPath(filePath);
  const textContent = content ?? "";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1 text-[11px] text-amber-300">
          File truncated{fileSize > 0 ? ` (${formatBytes(fileSize)} total)` : ""}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain touch-pan-x touch-pan-y py-2">
        <HighlightedCode code={textContent} lang={lang} />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─── Files browser component ───────────────────────────────────────── */

function FilesBrowser({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load files (${res.status})`);
      const data = (await res.json()) as FilesPayload;
      if (!mountedRef.current) return;
      setFiles(data.files ?? []);
      setTruncated(Boolean(data.truncated));
      setError(null);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    if (active) void fetchFiles();
    return () => { mountedRef.current = false; };
  }, [active, fetchFiles]);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const filtered = useMemo(() => filterTree(tree, search.trim()), [tree, search]);

  // Auto-expand top-level dirs when searching
  useEffect(() => {
    if (search.trim()) {
      const topDirs = new Set<string>();
      function collectDirs(nodes: TreeNode[]) {
        for (const n of nodes) {
          if (n.isDir) {
            topDirs.add(n.path);
            collectDirs(n.children);
          }
        }
      }
      collectDirs(filtered);
      setExpandedDirs(topDirs);
    }
  }, [filtered, search]);

  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedPath(null);
  }, []);

  if (loading && files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--vk-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading workspace files…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-[12px] text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => void fetchFiles()}
          className="text-[11px] text-[var(--vk-text-muted)] underline hover:text-[var(--vk-text-normal)]"
        >
          Retry
        </button>
      </div>
    );
  }

  /* ── Mobile: show file preview full-screen with back button ── */
  const mobileFilePreview = selectedPath ? (
    <div className="flex h-full min-h-0 min-w-0 flex-col lg:hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-2 py-2">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--vk-text-muted)] hover:bg-white/6"
          aria-label="Back to file list"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <File className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
        <span className="truncate font-mono text-[11px] text-[var(--vk-text-strong)]">{selectedPath}</span>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <FileContentViewer sessionId={sessionId} filePath={selectedPath} />
      </div>
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain lg:overflow-hidden">
      {/* Mobile: if a file is selected, show preview full-width instead of tree */}
      {mobileFilePreview}

      {/* Search + refresh bar — hidden on mobile when previewing a file */}
      <div className={`flex shrink-0 items-center gap-2 border-b border-white/8 px-2 py-1.5 ${selectedPath ? "hidden lg:flex" : ""}`}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white/4 px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
          />
        </div>
        <button
          type="button"
          onClick={() => void fetchFiles()}
          disabled={loading}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--vk-text-muted)] hover:bg-white/6 disabled:opacity-50"
          aria-label="Refresh files"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {truncated ? (
        <div className={`shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-300 ${selectedPath ? "hidden lg:block" : ""}`}>
          File list truncated (4000 file limit)
        </div>
      ) : null}

      {/* Desktop: side-by-side tree + preview.  Mobile: tree only (preview shown above) */}
      <div className={`min-h-0 flex-1 lg:flex lg:flex-row ${selectedPath ? "hidden lg:flex" : "flex flex-col"}`}>
        {/* File tree */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 lg:max-w-[320px] lg:border-r lg:border-white/8">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--vk-text-muted)]">
              {search ? "No files match your search." : "No files in workspace."}
            </div>
          ) : (
            filtered.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                expandedDirs={expandedDirs}
                onToggleDir={handleToggleDir}
                onSelectFile={handleSelectFile}
              />
            ))
          )}
        </div>

        {/* Desktop file preview (hidden on mobile — mobile uses the full-screen overlay above) */}
        <div className="hidden min-h-0 min-w-0 flex-1 lg:block">
          {selectedPath ? (
            <div className="flex h-full min-h-0 min-w-0 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-2">
                <File className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
                <span className="truncate font-mono text-[11px] text-[var(--vk-text-strong)]">{selectedPath}</span>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <FileContentViewer sessionId={sessionId} filePath={selectedPath} />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-[var(--vk-text-muted)]">
              Select a file to view its contents
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main Overview component ───────────────────────────────────────── */

export function SessionOverview({ session, sessionId, active }: SessionOverviewProps) {
  const [innerTab, setInnerTab] = useState<OverviewTab>("changes");

  const prompt = useMemo(
    () => (
      pickMetadata(session, "task")
      ?? pickMetadata(session, "prompt")
      ?? (typeof session.task === "string" ? session.task : "")
      ?? (typeof session.prompt === "string" ? session.prompt : "")
    ),
    [session],
  );

  const agentName = useMemo(
    () => pickMetadata(session, "agent") ?? (typeof session.agent === "string" ? session.agent : ""),
    [session],
  );

  const duration = useMemo(
    () => getDuration(
      pickMetadata(session, "startedAt") ?? session.startedAt,
      pickMetadata(session, "finishedAt") ?? session.finishedAt,
    ),
    [session],
  );

  const cost = useMemo(() => parseCost(session), [session]);

  const queuePosition = useMemo(() => parsePositiveInteger(pickMetadata(session, "queuePosition")), [session]);
  const queueDepth = useMemo(() => parsePositiveInteger(pickMetadata(session, "queueDepth")), [session]);
  const recoveryState = useMemo(() => pickMetadata(session, "recoveryState") ?? "", [session]);

  const recoveryBanner = useMemo(() => {
    if (session.status === "queued") {
      return queuePosition
        ? `Waiting in queue at position ${queuePosition}${queueDepth ? ` of ${queueDepth}` : ""}.`
        : "Waiting in the launch queue.";
    }
    if (recoveryState === "requeued_after_restart") return "Session recovered after backend restart and requeued.";
    if (recoveryState === "reattach_pending") return "Recovering terminal runtime after backend restart.";
    if (recoveryState === "detached_runtime") return "Backend restarted while agent may still be running.";
    if (recoveryState === "resume_required") return "Session recovered after restart. Send a message to resume.";
    return "";
  }, [queueDepth, queuePosition, recoveryState, session.status]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain lg:overflow-hidden">
      {/* Recovery / queue banner */}
      {recoveryBanner ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-2">
          <p className="text-[12px] leading-snug text-amber-300">{recoveryBanner}</p>
        </div>
      ) : null}

      {/* Task brief */}
      {prompt ? (
        <div className="shrink-0 border-b border-white/8 px-3 py-2.5">
          <p className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--vk-text-normal)]">{prompt}</p>
        </div>
      ) : null}

      {/* Compact meta strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/8 px-3 py-2 text-[11px] text-[var(--vk-text-muted)]">
        {agentName ? (
          <span className="flex items-center gap-1.5">
            <AgentTileIcon seed={{ label: agentName }} className="h-4 w-4" />
            <span>{agentName}</span>
          </span>
        ) : null}
        {session.branch ? (
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3 shrink-0" />
            <CopyText text={session.branch} />
          </span>
        ) : null}
        {duration ? (
          <span className="flex items-center gap-1">
            <Timer className="h-3 w-3 shrink-0" />
            <span>{duration}</span>
          </span>
        ) : null}
        {cost > 0 ? (
          <span className="flex items-center gap-1">
            <DollarSign className="h-3 w-3 shrink-0" />
            <span>${cost.toFixed(3)}</span>
          </span>
        ) : null}
      </div>

      {/* Inner tab switcher: Changes | Files */}
      <div className="flex shrink-0 items-center gap-0 border-b border-white/8 px-2">
        <button
          type="button"
          onClick={() => setInnerTab("changes")}
          className={`px-3 py-2 text-[12px] font-medium transition-colors ${
            innerTab === "changes"
              ? "border-b-2 border-[var(--vk-orange)] text-[var(--vk-text-strong)]"
              : "border-b-2 border-transparent text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]"
          }`}
        >
          Changes
        </button>
        <button
          type="button"
          onClick={() => setInnerTab("files")}
          className={`px-3 py-2 text-[12px] font-medium transition-colors ${
            innerTab === "files"
              ? "border-b-2 border-[var(--vk-orange)] text-[var(--vk-text-strong)]"
              : "border-b-2 border-transparent text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]"
          }`}
        >
          Files
        </button>
      </div>

      {/* Tab content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {innerTab === "changes" ? (
          <SessionDiff key={sessionId} sessionId={sessionId} active={active} />
        ) : (
          <FilesBrowser sessionId={sessionId} active={active && innerTab === "files"} />
        )}
      </div>
    </div>
  );
}
