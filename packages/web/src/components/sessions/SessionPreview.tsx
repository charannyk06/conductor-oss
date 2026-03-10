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
  Boxes,
  Copy,
  Eye,
  FileJson2,
  Globe,
  Loader2,
  MousePointerClick,
  RefreshCw,
  Send,
  TerminalSquare,
  Waypoints,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { cn } from "@/lib/cn";
import type {
  PreviewElementSelection,
  PreviewCommandRequest,
  PreviewDomNode,
  PreviewDomResponse,
  PreviewLogEntry,
  PreviewStatusResponse,
} from "@/lib/previewTypes";
import type { TerminalInsertRequest } from "./terminalInsert";

const STATUS_POLL_INTERVAL_MS = 4_000;
const AUTO_CONNECT_RETRY_MS = 5_000;
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
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
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
  const [selectionComposer, setSelectionComposer] = useState<SelectionComposerState | null>(null);
  const [urlInput, setUrlInput] = useState("");
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
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const shouldRunPreview = active && pageVisible;

  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const loadStatus = useCallback(async () => {
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

    setStatus(payload as PreviewStatusResponse);
    setCommandError(null);
    setUrlInput((current) => {
      if (current.trim().length > 0 && current !== status?.currentUrl) {
        return current;
      }
      return (payload as PreviewStatusResponse).currentUrl
        ?? (payload as PreviewStatusResponse).candidateUrls[0]
        ?? current;
    });
  }, [sessionId, status?.currentUrl]);

  const runCommand = useCallback(async (command: PreviewCommandRequest): Promise<PreviewStatusResponse> => {
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
        await loadStatus();
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

    const intervalId = window.setInterval(() => {
      void loadStatus().catch((error: unknown) => {
        if (mounted) {
          setCommandError(error instanceof Error ? error.message : "Failed to refresh preview");
        }
      });
    }, STATUS_POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [loadStatus, shouldRunPreview]);

  useEffect(() => {
    if (!shouldRunPreview || !status?.connected) {
      setDomNodes([]);
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

    const candidate = status?.candidateUrls[0];
    if (!candidate) return;
    const lastAttempt = autoConnectRef.current?.attemptedAt ?? Number.NaN;
    const lastCandidate = autoConnectRef.current?.candidate ?? null;
    const now = Date.now();
    if (lastCandidate === candidate && Number.isFinite(lastAttempt) && now - lastAttempt < AUTO_CONNECT_RETRY_MS) {
      return;
    }

    autoConnectRef.current = { candidate, attemptedAt: now };
    void runCommand({ command: "connect", url: candidate }).catch((error: unknown) => {
      setCommandError(error instanceof Error ? error.message : "Failed to connect preview");
    });
  }, [runCommand, shouldRunPreview, status?.candidateUrls, status?.connected]);

  useEffect(() => {
    onConnectionChange?.(Boolean(shouldRunPreview && status?.connected && status?.screenshotKey));
  }, [onConnectionChange, shouldRunPreview, status?.connected, status?.screenshotKey]);

  const screenshotUrl = useMemo(() => (
    status?.connected
      ? `/api/sessions/${encodeURIComponent(sessionId)}/preview/screenshot?ts=${encodeURIComponent(status.screenshotKey)}`
      : null
  ), [sessionId, status?.connected, status?.screenshotKey]);

  const activeFrame = useMemo(
    () => status?.frames.find((frame) => frame.id === status.activeFrameId) ?? null,
    [status?.activeFrameId, status?.frames],
  );

  const mainFrame = useMemo(
    () => status?.frames.find((frame) => frame.isMain) ?? null,
    [status?.frames],
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

  const handleConnect = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    try {
      await runCommand({ command: "connect", url: trimmed });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to connect preview");
    }
  }, [runCommand, urlInput]);

  const openSelectionComposer = useCallback((anchorX: number, anchorY: number, pending = false) => {
    setSelectionComposer({ anchorX, anchorY, pending });
    setSendError(null);
    setSendSuccess(null);
  }, []);

  const handlePreviewModeChange = useCallback((mode: PreviewInteractionMode) => {
    setPreviewMode(mode);
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
  }, [
    queueContextInsert,
    status,
  ]);

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto">
      <Card>
        <CardHeader className="flex flex-col items-start gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-[var(--vk-text-muted)]" />
            <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Dev preview browser</span>
            {status?.connected
              ? <Badge variant="success">connected</Badge>
              : <Badge variant="outline">idle</Badge>}
            {activeFrame
              ? <Badge variant="outline">{activeFrame.isMain ? "main frame" : "nested frame"}</Badge>
              : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadStatus().catch((error: unknown) => {
                setCommandError(error instanceof Error ? error.message : "Failed to refresh preview");
              })}
              disabled={loading || busy}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runCommand({ command: "reload" }).catch((error: unknown) => {
                setCommandError(error instanceof Error ? error.message : "Failed to reload preview");
              })}
              disabled={!status?.connected || busy}
            >
              <Waypoints className="h-3.5 w-3.5" />
              Reload page
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row">
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder={status?.candidateUrls[0] ?? "http://127.0.0.1:3000"}
              className="h-9 min-w-0 flex-1 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
            />
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleConnect()}
              disabled={busy || !urlInput.trim()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MousePointerClick className="h-4 w-4" />}
              Connect
            </Button>
          </div>

          {status?.candidateUrls.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {status.candidateUrls.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className="inline-flex max-w-full items-center gap-1 rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2 py-1 text-left text-[11px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
                  onClick={() => {
                    setUrlInput(candidate);
                    void runCommand({ command: "connect", url: candidate }).catch((error: unknown) => {
                      setCommandError(error instanceof Error ? error.message : "Failed to connect preview");
                    });
                  }}
                >
                  <Globe className="h-3 w-3 shrink-0" />
                  <span className="truncate">{candidate}</span>
                </button>
              ))}
            </div>
          ) : null}

          {commandError || status?.lastError ? (
            <div className="flex items-start gap-2 rounded-[4px] border border-[color:color-mix(in_srgb,var(--vk-red)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{commandError ?? status?.lastError}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="min-h-0 shrink-0 overflow-hidden">
        <CardHeader className="flex flex-col items-start gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-[var(--vk-text-muted)]" />
            <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Preview</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-1">
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
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--vk-text-muted)]">
              <Badge variant="outline">{status?.title ? truncate(status.title, 40) : "Untitled page"}</Badge>
              <Badge variant="outline">
                {previewMode === "navigate"
                  ? "navigate mode: clicks interact with the page"
                  : canSelectByPoint
                    ? "inspect mode: click once to select, double-click to queue for terminal input"
                    : "inspect mode: use DOM list for this frame"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="min-h-0">
          <div className="flex h-[56vh] min-h-[280px] max-h-[620px] items-center justify-center overflow-auto rounded-[6px] border border-[var(--vk-border)] bg-[#111] p-2 sm:h-[72vh] sm:min-h-[360px] sm:max-h-[760px] sm:p-3">
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
                className="relative flex max-h-full max-w-full items-start justify-center overflow-auto rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vk-orange)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#111]"
              >
                <img
                  ref={imageRef}
                  src={screenshotUrl}
                  alt="Session preview"
                  className={cn(
                    "max-h-full max-w-full rounded-[4px] object-contain shadow-[0_18px_36px_rgba(0,0,0,0.28)]",
                    previewMode === "navigate"
                      ? "cursor-pointer"
                      : canSelectByPoint
                        ? "cursor-crosshair"
                        : "cursor-default",
                  )}
                  onClick={(event) => void handleImageClick(event)}
                  onDoubleClick={(event) => void handleImageDoubleClick(event)}
                  onLoad={(event) => {
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
                    className="pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-[10px] border border-[var(--vk-border)] bg-[color:color-mix(in_srgb,var(--vk-bg-panel)_94%,black_6%)] shadow-[0_20px_44px_rgba(0,0,0,0.42)] backdrop-blur"
                    style={selectionComposerStyle}
                  >
                    <div className="flex items-start justify-between gap-3 border-b border-[var(--vk-border)] px-3 py-3">
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">Terminal input</div>
                        <div className="mt-1 text-[13px] font-medium text-[var(--vk-text-normal)]">
                          {selectionComposer.pending ? "Selecting element…" : "Queue selection for the terminal"}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleCopySelector()}
                          disabled={selectionComposer.pending || !status?.selectedElement}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectionComposer(null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
                      {selectionComposer.pending ? (
                        <div className="flex items-center gap-2 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Capturing the selected element from the preview…
                        </div>
                      ) : status?.selectedElement ? (
                        <>
                          <div className="rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[12px] text-[var(--vk-text-normal)]">{status.selectedElement.tag}</span>
                              {status.selectedElement.role ? <Badge variant="outline">{status.selectedElement.role}</Badge> : null}
                            </div>
                            <div className="mt-2 text-[12px] text-[var(--vk-text-normal)]">
                              {truncate(status.selectedElement.name || status.selectedElement.text || "Selected element", 140)}
                            </div>
                            <div className="mt-2 break-all font-mono text-[11px] text-[var(--vk-text-muted)]">
                              {status.selectedElement.selector}
                            </div>
                          </div>
                          <div className="rounded-[6px] border border-dashed border-[var(--vk-border)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                            Double-click the element in the preview to queue it immediately, or use the button below. The text is inserted into terminal input instead of being sent to the agent, so you can add more context before submitting.
                          </div>
                          {sendError ? (
                            <div className="text-[12px] text-[var(--vk-red)]">{sendError}</div>
                          ) : null}
                          <Button
                            type="button"
                            variant="primary"
                            className="w-full"
                            onClick={() => void handleSendContext("selection")}
                            disabled={sending || !status.selectedElement}
                          >
                            {sendingTarget === "selection" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            Queue for terminal input
                          </Button>
                        </>
                      ) : (
                        <div className="rounded-[6px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                          Single-click an element to inspect it here. Double-click to queue it for terminal input.
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="max-w-md text-center text-[13px] text-[var(--vk-text-muted)]">
                Connect a local dev URL to start the preview browser. In Navigate mode, click the preview first, then type directly into the running app. Switch to Inspect mode to select UI elements and queue browser context into terminal input.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {sendSuccess ? (
        <div className="rounded-[6px] border border-[color:color-mix(in_srgb,var(--vk-green)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-green)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-green)]">
          {sendSuccess}
        </div>
      ) : null}
      {!selectionComposer && sendError ? (
        <div className="rounded-[6px] border border-[color:color-mix(in_srgb,var(--vk-red)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
          {sendError}
        </div>
      ) : null}

      <div className="grid gap-2">
        <Card className="min-h-0">
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4 text-[var(--vk-text-muted)]" />
              <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Frames and DOM</span>
              <Badge variant="outline">{previewMode === "inspect" ? "inspect" : "read-only in navigate mode"}</Badge>
            </div>
            <Button
              type="button"
              variant={interactiveOnly ? "primary" : "outline"}
              size="sm"
              onClick={() => setInteractiveOnly((current) => !current)}
            >
              {interactiveOnly ? "Interactive only" : "All nodes"}
            </Button>
          </CardHeader>
          <CardContent className="grid gap-2 xl:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-2">
              {status?.frames.map((frame) => (
                <button
                  key={frame.id}
                  type="button"
                  onClick={() => {
                    void runCommand({ command: "selectFrame", frameId: frame.id }).catch((error: unknown) => {
                      setCommandError(error instanceof Error ? error.message : "Failed to select frame");
                    });
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-1 rounded-[4px] border px-2 py-2 text-left transition-colors",
                    status.activeFrameId === frame.id
                      ? "border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_10%,transparent)]"
                      : "border-[var(--vk-border)] bg-[var(--vk-bg-main)] hover:bg-[var(--vk-bg-hover)]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{frame.isMain ? "main" : "frame"}</Badge>
                    <span className="truncate text-[12px] text-[var(--vk-text-normal)]">{frame.name}</span>
                  </div>
                  <span className="w-full truncate text-[11px] text-[var(--vk-text-muted)]">
                    {frame.url || "about:blank"}
                  </span>
                </button>
              ))}
            </div>

            <div className="rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
              <ScrollArea className="h-[240px] sm:h-[300px] xl:h-[360px]">
                <div className="space-y-1 p-2">
                  {previewMode === "navigate" ? (
                    <div className="rounded-[4px] border border-dashed border-[var(--vk-border)] px-2 py-2 text-[11px] text-[var(--vk-text-muted)]">
                      Switch to Inspect mode to pick DOM nodes. Single-click selects a node. Double-click queues it for terminal input.
                    </div>
                  ) : null}
                  {domLoading ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-[var(--vk-text-muted)]">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Inspecting frame DOM…
                    </div>
                  ) : domNodes.length ? (
                    domNodes.map((node, index) => (
                      <button
                        key={`${node.id ?? "node"}-${index}-${node.selector}-${node.tag}-${node.text}`}
                        type="button"
                        className={cn(
                          "w-full rounded-[4px] border border-[transparent] px-2 py-2 text-left",
                          previewMode === "inspect"
                            ? "hover:border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                            : "cursor-not-allowed opacity-60",
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
                        <div className="flex items-center gap-2">
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
                    <div className="px-2 py-3 text-[12px] text-[var(--vk-text-muted)]">
                      No DOM nodes to show for the current frame yet.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-2 lg:grid-cols-2">
          <Card className="min-h-0">
            <CardHeader className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <TerminalSquare className="h-4 w-4 text-[var(--vk-text-muted)]" />
                <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Console</span>
                <Badge variant="outline">{status?.consoleLogs.length ?? 0}</Badge>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleSendContext("console")}
                disabled={sending || !status?.consoleLogs.length}
              >
                {sendingTarget === "console" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Queue for terminal
              </Button>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[220px] sm:h-[260px] rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
                <div className="space-y-1 p-2">
                  {status?.consoleLogs.length ? status.consoleLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-[3px] px-2 py-1.5 text-[11px] text-[var(--vk-text-normal)]"
                    >
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">
                        <span>{entry.level}</span>
                        <span>{formatTime(entry.timestamp)}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-all font-mono">
                        {entry.message}
                      </div>
                    </div>
                  )) : (
                    <div className="px-2 py-3 text-[12px] text-[var(--vk-text-muted)]">
                      Console output appears here once the page loads.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-h-0">
            <CardHeader className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileJson2 className="h-4 w-4 text-[var(--vk-text-muted)]" />
                <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Network</span>
                <Badge variant="outline">{status?.networkLogs.length ?? 0}</Badge>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleSendContext("network")}
                disabled={sending || !status?.networkLogs.length}
              >
                {sendingTarget === "network" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Queue for terminal
              </Button>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[220px] sm:h-[260px] rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
                <div className="space-y-1 p-2">
                  {status?.networkLogs.length ? status.networkLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-[3px] px-2 py-1.5 text-[11px] text-[var(--vk-text-normal)]"
                    >
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--vk-text-muted)]">
                        <span>{entry.method ?? "GET"}</span>
                        {typeof entry.status === "number" ? <span>{entry.status}</span> : null}
                        {entry.resourceType ? <span>{entry.resourceType}</span> : null}
                        <span>{formatTime(entry.timestamp)}</span>
                      </div>
                      <div className="mt-1 break-all font-mono">{entry.url ?? entry.message}</div>
                    </div>
                  )) : (
                    <div className="px-2 py-3 text-[12px] text-[var(--vk-text-muted)]">
                      Network requests appear here after the preview loads.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
