"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  PreviewCommandRequest,
  PreviewDomNode,
  PreviewDomResponse,
  PreviewStatusResponse,
} from "@/lib/previewTypes";

const STATUS_POLL_INTERVAL_MS = 4_000;
const AUTO_CONNECT_RETRY_MS = 5_000;
const SELECTION_COMPOSER_WIDTH_PX = 340;
const SELECTION_COMPOSER_HEIGHT_PX = 280;
const SELECTION_COMPOSER_MARGIN_PX = 12;
const MOBILE_SELECTION_COMPOSER_BREAKPOINT_PX = 520;

interface SessionPreviewProps {
  sessionId: string;
  projectId?: string | null;
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

function pointWithinBounds(
  x: number,
  y: number,
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return x >= bounds.x
    && x <= bounds.x + bounds.width
    && y >= bounds.y
    && y <= bounds.y + bounds.height;
}

async function uploadPreviewAttachments(projectId: string, files: File[]): Promise<string[]> {
  if (!files.length) return [];

  const formData = new FormData();
  formData.append("projectId", projectId);
  for (const file of files) {
    formData.append("files", file);
  }

  const response = await fetch("/api/attachments", {
    method: "POST",
    body: formData,
  });

  const payload = await response.json().catch(() => null) as
    | { error?: string; files?: Array<Record<string, unknown>> }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `Failed to upload preview attachments: ${response.status}`);
  }

  const fileRecords = Array.isArray(payload?.files) ? payload?.files : [];
  const paths = fileRecords.flatMap((record) => {
    const candidates = [
      record.absolutePath,
      record.path,
      record.filePath,
    ];
    return candidates.filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  });

  if (!paths.length) {
    throw new Error("Attachment upload did not return file paths");
  }

  return paths;
}

