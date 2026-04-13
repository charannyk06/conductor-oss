import { Buffer } from "node:buffer";
import type { BridgePreviewConfig } from "@/lib/previewSession";
import type {
  PreviewCommandRequest,
  PreviewDomResponse,
  PreviewStatusResponse,
} from "@/lib/previewTypes";
import type { PreviewBrowserManagerClient } from "./devPreviewBrowser";
import { resolveBridgeRelayUrl } from "./bridgeRelayUrl";

type WorkerCommandRequest =
  | PreviewCommandRequest
  | { command: "status"; candidateUrls: string[] }
  | { command: "dom"; frameId?: string | null; interactiveOnly?: boolean }
  | { command: "screenshot" };

type WorkerCommandResponse =
  | ({ kind: "status" } & PreviewStatusResponse)
  | ({ kind: "dom" } & PreviewDomResponse)
  | { kind: "screenshot"; imageBase64: string }
  | { kind: "error"; message: string };

type RemoteBridgePreviewConfig = BridgePreviewConfig & {
  relayUrl: string;
  forwardedHeaders: Record<string, string>;
};

type CreatePreviewWorkerSessionPayload = {
  bridgePreview?: RemoteBridgePreviewConfig | null;
};

function normalizeWorkerUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function buildDisconnectedStatus(
  candidateUrls: string[],
  lastError: string | null = null,
): PreviewStatusResponse {
  return {
    connected: false,
    candidateUrls,
    currentUrl: null,
    title: null,
    tunnelUrl: null,
    tunnelLocalOrigin: null,
    canGoBack: false,
    canGoForward: false,
    frames: [],
    activeFrameId: null,
    selectedElement: null,
    consoleLogs: [],
    networkLogs: [],
    lastError,
    screenshotKey: `${Date.now()}`,
  };
}

class PreviewWorkerClient implements PreviewBrowserManagerClient {
  private readonly workerUrl = normalizeWorkerUrl(process.env.CONDUCTOR_PREVIEW_WORKER_URL);
  private readonly workerApiKey = process.env.CONDUCTOR_PREVIEW_WORKER_KEY?.trim() || null;
  private readonly remoteSessionIds = new Map<string, string>();
  private readonly bridgePreviewConfigs = new Map<string, RemoteBridgePreviewConfig | null>();

