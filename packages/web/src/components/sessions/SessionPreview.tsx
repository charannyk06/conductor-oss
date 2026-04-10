"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Copy,
  Eye,
  FileJson2,
  Globe,
  Info,
  Loader2,
  MousePointerClick,
  RefreshCw,
  Send,
  TerminalSquare,
  Waypoints,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { selectPreviewAutoConnectCandidate } from "@/lib/previewAutoConnect";
import type {
  PreviewCommandRequest,
  PreviewDomNode,
  PreviewDomResponse,
  PreviewElementSelection,
  PreviewLogEntry,
  PreviewStatusResponse,
} from "@/lib/previewTypes";
import type { TerminalInsertRequest } from "./terminalInsert";

const STATUS_POLL_INTERVAL_MS = 4_000;
const AUTO_CONNECT_RETRY_MS = 5_000;
const MOBILE_PREVIEW_MEDIA_QUERY = "(max-width: 1023px)";
const SELECTION_COMPOSER_WIDTH_PX = 340;
const SELECTION_COMPOSER_HEIGHT_PX = 280;
const SELECTION_COMPOSER_MARGIN_PX = 12;
const MOBILE_SELECTION_COMPOSER_BREAKPOINT_PX = 520;
const PREVIEW_SPECIAL_KEYS = new Map<string, string>([
  ["Backspace", "Backspace"],
  ["Delete", "Delete"],
  ["Enter", "Enter"],
  ["Tab", "Tab"],
  ["Escape", "Escape"],
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
  [" ", "Space"],
]);

interface SessionPreviewProps {
  sessionId: string;
  active: boolean;
  onQueueTerminalInsert: (request: Omit<TerminalInsertRequest, "nonce">) => void;
  onConnectionChange?: (connected: boolean) => void;
}