export function SessionPreview({ sessionId, projectId }: SessionPreviewProps) {
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
  const [instruction, setInstruction] = useState("");
  const [imageMetrics, setImageMetrics] = useState({
    naturalWidth: 0,
    naturalHeight: 0,
    renderedWidth: 0,
    renderedHeight: 0,
  });

  const autoConnectRef = useRef<{ candidate: string; attemptedAt: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement | null>(null);

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

  const runCommand = useCallback(async (command: PreviewCommandRequest) => {
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

      setStatus(payload as PreviewStatusResponse);
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

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
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.connected) {
      setDomNodes([]);
      return;
    }
    void loadDom(status.activeFrameId);
  }, [interactiveOnly, loadDom, status?.activeFrameId, status?.connected, status?.screenshotKey]);

  useEffect(() => {
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
  }, [runCommand, status?.candidateUrls, status?.connected]);

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

  const selectedElementRenderedBounds = useMemo(() => {
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
      x: bounds.x * scaleX,
      y: bounds.y * scaleY,
      width: Math.max(bounds.width * scaleX, 2),
      height: Math.max(bounds.height * scaleY, 2),
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
    if (!selectionComposer || selectionComposer.pending) return;
    instructionRef.current?.focus();
  }, [selectionComposer]);

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

  const handleImageClick = useCallback(async (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!imageRef.current || busy) return;

    const rect = imageRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height || !imageRef.current.naturalWidth || !imageRef.current.naturalHeight) {
      return;
    }

    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const x = (anchorX / rect.width) * imageRef.current.naturalWidth;
    const y = (anchorY / rect.height) * imageRef.current.naturalHeight;

    setSelectionComposer(null);
    setSendError(null);
    setSendSuccess(null);

    if (previewMode === "navigate") {
      try {
        await runCommand({ command: "clickAtPoint", x, y });
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : "Failed to interact with preview");
      }
      return;
    }

    if (!canSelectByPoint) return;

    if (
      selectedElementRenderedBounds
      && !selectionComposer?.pending
      && pointWithinBounds(anchorX, anchorY, selectedElementRenderedBounds)
    ) {
      openSelectionComposer(anchorX, anchorY, false);
      return;
    }

    try {
      await runCommand({ command: "selectAtPoint", x, y });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to select element");
    }
  }, [
    busy,
    canSelectByPoint,
    openSelectionComposer,
    previewMode,
    runCommand,
    selectedElementRenderedBounds,
    selectionComposer?.pending,
  ]);

  const handleSendContext = useCallback(async (target: PreviewSendTarget) => {
    if (!projectId) {
      setSendError("Preview attachments require a project-backed session.");
      return;
    }
    if (!status) {
      setSendError("Preview state is not loaded yet.");
      return;
    }

    const recentConsoleLogs = status.consoleLogs.slice(-80);
    const recentNetworkLogs = status.networkLogs.slice(-80);

    if (target === "selection" && !status.selectedElement) {
      setSendError("Select an element before sending preview context to the agent.");
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
      const basePreviewPayload = {
        sessionId,
        currentUrl: status.currentUrl,
        activeFrameId: status.activeFrameId,
        selectedElement: status.selectedElement,
        frames: status.frames,
      };

      const payloadByTarget = {
        selection: {
          ...basePreviewPayload,
          recentConsoleLogs,
          recentNetworkLogs,
        },
        console: {
          ...basePreviewPayload,
          recentConsoleLogs,
        },
        network: {
          ...basePreviewPayload,
          recentNetworkLogs,
        },
      } satisfies Record<PreviewSendTarget, Record<string, unknown>>;

      const jsonPayload = {
        generatedAt: new Date().toISOString(),
        target,
        preview: payloadByTarget[target],
      };

      const files: File[] = [
        new File(
          [JSON.stringify(jsonPayload, null, 2)],
          `${sessionId}-preview-${target}.json`,
          { type: "application/json" },
        ),
      ];

      if (screenshotUrl) {
        const screenshotResponse = await fetch(screenshotUrl, { cache: "no-store" });
        if (screenshotResponse.ok) {
          const screenshotBlob = await screenshotResponse.blob();
          files.push(new File([screenshotBlob], `${sessionId}-preview-${target}.png`, { type: "image/png" }));
        }
      }

      const attachmentPaths = await uploadPreviewAttachments(projectId, files);
      const messageByTarget = {
        selection: [
          "Use the attached preview context JSON and screenshot to update the UI.",
          `Selected element selector: ${status.selectedElement?.selector ?? "n/a"}`,
          `Selected frame: ${status.selectedElement?.frameName ?? "n/a"} (${status.selectedElement?.frameUrl ?? "n/a"})`,
          instruction.trim() || "Apply the requested UI change to the selected element and surrounding layout as needed.",
        ],
        console: [
          "Use the attached preview console logs and screenshot to debug the current page state.",
          `Preview URL: ${status.currentUrl ?? "unavailable"}`,
          status.selectedElement ? `Current selected element: ${status.selectedElement.selector}` : null,
          instruction.trim() || "Investigate the console output, identify the root cause, and apply the needed fix.",
        ],
        network: [
          "Use the attached preview network logs and screenshot to debug failed or unexpected requests.",
          `Preview URL: ${status.currentUrl ?? "unavailable"}`,
          status.selectedElement ? `Current selected element: ${status.selectedElement.selector}` : null,
          instruction.trim() || "Investigate the network activity, identify the failing request or sequencing issue, and apply the needed fix.",
        ],
      } satisfies Record<PreviewSendTarget, Array<string | null>>;

      const successMessageByTarget = {
        selection: "Preview context sent to the session agent.",
        console: "Console logs sent to the session agent.",
        network: "Network logs sent to the session agent.",
      } satisfies Record<PreviewSendTarget, string>;

      const elementSummary = messageByTarget[target].filter((line): line is string => Boolean(line)).join("\n");

      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: elementSummary,
          attachments: attachmentPaths,
        }),
      });

      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to send preview context: ${response.status}`);
      }

      setInstruction("");
      if (target === "selection") {
        setSelectionComposer(null);
      }
      setSendSuccess(successMessageByTarget[target]);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send preview context");
    } finally {
      setSendingTarget(null);
    }
  }, [
    instruction,
    projectId,
    screenshotUrl,
    sessionId,
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
                    ? "inspect mode: click once to select, again to message"
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
              <div className="relative flex max-h-full max-w-full items-start justify-center overflow-auto">
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
                        <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">Current chat</div>
                        <div className="mt-1 text-[13px] font-medium text-[var(--vk-text-normal)]">
                          {selectionComposer.pending ? "Selecting element…" : "Send to current agent"}
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
                          <div className="space-y-2">
                            <label className="text-[11px] uppercase tracking-[0.14em] text-[var(--vk-text-muted)]">
                              Instruction
                            </label>
                            <textarea
                              ref={instructionRef}
                              value={instruction}
                              onChange={(event) => setInstruction(event.target.value)}
                              placeholder="Describe the change and send it straight to this agent session…"
                              className="min-h-[108px] w-full rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
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
                            Send to current agent
                          </Button>
                        </>
                      ) : (
                        <div className="rounded-[6px] border border-dashed border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                          Click the current selection again to open the composer and send it into the current session chat.
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="max-w-md text-center text-[13px] text-[var(--vk-text-muted)]">
                Connect a local dev URL to start the preview browser. Use Navigate mode to click through the running app, or switch to Inspect mode to select an element and send it to the current agent.
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
                      Switch to Inspect mode to pick DOM nodes or send selected UI context to the current agent.
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
                          if (
                            status?.selectedElement
                            && status.selectedElement.selector === node.selector
                            && status.selectedElement.frameId === status.activeFrameId
                          ) {
                            openSelectionComposer(
                              Math.max(imageMetrics.renderedWidth - 44, SELECTION_COMPOSER_MARGIN_PX),
                              SELECTION_COMPOSER_MARGIN_PX,
                              false,
                            );
                            return;
                          }

                          setSelectionComposer(null);
                          setSendError(null);
                          setSendSuccess(null);
                          void runCommand({
                            command: "selectBySelector",
                            selector: node.selector,
                            frameId: status?.activeFrameId,
                          })
                            .catch((error: unknown) => {
                              setCommandError(error instanceof Error ? error.message : "Failed to select DOM node");
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
                Send to agent
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
                Send to agent
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