  async configureBridgePreview(
    sessionId: string,
    config: BridgePreviewConfig | null,
    forwardedHeaders?: HeadersInit,
  ): Promise<void> {
    const relayUrl = resolveBridgeRelayUrl();
    const nextConfig = config && forwardedHeaders && relayUrl
      ? {
          ...config,
          relayUrl,
          forwardedHeaders: Object.fromEntries(new Headers(forwardedHeaders).entries()),
        }
      : null;
    const previousConfig = this.bridgePreviewConfigs.get(sessionId) ?? null;
    if (JSON.stringify(previousConfig) === JSON.stringify(nextConfig)) {
      return;
    }

    this.bridgePreviewConfigs.set(sessionId, nextConfig);

    const remoteSessionId = this.remoteSessionIds.get(sessionId);
    if (!remoteSessionId || !this.isConfigured()) {
      return;
    }

    this.remoteSessionIds.delete(sessionId);
    try {
      await fetch(`${this.workerUrl}/sessions/${encodeURIComponent(remoteSessionId)}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
        cache: "no-store",
      });
    } catch {
      // Swallow worker teardown failures so config refresh never blocks callers.
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const remoteSessionId = this.remoteSessionIds.get(sessionId);
    this.remoteSessionIds.delete(sessionId);
    this.bridgePreviewConfigs.delete(sessionId);
    if (!remoteSessionId || !this.isConfigured()) {
      return;
    }

    try {
      await fetch(`${this.workerUrl}/sessions/${encodeURIComponent(remoteSessionId)}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
        cache: "no-store",
      });
    } catch {
      // Swallow worker teardown failures so session cleanup never blocks the caller.
    }
  }

  async runCommand(sessionId: string, command: PreviewCommandRequest): Promise<void> {
    const response = await this.sendCommand(sessionId, command, { createIfMissing: true });
    if (response.kind === "error") {
      throw new Error(response.message);
    }
  }

  async inspectDom(
    sessionId: string,
    frameId?: string | null,
    interactiveOnly = false,
  ): Promise<PreviewDomResponse> {
    const response = await this.sendCommand(
      sessionId,
      { command: "dom", frameId, interactiveOnly },
      { createIfMissing: true },
    );
    if (response.kind !== "dom") {
      throw new Error(response.kind === "error" ? response.message : "Unexpected preview worker DOM response");
    }
    return response;
  }

  async takeScreenshot(sessionId: string): Promise<Uint8Array | null> {
    if (!this.remoteSessionIds.has(sessionId)) {
      return null;
    }

    const response = await this.sendCommand(
      sessionId,
      { command: "screenshot" },
      { createIfMissing: false },
    );
    if (response.kind === "error") {
      if (response.message.includes("not connected")) {
        return null;
      }
      throw new Error(response.message);
    }

    if (response.kind !== "screenshot") {
      throw new Error("Unexpected preview worker screenshot response");
    }

    return Buffer.from(response.imageBase64, "base64");
  }

  async getStatus(sessionId: string, candidateUrls: string[]): Promise<PreviewStatusResponse> {
    if (!this.remoteSessionIds.has(sessionId)) {
      return buildDisconnectedStatus(candidateUrls, this.configurationError());
    }

    try {
      const response = await this.sendCommand(
        sessionId,
        { command: "status", candidateUrls },
        { createIfMissing: false },
      );

      if (response.kind === "status") {
        return response;
      }

      return buildDisconnectedStatus(
        candidateUrls,
        response.kind === "error" ? response.message : "Preview service is unavailable",
      );
    } catch (error) {
      return buildDisconnectedStatus(
        candidateUrls,
        error instanceof Error ? error.message : "Preview service is unavailable",
      );
    }
  }

  private async sendCommand(
    sessionId: string,
    command: WorkerCommandRequest,
    options: { createIfMissing: boolean; retry?: boolean },
  ): Promise<WorkerCommandResponse> {
    const configurationError = this.configurationError();
    if (configurationError) {
      return { kind: "error", message: configurationError };
    }

    let remoteSessionId = this.remoteSessionIds.get(sessionId) ?? null;
    if (!remoteSessionId) {
      if (!options.createIfMissing) {
        return { kind: "error", message: "Preview is not connected" };
      }
      remoteSessionId = await this.createRemoteSession(sessionId);
    }

    try {
      const response = await fetch(
        `${this.workerUrl}/sessions/${encodeURIComponent(remoteSessionId)}/command`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(command),
          cache: "no-store",
        },
      );

      const payload = await response.json() as WorkerCommandResponse;
      if (response.status === 404 && options.retry !== false) {
        this.remoteSessionIds.delete(sessionId);
        return await this.sendCommand(sessionId, command, {
          createIfMissing: options.createIfMissing,
          retry: false,
        });
      }

      if (!response.ok || payload.kind === "error") {
        return payload.kind === "error"
          ? payload
          : { kind: "error", message: "Preview worker request failed" };
      }

      return payload;
    } catch (error) {
      throw new Error(this.networkErrorMessage(error));
    }
  }

  private async createRemoteSession(sessionId: string): Promise<string> {
    const configurationError = this.configurationError();
    if (configurationError) {
      throw new Error(configurationError);
    }

    const payload: CreatePreviewWorkerSessionPayload = {
      bridgePreview: this.bridgePreviewConfigs.get(sessionId) ?? null,
    };

    try {
      const response = await fetch(`${this.workerUrl}/sessions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      const sessionPayload = await response.json() as { sessionId?: string; error?: string };
      if (!response.ok || !sessionPayload.sessionId) {
        throw new Error(sessionPayload.error || "Preview worker session creation failed");
      }

      this.remoteSessionIds.set(sessionId, sessionPayload.sessionId);
      return sessionPayload.sessionId;
    } catch (error) {
      throw new Error(this.networkErrorMessage(error));
    }
  }

  private buildHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.workerApiKey}`,
      "Content-Type": "application/json",
    };
  }

  private configurationError(): string | null {
    if (!this.workerUrl || !this.workerApiKey) {
      return "Preview worker is not configured";
    }
    return null;
  }

  private isConfigured(): boolean {
    return this.configurationError() === null;
  }

  private networkErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "Preview service is unavailable";
    if (message === "Preview worker is not configured") {
      return message;
    }
    return "Preview service is unavailable";
  }
}

const globalForPreviewWorker = globalThis as typeof globalThis & {
  _conductorPreviewWorkerClient?: PreviewWorkerClient;
};

export function getPreviewWorkerClient(): PreviewBrowserManagerClient {
  if (!globalForPreviewWorker._conductorPreviewWorkerClient) {
    globalForPreviewWorker._conductorPreviewWorkerClient = new PreviewWorkerClient();
  }

  return globalForPreviewWorker._conductorPreviewWorkerClient;
}