type PreviewSendTarget = "selection" | "console" | "network";
type PreviewInteractionMode = "navigate" | "inspect";
type SelectionComposerState = {
  anchorX: number;
  anchorY: number;
  pending: boolean;
};

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function quoteInline(value: string | null | undefined, max = 180): string | null {
  const normalized = truncate(normalizeWhitespace(value), max);
  if (!normalized) return null;
  return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildInlineInsert(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("; ");
}

function buildDraftInsert(title: string, lines: Array<string | null | undefined>): string {
  return [
    `[${title}]`,
    ...lines
      .map((line) => line?.trim())
      .filter((line): line is string => Boolean(line)),
  ].join("\n");
}

function buildSelectionInsert(
  selection: PreviewElementSelection,
  currentUrl: string | null,
): Omit<TerminalInsertRequest, "nonce"> {
  return {
    inlineText: buildInlineInsert([
      "[Browser selection]",
      `selector=${quoteInline(selection.selector, 220)}`,
      `tag=${selection.tag}`,
      selection.role ? `role=${selection.role}` : null,
      selection.name ? `name=${quoteInline(selection.name, 140)}` : null,
      selection.text ? `text=${quoteInline(selection.text, 180)}` : null,
      selection.frameName ? `frame=${quoteInline(selection.frameName, 120)}` : null,
      currentUrl ? `page=${quoteInline(currentUrl, 220)}` : null,
    ]),
    draftText: buildDraftInsert("Browser selection", [
      currentUrl ? `Page: ${currentUrl}` : null,
      `Frame: ${selection.frameName} (${selection.frameUrl})`,
      `Selector: ${selection.selector}`,
      `Tag: ${selection.tag}`,
      selection.role ? `Role: ${selection.role}` : null,
      selection.name ? `Name: ${selection.name}` : null,
      selection.text ? `Text: ${selection.text}` : null,
      selection.htmlPreview ? `HTML preview: ${selection.htmlPreview}` : null,
    ]),
    successMessage: "Queued the selected element for terminal input.",
  };
}

function buildLogInsert(
  kind: "console" | "network",
  entries: PreviewLogEntry[],
  currentUrl: string | null,
  selectedElement: PreviewElementSelection | null,
): Omit<TerminalInsertRequest, "nonce"> {
  const title = kind === "console" ? "Browser console logs" : "Browser network logs";
  const recentEntries = entries.slice(kind === "console" ? -8 : -10);
  const inlineEntries = recentEntries.map((entry) => {
    const baseParts = [
      entry.level,
      quoteInline(entry.message, 120),
    ];
    if (kind === "network") {
      baseParts.unshift(entry.method ?? "GET");
      baseParts.push(typeof entry.status === "number" ? String(entry.status) : null);
      baseParts.push(entry.url ? quoteInline(entry.url, 120) : null);
    }
    return baseParts.filter(Boolean).join(" ");
  });

  return {
    inlineText: buildInlineInsert([
      kind === "console" ? "[Browser console]" : "[Browser network]",
      currentUrl ? `page=${quoteInline(currentUrl, 220)}` : null,
      selectedElement ? `selected=${quoteInline(selectedElement.selector, 180)}` : null,
      `entries=${quoteInline(inlineEntries.join(" | "), 520)}`,
    ]),
    draftText: buildDraftInsert(title, [
      currentUrl ? `Page: ${currentUrl}` : null,
      selectedElement ? `Selected element: ${selectedElement.selector}` : null,
      ...recentEntries.map((entry) => {
        if (kind === "console") {
          return `- ${formatTime(entry.timestamp)} ${entry.level}: ${entry.message}`;
        }
        return `- ${formatTime(entry.timestamp)} ${entry.method ?? "GET"} ${entry.status ?? "-"} ${entry.url ?? entry.message}`;
      }),
    ]),
    successMessage: kind === "console"
      ? "Queued recent console logs for terminal input."
      : "Queued recent network logs for terminal input.",
  };
}

type PreviewInfoField = {
  label: string;
  value: string;
  copyValue?: string | null;
  monospace?: boolean;
};

type PreviewInfoSection = {
  id: string;
  title: string;
  description: string;
  fields: PreviewInfoField[];
};

type PreviewCandidateSummary = {
  url: string;
  origin: string | null;
  isLoopback: boolean;
  isPreferred: boolean;
  isConnected: boolean;
  isTunnelOrigin: boolean;
};

const PREVIEW_LOOPBACK_HOST_PATTERN = /(?:127\.0\.0\.1|0\.0\.0\.0|localhost|::1|\[::1\])/i;

function isLoopbackPreviewUrl(value: string): boolean {
  try {
    return PREVIEW_LOOPBACK_HOST_PATTERN.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function readPreviewOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function formatPreviewBoolean(value: boolean | null | undefined): string {
  return value ? "Yes" : "No";
}

function formatPreviewValue(value: string | null | undefined, fallback = "None"): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function PreviewStatCard({
  label,
  value,
  hint,
  monospace = false,
}: {
  label: string;
  value: string;
  hint: string;
  monospace?: boolean;
}) {
  return (
    <div className="rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">{label}</div>
      <div className={cn(
        "mt-1 text-[13px] font-medium text-[var(--vk-text-normal)]",
        monospace ? "break-all font-mono text-[11px] leading-5" : null,
      )}>
        {value}
      </div>
      <div className="mt-1 text-[11px] leading-5 text-[var(--vk-text-muted)]">{hint}</div>
    </div>
  );
}

function PreviewInfoSectionCard({
  section,
  onCopy,
}: {
  section: PreviewInfoSection;
  onCopy: (value: string | null | undefined, successMessage: string) => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
      <div className="border-b border-[var(--vk-border)] px-3 py-3">
        <div className="text-[11px] uppercase tracking-wide text-[var(--vk-text-muted)]">{section.title}</div>
        <div className="mt-1 text-[11px] leading-5 text-[var(--vk-text-muted)]">{section.description}</div>
      </div>
      <div className="divide-y divide-[var(--vk-border)]">
        {section.fields.map((field) => (
          <div key={`${section.id}-${field.label}`} className="flex items-start gap-3 px-3 py-2.5">
            <div className="w-28 shrink-0 text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">
              {field.label}
            </div>
            <div className={cn(
              "min-w-0 flex-1 text-[12px] text-[var(--vk-text-normal)]",
              field.monospace ? "break-all font-mono text-[11px] leading-5" : "leading-5",
            )}>
              {field.value}
            </div>
            {field.copyValue ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => {
                  void onCopy(field.copyValue, `${field.label} copied to clipboard.`);
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SessionPreview({ sessionId, active, onQueueTerminalInsert, onConnectionChange }: SessionPreviewProps) {
  const [status, setStatus] = useState<PreviewStatusResponse | null>(null);
  const [domNodes, setDomNodes] = useState<PreviewDomNode[]>([]);
  const [domLoading, setDomLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [interactiveOnly, setInteractiveOnly] = useState(true);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [sendingTarget, setSendingTarget] = useState<PreviewSendTarget | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewInteractionMode>("navigate");
  const [previewInspectorTab, setPreviewInspectorTab] = useState<"elements" | "console" | "network" | "info" | "proxies">("elements");
  const [selectionComposer, setSelectionComposer] = useState<SelectionComposerState | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [mobileViewport, setMobileViewport] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [imageMetrics, setImageMetrics] = useState({
    naturalWidth: 0,
    naturalHeight: 0,
    renderedWidth: 0,
    renderedHeight: 0,
  });

  const autoConnectRef = useRef<{ candidate: string; attemptedAt: number } | null>(null);
  const previewCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const imageRef = useRef<HTMLImageElement | null>(null);
  const previewSurfaceRef = useRef<HTMLDivElement | null>(null);
  const mountedAtRef = useRef(Date.now());
  const firstStatusLoadedAtRef = useRef<number | null>(null);
  const firstConnectedAtRef = useRef<number | null>(null);
  const lastConnectedAtRef = useRef<number | null>(null);
  const statusLoadCountRef = useRef(0);
  const statusLoadFailureCountRef = useRef(0);
  const statusPollCountRef = useRef(0);
  const commandCountRef = useRef(0);
  const commandFailureCountRef = useRef(0);
  const domLoadCountRef = useRef(0);
  const domLoadFailureCountRef = useRef(0);
  const autoConnectAttemptCountRef = useRef(0);
  const screenshotLoadCountRef = useRef(0);
  const [pageVisible, setPageVisible] = useState(true);
  const shouldRunPreview = active && pageVisible;
  const autoConnectCandidate = selectPreviewAutoConnectCandidate(status?.candidateUrls ?? []);
  const showMobileInspector = mobileViewport && mobileInspectorOpen;
  const showCandidateChips = !mobileViewport || mobileInspectorOpen;

  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_PREVIEW_MEDIA_QUERY);
    const updateViewport = () => {
      setMobileViewport(mediaQuery.matches);
    };

    updateViewport();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateViewport);
      return () => {
        mediaQuery.removeEventListener("change", updateViewport);
      };
    }

    mediaQuery.addListener(updateViewport);
    return () => {
      mediaQuery.removeListener(updateViewport);
    };
  }, []);

  useEffect(() => {
    mountedAtRef.current = Date.now();
    firstStatusLoadedAtRef.current = null;
    firstConnectedAtRef.current = null;
    lastConnectedAtRef.current = null;
    statusLoadCountRef.current = 0;
    statusLoadFailureCountRef.current = 0;
    statusPollCountRef.current = 0;
    commandCountRef.current = 0;
    commandFailureCountRef.current = 0;
    domLoadCountRef.current = 0;
    domLoadFailureCountRef.current = 0;
    autoConnectAttemptCountRef.current = 0;
    screenshotLoadCountRef.current = 0;
    setMobileInspectorOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!mobileViewport) {
      setMobileInspectorOpen(false);
    }
  }, [mobileViewport]);

  const loadStatus = useCallback(async (reason: "initial" | "poll" | "manual" = "manual") => {
    statusLoadCountRef.current += 1;
    if (reason === "poll") {
      statusPollCountRef.current += 1;
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as
        | PreviewStatusResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload && "error" in payload ? payload.error ?? "Failed to load preview state" : `Failed to load preview state: ${response.status}`);
      }

      const now = Date.now();
      if (firstStatusLoadedAtRef.current === null) {
        firstStatusLoadedAtRef.current = now;
      }
      setStatus(payload as PreviewStatusResponse);
      setCommandError(null);
      setUrlInput((current) => {
        const nextStatus = payload as PreviewStatusResponse;
        if (current.trim().length > 0 && current !== nextStatus.currentUrl) {
          return current;
        }
        return nextStatus.currentUrl
          ?? selectPreviewAutoConnectCandidate(nextStatus.candidateUrls)
          ?? nextStatus.candidateUrls[0]
          ?? current;
      });
    } catch (error) {
      statusLoadFailureCountRef.current += 1;
      throw error;
    }
  }, [sessionId]);

  const runCommand = useCallback(async (command: PreviewCommandRequest): Promise<PreviewStatusResponse> => {
    commandCountRef.current += 1;
    setBusy(true);
    setCommandError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });
      const payload = await response.json().catch(() => null) as
        | PreviewStatusResponse
        | { error?: string; status?: PreviewStatusResponse }
        | null;

      if (!response.ok) {
        if (payload && typeof payload === "object" && "status" in payload && payload.status) {
          setStatus(payload.status);
        }
        throw new Error(payload && "error" in payload ? payload.error ?? "Preview command failed" : `Preview command failed: ${response.status}`);
      }

      const nextStatus = payload as PreviewStatusResponse;
      setStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      commandFailureCountRef.current += 1;
      throw error;
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const queuePreviewCommand = useCallback((command: PreviewCommandRequest, fallbackMessage: string) => {
    previewCommandQueueRef.current = previewCommandQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await runCommand(command);
        } catch (error) {
          setCommandError(error instanceof Error ? error.message : fallbackMessage);
        }
      });
  }, [runCommand]);

  const loadDom = useCallback(async (frameId?: string | null) => {
    if (!status?.connected) {
      setDomNodes([]);
      return;
    }

    domLoadCountRef.current += 1;
    setDomLoading(true);
    try {
      const searchParams = new URLSearchParams();
      if (frameId) searchParams.set("frameId", frameId);
      if (interactiveOnly) searchParams.set("interactiveOnly", "1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview/dom?${searchParams.toString()}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as
        | PreviewDomResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload ? payload.error ?? "Failed to inspect DOM" : `Failed to inspect DOM: ${response.status}`);
      }
      setDomNodes((payload as PreviewDomResponse).nodes);
    } catch (error) {
      domLoadFailureCountRef.current += 1;
      setCommandError(error instanceof Error ? error.message : "Failed to inspect DOM");
      setDomNodes([]);
    } finally {
      setDomLoading(false);
    }
  }, [interactiveOnly, sessionId, status?.connected]);

  useEffect(() => {
    if (!shouldRunPreview) {
      return;
    }

    let mounted = true;

    (async () => {
      try {
        await loadStatus("initial");
      } catch (error) {
        if (mounted) {
          setCommandError(error instanceof Error ? error.message : "Failed to load preview");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();

    const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
    const pollInterval = isMobile ? STATUS_POLL_INTERVAL_MS * 2 : STATUS_POLL_INTERVAL_MS;
    const intervalId = window.setInterval(() => {
      void loadStatus("poll").catch((error: unknown) => {
        if (mounted) {
          setCommandError(error instanceof Error ? error.message : "Failed to refresh preview");
        }
      });
    }, pollInterval);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [loadStatus, shouldRunPreview]);

  useEffect(() => {
    if (!status?.connected) {
      setDomNodes([]);
      return;
    }
    if (!shouldRunPreview) {
      return;
    }
    void loadDom(status.activeFrameId);
  }, [interactiveOnly, loadDom, shouldRunPreview, status?.activeFrameId, status?.connected, status?.screenshotKey]);

  useEffect(() => {
    if (!shouldRunPreview) {
      return;
    }

    if (status?.connected) {
      autoConnectRef.current = null;
      return;
    }

    setSelectionComposer(null);

    const candidate = autoConnectCandidate;
    if (!candidate) return;
    const lastAttempt = autoConnectRef.current?.attemptedAt ?? Number.NaN;
    const lastCandidate = autoConnectRef.current?.candidate ?? null;
    const now = Date.now();
    if (lastCandidate === candidate && Number.isFinite(lastAttempt) && now - lastAttempt < AUTO_CONNECT_RETRY_MS) {
      return;
    }

    autoConnectRef.current = { candidate, attemptedAt: now };
    autoConnectAttemptCountRef.current += 1;
    void runCommand({ command: "connect", url: candidate }).catch((error: unknown) => {
      setCommandError(error instanceof Error ? error.message : "Failed to connect preview");
    });
  }, [autoConnectCandidate, runCommand, shouldRunPreview, status?.connected]);

  useEffect(() => {
    if (status?.connected) {
      const now = Date.now();
      lastConnectedAtRef.current = now;
      if (firstConnectedAtRef.current === null) {
        firstConnectedAtRef.current = now;
      }
    }
    onConnectionChange?.(Boolean(shouldRunPreview && status?.connected && status?.screenshotKey));
  }, [onConnectionChange, shouldRunPreview, status?.connected, status?.screenshotKey]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    window.__conductorSessionPreviewDebug = {
      sessionId,
      getState: () => ({
        sessionId,
        active,
        pageVisible,
        shouldRunPreview,
        connected: Boolean(status?.connected),
        screenshotReady: Boolean(status?.screenshotKey),
        previewMode,
        inspectorTab: previewInspectorTab,
        domNodes: domNodes.length,
        metrics: {
          mountedAt: new Date(mountedAtRef.current).toISOString(),
          mountedAgeMs: Date.now() - mountedAtRef.current,
          firstStatusLoadLatencyMs: firstStatusLoadedAtRef.current === null
            ? null
            : firstStatusLoadedAtRef.current - mountedAtRef.current,
          firstConnectedLatencyMs: firstConnectedAtRef.current === null
            ? null
            : firstConnectedAtRef.current - mountedAtRef.current,
          lastConnectedAt: lastConnectedAtRef.current === null
            ? null
            : new Date(lastConnectedAtRef.current).toISOString(),
          statusLoadCount: statusLoadCountRef.current,
          statusLoadFailureCount: statusLoadFailureCountRef.current,
          statusPollCount: statusPollCountRef.current,
          commandCount: commandCountRef.current,
          commandFailureCount: commandFailureCountRef.current,
          domLoadCount: domLoadCountRef.current,
          domLoadFailureCount: domLoadFailureCountRef.current,
          autoConnectAttemptCount: autoConnectAttemptCountRef.current,
          screenshotLoadCount: screenshotLoadCountRef.current,
        },
      }),
    };

    return () => {
      if (window.__conductorSessionPreviewDebug?.sessionId === sessionId) {
        delete window.__conductorSessionPreviewDebug;
      }
    };
  }, [active, domNodes.length, pageVisible, previewInspectorTab, previewMode, sessionId, shouldRunPreview, status?.connected, status?.screenshotKey]);

  const screenshotUrl = useMemo(() => (
    status?.connected
      ? `/api/sessions/${encodeURIComponent(sessionId)}/preview/screenshot?ts=${encodeURIComponent(status.screenshotKey)}`
      : null
  ), [sessionId, status?.connected, status?.screenshotKey]);
  const preferredUrlInputCandidate = autoConnectCandidate ?? status?.candidateUrls[0] ?? null;

  const activeFrame = useMemo(
    () => status?.frames.find((frame) => frame.id === status.activeFrameId) ?? null,
    [status?.activeFrameId, status?.frames],
  );

  const mainFrame = useMemo(
    () => status?.frames.find((frame) => frame.isMain) ?? null,
    [status?.frames],
  );

  const currentPreviewOrigin = useMemo(
    () => readPreviewOrigin(status?.currentUrl),
    [status?.currentUrl],
  );

  const previewInfoSections = useMemo<PreviewInfoSection[]>(() => {
    const selection = status?.selectedElement;
    return [
      {
        id: "page",
        title: "Page",
        description: "Current page identity and live preview worker state.",
        fields: [
          { label: "Title", value: formatPreviewValue(status?.title, "Untitled") },
          {
            label: "Current URL",
            value: formatPreviewValue(status?.currentUrl),
            copyValue: status?.currentUrl ?? null,
            monospace: true,
          },
          {
            label: "Current origin",
            value: formatPreviewValue(currentPreviewOrigin),
            copyValue: currentPreviewOrigin,
            monospace: true,
          },
          { label: "Connected", value: formatPreviewBoolean(status?.connected) },
          { label: "Last error", value: formatPreviewValue(status?.lastError, "None") },
        ],
      },
      {
        id: "navigation",
        title: "Navigation",
        description: "History state and frame orientation for the current page.",
        fields: [
          { label: "Can go back", value: formatPreviewBoolean(status?.canGoBack) },
          { label: "Can go forward", value: formatPreviewBoolean(status?.canGoForward) },
          { label: "Active frame", value: formatPreviewValue(activeFrame?.name) },
          { label: "Main frame", value: formatPreviewValue(mainFrame?.name) },
          { label: "Frame count", value: `${status?.frames.length ?? 0}` },
        ],
      },
      {
        id: "worker",
        title: "Worker",
        description: "Reported candidates, logs, and worker render metadata.",
        fields: [
          { label: "Candidate URLs", value: `${status?.candidateUrls.length ?? 0}` },
          {
            label: "Auto-connect",
            value: formatPreviewValue(autoConnectCandidate ?? preferredUrlInputCandidate),
            copyValue: autoConnectCandidate ?? preferredUrlInputCandidate ?? null,
            monospace: true,
          },
          {
            label: "Screenshot key",
            value: formatPreviewValue(status?.screenshotKey, "Unavailable"),
            monospace: true,
          },
          { label: "Console rows", value: `${status?.consoleLogs.length ?? 0}` },
          { label: "Network rows", value: `${status?.networkLogs.length ?? 0}` },
        ],
      },
      {
        id: "selection",
        title: "Selection",
        description: "Current element context captured from inspect mode.",
        fields: [
          {
            label: "Selector",
            value: formatPreviewValue(selection?.selector),
            copyValue: selection?.selector ?? null,
            monospace: true,
          },
          { label: "Tag", value: formatPreviewValue(selection?.tag) },
          { label: "Role", value: formatPreviewValue(selection?.role) },
          { label: "Frame", value: formatPreviewValue(selection?.frameName) },
          { label: "Text", value: formatPreviewValue(selection?.text) },
        ],
      },
    ];
  }, [activeFrame?.name, autoConnectCandidate, currentPreviewOrigin, mainFrame?.name, preferredUrlInputCandidate, status]);

  const proxyCandidates = useMemo<PreviewCandidateSummary[]>(() => (
    (status?.candidateUrls ?? []).map((candidate) => {
      const origin = readPreviewOrigin(candidate);
      return {
        url: candidate,
        origin,
        isLoopback: isLoopbackPreviewUrl(candidate),
        isPreferred: candidate === autoConnectCandidate,
        isConnected: Boolean(
          status?.currentUrl
            && (status.currentUrl === candidate || (origin && currentPreviewOrigin === origin)),
        ),
        isTunnelOrigin: Boolean(status?.tunnelLocalOrigin && origin === status.tunnelLocalOrigin),
      };
    })
  ), [autoConnectCandidate, currentPreviewOrigin, status?.candidateUrls, status?.currentUrl, status?.tunnelLocalOrigin]);

  const loopbackCandidateCount = useMemo(
    () => proxyCandidates.filter((candidate) => candidate.isLoopback).length,
    [proxyCandidates],
  );

  const connectedProxyCandidate = useMemo(
    () => proxyCandidates.find((candidate) => candidate.isConnected) ?? null,
    [proxyCandidates],
  );

  const sending = sendingTarget !== null;
  const canSelectByPoint = Boolean(activeFrame?.isMain);

  const selectionOverlayStyle = useMemo(() => {
    const bounds = status?.selectedElement?.bounds;
    if (!status?.selectedElement || !bounds || !mainFrame || status.selectedElement.frameId !== mainFrame.id) {
      return null;
    }
    if (!imageMetrics.naturalWidth || !imageMetrics.naturalHeight || !imageMetrics.renderedWidth || !imageMetrics.renderedHeight) {
      return null;
    }

    const scaleX = imageMetrics.renderedWidth / imageMetrics.naturalWidth;
    const scaleY = imageMetrics.renderedHeight / imageMetrics.naturalHeight;
    return {
      left: `${bounds.x * scaleX}px`,
      top: `${bounds.y * scaleY}px`,
      width: `${Math.max(bounds.width * scaleX, 2)}px`,
      height: `${Math.max(bounds.height * scaleY, 2)}px`,
    };
  }, [imageMetrics, mainFrame, status?.selectedElement]);

  const handleCopyText = useCallback(async (
    value: string | null | undefined,
    successMessage: string,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      setSendError("Nothing to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(trimmed);
      setSendSuccess(successMessage);
      setSendError(null);
    } catch {
      setSendError("Clipboard access is unavailable.");
    }
  }, []);

  const connectPreviewCandidate = useCallback(async (candidate: string) => {
    setUrlInput(candidate);
    setCommandError(null);
    try {
      await runCommand({ command: "connect", url: candidate });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to connect preview");
    }
  }, [runCommand]);

  const handleConnect = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    await connectPreviewCandidate(trimmed);
  }, [connectPreviewCandidate, urlInput]);

  const openSelectionComposer = useCallback((anchorX: number, anchorY: number, pending = false) => {
    setSelectionComposer({ anchorX, anchorY, pending });
    setSendError(null);
    setSendSuccess(null);
  }, []);

  const handlePreviewModeChange = useCallback((mode: PreviewInteractionMode) => {
    setPreviewMode(mode);
    if (mode === "inspect") {
      setPreviewInspectorTab("elements");
    }
    setSelectionComposer(null);
    setSendError(null);
    setSendSuccess(null);
  }, []);

  const selectionComposerStyle = useMemo(() => {
    if (!selectionComposer) return null;

    const availableWidth = imageMetrics.renderedWidth || SELECTION_COMPOSER_WIDTH_PX;
    const availableHeight = imageMetrics.renderedHeight || SELECTION_COMPOSER_HEIGHT_PX;
    const maxHeight = Math.max(220, availableHeight - (SELECTION_COMPOSER_MARGIN_PX * 2));
    if (availableWidth <= MOBILE_SELECTION_COMPOSER_BREAKPOINT_PX) {
      return {
        left: `${SELECTION_COMPOSER_MARGIN_PX}px`,
        top: `${Math.max(SELECTION_COMPOSER_MARGIN_PX, availableHeight - Math.min(SELECTION_COMPOSER_HEIGHT_PX, maxHeight) - SELECTION_COMPOSER_MARGIN_PX)}px`,
        width: `${Math.max(availableWidth - (SELECTION_COMPOSER_MARGIN_PX * 2), 220)}px`,
        maxHeight: `${maxHeight}px`,
      };
    }

    const popupWidth = Math.min(
      SELECTION_COMPOSER_WIDTH_PX,
      Math.max(availableWidth - (SELECTION_COMPOSER_MARGIN_PX * 2), 240),
    );
    const maxLeft = Math.max(
      SELECTION_COMPOSER_MARGIN_PX,
      availableWidth - popupWidth - SELECTION_COMPOSER_MARGIN_PX,
    );
    const maxTop = Math.max(
      SELECTION_COMPOSER_MARGIN_PX,
      availableHeight - SELECTION_COMPOSER_HEIGHT_PX - SELECTION_COMPOSER_MARGIN_PX,
    );
    const preferredLeft = selectionComposer.anchorX + 18;
    const preferredTop = selectionComposer.anchorY + 18;
    const left = preferredLeft > maxLeft
      ? Math.max(
        SELECTION_COMPOSER_MARGIN_PX,
        selectionComposer.anchorX - popupWidth - 18,
      )
      : preferredLeft;
    const top = preferredTop > maxTop
      ? Math.max(
        SELECTION_COMPOSER_MARGIN_PX,
        selectionComposer.anchorY - SELECTION_COMPOSER_HEIGHT_PX - 18,
      )
      : preferredTop;

    return {
      left: `${Math.min(Math.max(left, SELECTION_COMPOSER_MARGIN_PX), maxLeft)}px`,
      top: `${Math.min(Math.max(top, SELECTION_COMPOSER_MARGIN_PX), maxTop)}px`,
      width: `${popupWidth}px`,
      maxHeight: `${maxHeight}px`,
    };
  }, [imageMetrics.renderedHeight, imageMetrics.renderedWidth, selectionComposer]);

  useEffect(() => {
    if (!selectionComposer) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectionComposer(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectionComposer]);

  const resolveImagePoint = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
    if (!imageRef.current) {
      return null;
    }

    const rect = imageRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height || !imageRef.current.naturalWidth || !imageRef.current.naturalHeight) {
      return null;
    }

    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    return {
      anchorX,
      anchorY,
      x: (anchorX / rect.width) * imageRef.current.naturalWidth,
      y: (anchorY / rect.height) * imageRef.current.naturalHeight,
    };
  }, []);

  const queueContextInsert = useCallback((request: Omit<TerminalInsertRequest, "nonce">) => {
    onQueueTerminalInsert(request);
    setSendError(null);
    setSendSuccess(request.successMessage);
  }, [onQueueTerminalInsert]);

  const selectElementAtPoint = useCallback(async (
    x: number,
    y: number,
    anchorX: number,
    anchorY: number,
  ): Promise<PreviewStatusResponse> => {
    openSelectionComposer(anchorX, anchorY, true);
    try {
      const nextStatus = await runCommand({ command: "selectAtPoint", x, y });
      openSelectionComposer(anchorX, anchorY, false);
      return nextStatus;
    } catch (error) {
      setSelectionComposer(null);
      throw error;
    }
  }, [openSelectionComposer, runCommand]);

  const selectDomNode = useCallback(async (
    selector: string,
    frameId?: string | null,
  ): Promise<PreviewStatusResponse> => {
    const anchorX = Math.max(imageMetrics.renderedWidth - 44, SELECTION_COMPOSER_MARGIN_PX);
    const anchorY = SELECTION_COMPOSER_MARGIN_PX;
    openSelectionComposer(anchorX, anchorY, true);
    try {
      const nextStatus = await runCommand({
        command: "selectBySelector",
        selector,
        frameId,
      });
      openSelectionComposer(anchorX, anchorY, false);
      return nextStatus;
    } catch (error) {
      setSelectionComposer(null);
      throw error;
    }
  }, [imageMetrics.renderedWidth, openSelectionComposer, runCommand]);

  const handleImageClick = useCallback(async (event: ReactMouseEvent<HTMLImageElement>) => {
    if (busy) return;

    const point = resolveImagePoint(event);
    if (!point) {
      return;
    }

    setSelectionComposer(null);
    setSendError(null);
    setSendSuccess(null);

    if (previewMode === "navigate") {
      previewSurfaceRef.current?.focus({ preventScroll: true });
      try {
        await runCommand({ command: "clickAtPoint", x: point.x, y: point.y });
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : "Failed to interact with preview");
      }
      return;
    }

    if (!canSelectByPoint) return;

    try {
      await selectElementAtPoint(point.x, point.y, point.anchorX, point.anchorY);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to select element");
    }
  }, [
    busy,
    canSelectByPoint,
    previewMode,
    resolveImagePoint,
    runCommand,
    selectElementAtPoint,
  ]);

  const handleImageDoubleClick = useCallback(async (event: ReactMouseEvent<HTMLImageElement>) => {
    if (busy || previewMode !== "inspect" || !canSelectByPoint) {
      return;
    }

    const point = resolveImagePoint(event);
    if (!point) {
      return;
    }

    setSendError(null);
    setSendSuccess(null);

    try {
      const nextStatus = await selectElementAtPoint(point.x, point.y, point.anchorX, point.anchorY);
      if (!nextStatus.selectedElement) {
        throw new Error("No element found at the selected point");
      }
      queueContextInsert(buildSelectionInsert(nextStatus.selectedElement, nextStatus.currentUrl));
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to queue selected element");
    }
  }, [busy, canSelectByPoint, previewMode, queueContextInsert, resolveImagePoint, selectElementAtPoint]);

  const handlePreviewKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (previewMode !== "navigate" || !status?.connected) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const specialKey = PREVIEW_SPECIAL_KEYS.get(event.key);
    if (specialKey) {
      event.preventDefault();
      queuePreviewCommand({ command: "pressKey", key: specialKey }, "Failed to send key to preview");
      return;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      queuePreviewCommand({ command: "typeText", text: event.key }, "Failed to type into preview");
    }
  }, [previewMode, queuePreviewCommand, status?.connected]);

  const handlePreviewPaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    if (previewMode !== "navigate" || !status?.connected) {
      return;
    }

    const text = event.clipboardData.getData("text");
    if (!text) {
      return;
    }

    event.preventDefault();
    queuePreviewCommand({ command: "typeText", text }, "Failed to paste into preview");
  }, [previewMode, queuePreviewCommand, status?.connected]);

  const handleSendContext = useCallback((target: PreviewSendTarget) => {
    if (!status) {
      setSendError("Preview state is not loaded yet.");
      return;
    }

    const recentConsoleLogs = status.consoleLogs.slice(-80);
    const recentNetworkLogs = status.networkLogs.slice(-80);

    if (target === "selection" && !status.selectedElement) {
      setSendError("Select an element before queueing preview context for terminal input.");
      return;
    }

    if (target === "console" && !recentConsoleLogs.length) {
      setSendError("There are no console logs to send yet.");
      return;
    }

    if (target === "network" && !recentNetworkLogs.length) {
      setSendError("There are no network logs to send yet.");
      return;
    }

    setSendingTarget(target);
    setSendError(null);
    setSendSuccess(null);
    try {
      const request = target === "selection" && status.selectedElement
        ? buildSelectionInsert(status.selectedElement, status.currentUrl)
        : target === "console"
          ? buildLogInsert("console", recentConsoleLogs, status.currentUrl, status.selectedElement)
          : buildLogInsert("network", recentNetworkLogs, status.currentUrl, status.selectedElement);
      queueContextInsert(request);
      if (target === "selection") {
        setSelectionComposer(null);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to queue preview context");
    } finally {
      setSendingTarget(null);
    }
  }, [queueContextInsert, status]);

  const handleCopySelector = useCallback(async () => {
    const selector = status?.selectedElement?.selector;
    if (!selector) return;
    try {
      await navigator.clipboard.writeText(selector);
      setSendSuccess("Selector copied to clipboard.");
      setSendError(null);
    } catch {
      setSendError("Clipboard access is unavailable.");
    }
  }, [status?.selectedElement?.selector]);

  const inspectorPane = (
        <Tabs
          value={previewInspectorTab}
          onValueChange={(value) => setPreviewInspectorTab(value as "elements" | "console" | "network" | "info" | "proxies")}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:min-h-0"
        >
          <div className="border-b border-[var(--vk-border)] px-2 py-2">
            <TabsList className="w-full justify-start border-0 bg-transparent p-0">
              <TabsTrigger value="elements">
                <Boxes className="h-3.5 w-3.5" />
                Elements
              </TabsTrigger>
              <TabsTrigger value="console">
                <TerminalSquare className="h-3.5 w-3.5" />
                Console
                <Badge variant="outline">{status?.consoleLogs.length ?? 0}</Badge>
              </TabsTrigger>
              <TabsTrigger value="network">
                <FileJson2 className="h-3.5 w-3.5" />
                Network
                <Badge variant="outline">{status?.networkLogs.length ?? 0}</Badge>
              </TabsTrigger>
              <TabsTrigger value="info">
                <Info className="h-3.5 w-3.5" />
                Info
              </TabsTrigger>
              <TabsTrigger value="proxies">
                <Globe className="h-3.5 w-3.5" />
                Proxies
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="elements" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="border-b border-[var(--vk-border)] px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-medium text-[var(--vk-text-normal)]">Selected element</div>
                  <div className="text-[11px] text-[var(--vk-text-muted)]">
                    {previewMode === "inspect"
                      ? "Single-click to inspect. Double-click to queue the element for terminal input."
                      : "Switch to Inspect mode to capture element context from the preview."}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant={interactiveOnly ? "primary" : "outline"}
                    size="sm"
                    onClick={() => setInteractiveOnly((current) => !current)}
                  >
                    {interactiveOnly ? "Interactive only" : "All nodes"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopySelector()}
                    disabled={!status?.selectedElement}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy selector
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => void handleSendContext("selection")}
                    disabled={sending || !status?.selectedElement}
                  >
                    {sendingTarget === "selection" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    Queue for terminal
                  </Button>
                </div>
              </div>

              {status?.selectedElement ? (
                <div className="mt-3 rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] text-[var(--vk-text-normal)]">{status.selectedElement.tag}</span>
                    {status.selectedElement.role ? <Badge variant="outline">{status.selectedElement.role}</Badge> : null}
                    {status.selectedElement.frameName ? <Badge variant="outline">{status.selectedElement.frameName}</Badge> : null}
                  </div>
                  <div className="mt-2 text-[12px] text-[var(--vk-text-normal)]">
                    {truncate(status.selectedElement.name || status.selectedElement.text || "Selected element", 180)}
                  </div>
                  <div className="mt-2 break-all font-mono text-[11px] text-[var(--vk-text-muted)]">
                    {status.selectedElement.selector}
                  </div>
                  {status.selectedElement.htmlPreview ? (
                    <div className="mt-2 rounded-[6px] border border-dashed border-[var(--vk-border)] px-2.5 py-2 text-[11px] text-[var(--vk-text-muted)]">
                      {truncate(status.selectedElement.htmlPreview, 260)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 rounded-[8px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                  No element selected yet.
                </div>
              )}

              {status?.frames.length ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {status.frames.map((frame) => (
                    <button
                      key={frame.id}
                      type="button"
                      onClick={() => {
                        void runCommand({ command: "selectFrame", frameId: frame.id }).catch((error: unknown) => {
                          setCommandError(error instanceof Error ? error.message : "Failed to select frame");
                        });
                      }}
                      className={cn(
                        "inline-flex max-w-full items-center gap-2 rounded-[5px] border px-2.5 py-1.5 text-[11px]",
                        status.activeFrameId === frame.id
                          ? "border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_10%,transparent)] text-[var(--vk-text-normal)]"
                          : "border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]",
                      )}
                    >
                      <Badge variant="outline">{frame.isMain ? "main" : "frame"}</Badge>
                      <span className="truncate">{frame.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-1 p-3">
                {domLoading ? (
                  <div className="flex items-center gap-2 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Inspecting frame DOM…
                  </div>
                ) : domNodes.length ? (
                  domNodes.map((node, index) => (
                    <button
                      key={`${node.id ?? "node"}-${index}-${node.selector}-${node.tag}-${node.text}`}
                      type="button"
                      className={cn(
                        "w-full rounded-[6px] border px-3 py-2.5 text-left transition-colors",
                        previewMode === "inspect"
                          ? "border-[var(--vk-border)] bg-[var(--vk-bg-main)] hover:bg-[var(--vk-bg-hover)]"
                          : "cursor-not-allowed border-[var(--vk-border)] bg-[var(--vk-bg-main)] opacity-60",
                      )}
                      disabled={previewMode !== "inspect"}
                      onClick={() => {
                        setSelectionComposer(null);
                        setSendError(null);
                        setSendSuccess(null);
                        void selectDomNode(node.selector, status?.activeFrameId)
                          .catch((error: unknown) => {
                            setCommandError(error instanceof Error ? error.message : "Failed to select DOM node");
                          });
                      }}
                      onDoubleClick={() => {
                        setSendError(null);
                        setSendSuccess(null);
                        void selectDomNode(node.selector, status?.activeFrameId)
                          .then((nextStatus) => {
                            if (!nextStatus.selectedElement) {
                              throw new Error("Failed to resolve the selected DOM node");
                            }
                            queueContextInsert(buildSelectionInsert(nextStatus.selectedElement, nextStatus.currentUrl));
                          })
                          .catch((error: unknown) => {
                            setCommandError(error instanceof Error ? error.message : "Failed to queue DOM node");
                          });
                      }}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12px] text-[var(--vk-text-normal)]">{node.tag}</span>
                        {node.interactive ? <Badge variant="warning">interactive</Badge> : null}
                        {node.role ? <Badge variant="outline">{node.role}</Badge> : null}
                      </div>
                      <div className="mt-1 break-all font-mono text-[11px] text-[var(--vk-text-muted)]">
                        {node.selector}
                      </div>
                      {node.text ? (
                        <div className="mt-1 text-[12px] text-[var(--vk-text-normal)]">
                          {truncate(node.text, 180)}
                        </div>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <div className="rounded-[8px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                    {previewMode === "inspect"
                      ? "No DOM nodes to show for the current frame yet."
                      : "Switch to Inspect mode to browse the current frame DOM."}
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="console" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--vk-border)] px-3 py-3">
              <div>
                <div className="text-[12px] font-medium text-[var(--vk-text-normal)]">Console output</div>
                <div className="text-[11px] text-[var(--vk-text-muted)]">Live browser console events from the preview worker.</div>
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void handleSendContext("console")}
                disabled={sending || !status?.consoleLogs.length}
              >
                {sendingTarget === "console" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Queue for terminal
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-1 p-3">
                {status?.consoleLogs.length ? status.consoleLogs.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2.5 text-[11px] text-[var(--vk-text-normal)]"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">
                      <span>{entry.level}</span>
                      <span>{formatTime(entry.timestamp)}</span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-all font-mono">
                      {entry.message}
                    </div>
                  </div>
                )) : (
                  <div className="rounded-[8px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                    Console output appears here once the page loads.
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="network" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--vk-border)] px-3 py-3">
              <div>
                <div className="text-[12px] font-medium text-[var(--vk-text-normal)]">Network requests</div>
                <div className="text-[11px] text-[var(--vk-text-muted)]">Recent requests captured by the preview worker.</div>
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void handleSendContext("network")}
                disabled={sending || !status?.networkLogs.length}
              >
                {sendingTarget === "network" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Queue for terminal
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-1 p-3">
                {status?.networkLogs.length ? status.networkLogs.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2.5 text-[11px] text-[var(--vk-text-normal)]"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">
                      <span>{entry.method ?? "GET"}</span>
                      {typeof entry.status === "number" ? <span>{entry.status}</span> : null}
                      {entry.resourceType ? <span>{entry.resourceType}</span> : null}
                      <span>{formatTime(entry.timestamp)}</span>
                    </div>
                    <div className="mt-1 break-all font-mono">{entry.url ?? entry.message}</div>
                  </div>
                )) : (
                  <div className="rounded-[8px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                    Network requests appear here after the preview loads.
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="info" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--vk-border)] px-3 py-3">
              <div>
                <div className="text-[12px] font-medium text-[var(--vk-text-normal)]">Preview info</div>
                <div className="text-[11px] text-[var(--vk-text-muted)]">A cleaner Lunel-style snapshot of page, worker, navigation, and element state.</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleCopyText(status?.currentUrl, "Current URL copied to clipboard.");
                }}
                disabled={!status?.currentUrl}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy URL
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 p-3 text-[12px] text-[var(--vk-text-normal)]">
                <div className="grid gap-2 sm:grid-cols-2">
                  <PreviewStatCard
                    label="Connected"
                    value={status?.connected ? "Live" : "Idle"}
                    hint={status?.currentUrl ? truncate(status.currentUrl, 60) : "No active page yet"}
                  />
                  <PreviewStatCard
                    label="Frames"
                    value={`${status?.frames.length ?? 0}`}
                    hint={activeFrame?.name ?? "No active frame"}
                  />
                  <PreviewStatCard
                    label="Console"
                    value={`${status?.consoleLogs.length ?? 0}`}
                    hint="Captured browser console rows"
                  />
                  <PreviewStatCard
                    label="Network"
                    value={`${status?.networkLogs.length ?? 0}`}
                    hint="Recent preview worker requests"
                  />
                </div>
                {previewInfoSections.map((section) => (
                  <PreviewInfoSectionCard
                    key={section.id}
                    section={section}
                    onCopy={handleCopyText}
                  />
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="proxies" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--vk-border)] px-3 py-3">
              <div>
                <div className="text-[12px] font-medium text-[var(--vk-text-normal)]">Proxy and tunnel routing</div>
                <div className="text-[11px] text-[var(--vk-text-muted)]">Candidate URLs come from the session. Tunnel metadata shows how bridge-backed previews map remote loopback into the local display origin.</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleCopyText(status?.tunnelLocalOrigin ?? status?.tunnelUrl, "Tunnel mapping copied to clipboard.");
                }}
                disabled={!status?.tunnelLocalOrigin && !status?.tunnelUrl}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy route
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 p-3 text-[12px] text-[var(--vk-text-normal)]">
                <div className="grid gap-2 sm:grid-cols-2">
                  <PreviewStatCard
                    label="Candidates"
                    value={`${proxyCandidates.length}`}
                    hint={proxyCandidates.length ? "Reported by the current session" : "No targets reported yet"}
                  />
                  <PreviewStatCard
                    label="Loopback"
                    value={`${loopbackCandidateCount}`}
                    hint={loopbackCandidateCount ? "Local dev URLs available" : "No local loopback URLs"}
                  />
                  <PreviewStatCard
                    label="Tunnel"
                    value={status?.tunnelUrl ? "Ready" : "None"}
                    hint={status?.tunnelLocalOrigin ?? "No bridge tunnel mapping"}
                    monospace={Boolean(status?.tunnelLocalOrigin)}
                  />
                  <PreviewStatCard
                    label="Current origin"
                    value={currentPreviewOrigin ?? "Idle"}
                    hint={connectedProxyCandidate ? "Matches the active preview page" : "Not connected to a candidate yet"}
                    monospace={Boolean(currentPreviewOrigin)}
                  />
                </div>

                <PreviewInfoSectionCard
                  section={{
                    id: "tunnel-mapping",
                    title: "Tunnel mapping",
                    description: "Bridge previews can expose a remote tunnel while still rendering the equivalent local origin in the browser workspace.",
                    fields: [
                      {
                        label: "Local origin",
                        value: formatPreviewValue(status?.tunnelLocalOrigin, "Not set"),
                        copyValue: status?.tunnelLocalOrigin ?? null,
                        monospace: true,
                      },
                      {
                        label: "Tunnel URL",
                        value: formatPreviewValue(status?.tunnelUrl, "Not set"),
                        copyValue: status?.tunnelUrl ?? null,
                        monospace: true,
                      },
                      {
                        label: "Current origin",
                        value: formatPreviewValue(currentPreviewOrigin),
                        copyValue: currentPreviewOrigin,
                        monospace: true,
                      },
                    ],
                  }}
                  onCopy={handleCopyText}
                />

                <div className="overflow-hidden rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
                  <div className="border-b border-[var(--vk-border)] px-3 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-[var(--vk-text-muted)]">Candidate URLs</div>
                    <div className="mt-1 text-[11px] leading-5 text-[var(--vk-text-muted)]">Use connect to load a reported target into the preview browser, or copy the URL or origin for terminal context.</div>
                  </div>
                  <div className="space-y-2 p-3">
                    {proxyCandidates.length ? proxyCandidates.map((candidate) => (
                      <div
                        key={candidate.url}
                        className="rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-3"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <div className={cn(
                              "text-[12px] font-medium text-[var(--vk-text-normal)]",
                              candidate.origin ? "truncate" : "break-all",
                            )}>
                              {candidate.origin ?? candidate.url}
                            </div>
                            <div className="mt-1 break-all font-mono text-[11px] text-[var(--vk-text-muted)]">
                              {candidate.url}
                            </div>
                          </div>
                          {candidate.isConnected ? <Badge variant="success">current</Badge> : null}
                          {candidate.isPreferred ? <Badge variant="warning">auto</Badge> : null}
                          {candidate.isTunnelOrigin ? <Badge variant="outline">tunnel origin</Badge> : null}
                          <Badge variant="outline">{candidate.isLoopback ? "loopback" : "remote"}</Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            onClick={() => {
                              void connectPreviewCandidate(candidate.url);
                            }}
                          >
                            <Globe className="h-3.5 w-3.5" />
                            Connect
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void handleCopyText(candidate.url, "Candidate URL copied to clipboard.");
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Copy URL
                          </Button>
                          {candidate.origin ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void handleCopyText(candidate.origin, "Candidate origin copied to clipboard.");
                              }}
                            >
                              <Waypoints className="h-3.5 w-3.5" />
                              Copy origin
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )) : (
                      <div className="rounded-[8px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                        No candidate URLs detected yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]">
      <div className="shrink-0 border-b border-[var(--vk-border)] px-3 py-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-[var(--vk-text-muted)]" />
              <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Preview browser</span>
            </div>
            {status?.connected
              ? <Badge variant="success">connected</Badge>
              : <Badge variant="outline">idle</Badge>}
            {activeFrame
              ? <Badge variant="outline">{activeFrame.isMain ? "main frame" : "nested frame"}</Badge>
              : null}
            {status?.title
              ? <Badge variant="outline">{truncate(status.title, 40)}</Badge>
              : null}
            {selectionComposer?.pending
              ? <Badge variant="warning">selecting element…</Badge>
              : null}
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3">
              <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
              <input
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder={preferredUrlInputCandidate ?? "http://127.0.0.1:3000"}
                className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleConnect()}
                disabled={busy || !urlInput.trim()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MousePointerClick className="h-4 w-4" />}
                Connect
              </Button>
              <Button
                type="button"
                aria-label="Go back"
                variant="outline"
                onClick={() => void runCommand({ command: "goBack" }).catch((error: unknown) => {
                  setCommandError(error instanceof Error ? error.message : "Failed to go back");
                })}
                disabled={!status?.connected || !status?.canGoBack || busy}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Back</span>
              </Button>
              <Button
                type="button"
                aria-label="Go forward"
                variant="outline"
                onClick={() => void runCommand({ command: "goForward" }).catch((error: unknown) => {
                  setCommandError(error instanceof Error ? error.message : "Failed to go forward");
                })}
                disabled={!status?.connected || !status?.canGoForward || busy}
              >
                <ArrowRight className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Forward</span>
              </Button>
              <Button
                type="button"
                aria-label="Refresh preview status"
                variant="outline"
                onClick={() => void loadStatus("manual").catch((error: unknown) => {
                  setCommandError(error instanceof Error ? error.message : "Failed to refresh preview");
                })}
                disabled={loading || busy}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              <Button
                type="button"
                aria-label="Reload preview page"
                variant="outline"
                onClick={() => void runCommand({ command: "reload" }).catch((error: unknown) => {
                  setCommandError(error instanceof Error ? error.message : "Failed to reload preview");
                })}
                disabled={!status?.connected || busy}
              >
                <Waypoints className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Reload</span>
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-1">
                <Button
                  type="button"
                  size="sm"
                  variant={previewMode === "navigate" ? "primary" : "ghost"}
                  onClick={() => handlePreviewModeChange("navigate")}
                >
                  <MousePointerClick className="h-3.5 w-3.5" />
                  Navigate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={previewMode === "inspect" ? "primary" : "ghost"}
                  onClick={() => handlePreviewModeChange("inspect")}
                >
                  <Eye className="h-3.5 w-3.5" />
                  Inspect
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                variant={showMobileInspector ? "primary" : "outline"}
                className="lg:hidden"
                onClick={() => setMobileInspectorOpen((current) => !current)}
              >
                <Boxes className="h-3.5 w-3.5" />
                {showMobileInspector ? "Hide tools" : "Browser tools"}
              </Button>
            </div>
            {!mobileViewport ? (
              <div className="text-[11px] text-[var(--vk-text-muted)]">
                {previewMode === "navigate"
                  ? "Navigate mode sends clicks and typing into the running app."
                  : canSelectByPoint
                    ? "Inspect mode lets you click once to inspect, double-click to queue for terminal input."
                    : "Inspect mode is limited to the frame DOM list for nested frames."}
              </div>
            ) : null}
          </div>

          {!status?.connected && status?.candidateUrls.length && showCandidateChips ? (
            <div className="flex flex-wrap items-center gap-2">
              {status.candidateUrls.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2.5 py-1.5 text-left text-[11px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
                  onClick={() => {
                    void connectPreviewCandidate(candidate);
                  }}
                >
                  <Globe className="h-3 w-3 shrink-0" />
                  <span className="truncate">{candidate}</span>
                </button>
              ))}
            </div>
          ) : null}

          {commandError || status?.lastError ? (
            <div className="flex items-start gap-2 rounded-[6px] border border-[color:color-mix(in_srgb,var(--vk-red)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{commandError ?? status?.lastError}</span>
            </div>
          ) : null}
          {sendSuccess ? (
            <div className="rounded-[6px] border border-[color:color-mix(in_srgb,var(--vk-green)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-green)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-green)]">
              {sendSuccess}
            </div>
          ) : null}
          {sendError ? (
            <div className="rounded-[6px] border border-[color:color-mix(in_srgb,var(--vk-red)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
              {sendError}
            </div>
          ) : null}
        </div>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.95fr)] lg:overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-[1.25] flex-col overflow-hidden border-b border-[var(--vk-border)] lg:flex-1 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--vk-border)] px-3 py-2 text-[11px] text-[var(--vk-text-muted)]">
            <div className="min-w-0">
              <div className="truncate text-[var(--vk-text-normal)]">
                {status?.currentUrl ?? preferredUrlInputCandidate ?? "No active preview URL yet"}
              </div>
            </div>
            {status?.connected ? (
              <Badge variant="outline">{status?.frames.length ?? 0} frame{(status?.frames.length ?? 0) === 1 ? "" : "s"}</Badge>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-[#0f1012] p-3">
            <div className="flex h-full min-h-[min(200px,45vh)] w-full items-center justify-center lg:min-h-[260px]">
              {loading ? (
                <div className="flex items-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading preview…
                </div>
              ) : screenshotUrl ? (
                <div
                  ref={previewSurfaceRef}
                  tabIndex={status?.connected ? 0 : -1}
                  onKeyDown={handlePreviewKeyDown}
                  onPaste={handlePreviewPaste}
                  className="relative flex max-h-full max-w-full items-start justify-center overflow-auto rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vk-orange)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1012]"
                >
                  <img
                    ref={imageRef}
                    src={screenshotUrl}
                    alt="Session preview"
                    className={cn(
                      "max-h-full max-w-full rounded-[8px] object-contain shadow-[0_18px_36px_rgba(0,0,0,0.28)]",
                      previewMode === "navigate"
                        ? "cursor-pointer"
                        : canSelectByPoint
                          ? "cursor-crosshair"
                          : "cursor-default",
                    )}
                    onClick={(event) => void handleImageClick(event)}
                    onDoubleClick={(event) => void handleImageDoubleClick(event)}
                    onLoad={(event) => {
                      screenshotLoadCountRef.current += 1;
                      const target = event.currentTarget;
                      setImageMetrics({
                        naturalWidth: target.naturalWidth,
                        naturalHeight: target.naturalHeight,
                        renderedWidth: target.clientWidth,
                        renderedHeight: target.clientHeight,
                      });
                    }}
                  />
                  {previewMode === "inspect" && selectionOverlayStyle ? (
                    <div
                      className="pointer-events-none absolute border-2 border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_18%,transparent)] shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                      style={selectionOverlayStyle}
                    />
                  ) : null}
                  {previewMode === "inspect" && selectionComposer && selectionComposerStyle ? (
                    <div
                      className="pointer-events-none absolute z-20 rounded-[10px] border border-[var(--vk-border)] bg-[color:color-mix(in_srgb,var(--vk-bg-panel)_94%,black_6%)] px-3 py-2 text-[11px] text-[var(--vk-text-normal)] shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur"
                      style={selectionComposerStyle}
                    >
                      {selectionComposer.pending
                        ? "Selecting element…"
                        : status?.selectedElement
                          ? `${status.selectedElement.tag} · ${truncate(status.selectedElement.selector, 120)}`
                          : "Selection ready"}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="max-w-md text-center text-[13px] text-[var(--vk-text-muted)]">
                  Connect a local dev URL or explicit preview URL to start the preview browser. Navigate mode lets you interact with the running app. Inspect mode lets you capture UI context and queue it into terminal input.
                </div>
              )}
            </div>
          </div>
        </div>

        {!mobileViewport ? inspectorPane : null}
      </div>

      {mobileViewport && showMobileInspector ? (
        <>
          <div
            className="absolute inset-0 z-10 bg-black/35 lg:hidden"
            onClick={() => setMobileInspectorOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-x-0 bottom-0 z-20 flex max-h-[min(72vh,36rem)] min-h-[18rem] flex-col overflow-hidden rounded-t-[14px] border border-b-0 border-[var(--vk-border)] bg-[color:color-mix(in_srgb,var(--vk-bg-panel)_96%,black_4%)] shadow-[0_-24px_48px_rgba(0,0,0,0.42)] lg:hidden">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--vk-border)] px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Boxes className="h-4 w-4 shrink-0 text-[var(--vk-text-muted)]" />
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-[var(--vk-text-normal)]">Browser tools</div>
                  <div className="truncate text-[11px] text-[var(--vk-text-muted)]">Hidden by default on mobile, browser first like Lunel.</div>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setMobileInspectorOpen(false)}
              >
                Hide
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {inspectorPane}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
