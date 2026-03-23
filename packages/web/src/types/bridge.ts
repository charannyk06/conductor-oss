export type FileEntryKind = "file" | "dir";

export interface FileEntry {
  name: string;
  kind: FileEntryKind;
}

export type BrowserToBridgeMessage =
  | {
      type: "terminal_resize";
      cols: number;
      rows: number;
    }
  | {
      type: "terminal_input";
      data: string;
    }
  | {
      type: "api_request";
      id: string;
      method: string;
      path: string;
      body?: unknown;
    }
  | {
      type: "file_browse";
      path: string;
    }
  | {
      type: "ping";
    };

export type BridgeToBrowserMessage =
  | {
      type: "terminal_output";
      data: string;
    }
  | {
      type: "api_response";
      id: string;
      status: number;
      body: unknown;
    }
  | {
      type: "file_tree";
      path: string;
      entries: FileEntry[];
    }
  | {
      type: "bridge_status";
      hostname: string;
      os: string;
      connected: boolean;
      version?: string | null;
    }
  | {
      type: "pong";
    };

export interface BridgeStatus {
  hostname: string;
  os: string;
  connected: boolean;
  version?: string | null;
}

export const BRIDGE_TOKEN_STORAGE_KEY = "conductor-bridge-token";
export const BRIDGE_RELAY_URL_STORAGE_KEY = "conductor-bridge-relay-url";
export const BRIDGE_CONNECTION_SCOPE = "conductor-bridge-control";

export function isBridgeToBrowserMessage(value: unknown): value is BridgeToBrowserMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown };
  return message.type === "terminal_output"
    || message.type === "api_response"
    || message.type === "file_tree"
    || message.type === "bridge_status"
    || message.type === "pong";
}

export function isBrowserToBridgeMessage(value: unknown): value is BrowserToBridgeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown };
  return message.type === "terminal_resize"
    || message.type === "terminal_input"
    || message.type === "api_request"
    || message.type === "file_browse"
    || message.type === "ping";
}
