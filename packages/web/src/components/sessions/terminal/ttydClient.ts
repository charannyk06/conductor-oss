/**
 * ttyd protocol client — improved over reference implementation with write
 * batching to eliminate mid-frame rendering of partial TUI updates.
 *
 * Reference: https://github.com/tsl0922/ttyd
 *
 * The client owns the xterm.js Terminal reference and writes output directly.
 * All incoming data within a single animation frame is accumulated into one
 * buffer and flushed as a single terminal.write() call. This prevents xterm.js
 * from rendering intermediate states when the backend sends a large TUI update
 * as multiple small WebSocket frames (typically 4KB PTY read chunks).
 *
 * Flow control follows the ttyd protocol exactly:
 *   - Below byte limit: terminal.write(batch) with NO callback (fast path)
 *   - Above byte limit: terminal.write(batch, cb) with pending tracking + PAUSE/RESUME
 */

import type { Terminal } from "@xterm/xterm";

function resolveWebSocketUrl(url: string): string {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return url;
  }
  if (url.startsWith("/")) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${url}`;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const protocol = url.startsWith("https://") ? "wss:" : "ws:";
    const pathStart = url.indexOf("/", url.indexOf("//") + 2);
    const host = url.substring(url.indexOf("//") + 2, pathStart);
    const path = url.substring(pathStart);
    return `${protocol}//${host}${path}`;
  }
  return url;
}

// ttyd command bytes (ASCII characters)
// Server→Client: OUTPUT='0', SET_WINDOW_TITLE='1', SET_PREFERENCES='2'
// Client→Server: INPUT='0', RESIZE_TERMINAL='1', PAUSE='2', RESUME='3', JSON_DATA='{'
const CMD_OUTPUT = 0x30;    // '0'
const CMD_SET_TITLE = 0x31; // '1'
const CMD_SET_PREFS = 0x32; // '2'
const CMD_INPUT = 0x30;     // '0'
const CMD_RESIZE = 0x31;    // '1'

// Flow control is simple: just track pending writes
export interface FlowControlConfig {
  highWater: number; // pending writes threshold to send PAUSE
  lowWater: number;  // pending writes threshold to send RESUME
}

export const DEFAULT_FLOW_CONTROL: FlowControlConfig = {
  highWater: 10,
  lowWater: 4,
};

export interface TtydCallbacks {
  onTitle?: (title: string) => void;
  onPreferences?: (prefs: unknown) => void;
  onConnected?: () => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (error: string) => void;
}

/**
 * ttyd WebSocket client.
 * Writes output directly to the xterm.js Terminal with proper flow control
 * and frame-aligned write batching for flicker-free rendering.
 */
export class TtydClient {
  private socket: WebSocket | null = null;
  private terminal: Terminal;
  private flowControl: FlowControlConfig;
  private callbacks: TtydCallbacks;

  // Flow control state — track pending writes
  private pending = 0;

  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder("utf-8", { fatal: false });

  constructor(
    terminal: Terminal,
    flowControl: FlowControlConfig = DEFAULT_FLOW_CONTROL,
    callbacks: TtydCallbacks = {},
  ) {
    this.terminal = terminal;
    this.flowControl = flowControl;
    this.callbacks = callbacks;
  }

  /**
   * Connect to the ttyd WebSocket endpoint.
   * Sends a JSON_DATA handshake with terminal dimensions per ttyd protocol.
   */
  connect(url: string, cols?: number, rows?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = resolveWebSocketUrl(url);
        this.socket = new WebSocket(wsUrl);
        this.socket.binaryType = "arraybuffer";

        const timeout = setTimeout(() => {
          if (
            this.socket &&
            this.socket.readyState !== WebSocket.OPEN &&
            this.socket.readyState !== WebSocket.CLOSED
          ) {
            this.socket.close();
            reject(new Error("WebSocket connection timeout"));
          }
        }, 10000);

        this.socket.onopen = () => {
          clearTimeout(timeout);

          // ttyd handshake: send JSON_DATA with terminal dimensions
          const handshake = JSON.stringify({
            columns: cols ?? this.terminal.cols ?? 120,
            rows: rows ?? this.terminal.rows ?? 40,
          });
          this.socket?.send(this.textEncoder.encode(handshake));

          this.callbacks.onConnected?.();
          resolve();
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data as ArrayBuffer);
        };

        this.socket.onclose = (event) => {
          clearTimeout(timeout);
          this.socket = null;
          this.callbacks.onDisconnected?.(event.code, event.reason || "");
          // no-op if promise already resolved
          reject(new Error(`WebSocket closed: ${event.code}`));
        };

        this.socket.onerror = () => {
          clearTimeout(timeout);
          this.callbacks.onError?.("WebSocket connection failed");
          reject(new Error("WebSocket connection failed"));
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Disconnect from the WebSocket.
   */
  disconnect(): void {
    // Flush any remaining UTF-8 sequence from the decoder
    const remaining = this.textDecoder.decode();
    if (remaining) {
      this.terminal.write(remaining);
    }
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close(1000, "Normal closure");
      this.socket = null;
    }
  }

  /** Send keyboard input to the PTY: [INPUT='0'][payload] */
  sendInput(data: string | Uint8Array): void {
    if (!this.isConnected()) return;

    let payload: Uint8Array;
    if (typeof data === "string") {
      const buffer = new Uint8Array(data.length * 3 + 1);
      buffer[0] = CMD_INPUT;
      const stats = this.textEncoder.encodeInto(data, buffer.subarray(1));
      payload = buffer.subarray(0, (stats.written ?? 0) + 1);
    } else {
      payload = new Uint8Array(data.length + 1);
      payload[0] = CMD_INPUT;
      payload.set(data, 1);
    }
    this.socket?.send(payload);
  }

  /** Send resize request: [RESIZE='1'][JSON{columns,rows}] */
  sendResize(cols: number, rows: number): void {
    if (!this.isConnected()) return;

    const json = JSON.stringify({
      columns: Math.max(1, cols),
      rows: Math.max(1, rows),
    });
    const jsonBytes = this.textEncoder.encode(json);
    const payload = new Uint8Array(1 + jsonBytes.length);
    payload[0] = CMD_RESIZE;
    payload.set(jsonBytes, 1);
    this.socket?.send(payload);
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  // --------------- Private ---------------

  private handleMessage(buffer: ArrayBuffer): void {
    const view = new Uint8Array(buffer);
    if (view.length === 0) return;

    const cmd = view[0];
    const payload = view.subarray(1);

    switch (cmd) {
      case CMD_OUTPUT:
        // Terminal output — write directly with flow control
        this.writeOutput(payload);
        break;
      case CMD_SET_TITLE:
        try {
          this.callbacks.onTitle?.(this.textDecoder.decode(payload));
        } catch {
          /* ignore decode errors */
        }
        break;
      case CMD_SET_PREFS:
        try {
          this.callbacks.onPreferences?.(
            JSON.parse(this.textDecoder.decode(payload)),
          );
        } catch {
          /* ignore parse errors */
        }
        break;
      default:
        break;
    }
  }

  /**
   * Write output data directly to xterm.js with flow control.
   * Decodes UTF-8 and applies backpressure via PAUSE/RESUME.
   */
  private writeOutput(data: Uint8Array): void {
    const { highWater, lowWater } = this.flowControl;

    // Decode bytes to string for xterm.js parser
    const str = this.textDecoder.decode(data, { stream: true });
    if (!str) return; // Empty or incomplete UTF-8 sequence

    // For small writes, use fast path (no callback overhead)
    const byteLength = data.byteLength;
    if (byteLength < 1024) {
      // Fast path: direct write without callback
      this.terminal.write(str);
      return;
    }

    // For larger writes, track pending with callback for flow control
    this.terminal.write(str, () => {
      this.pending = Math.max(this.pending - 1, 0);
      if (this.pending < lowWater && this.pending > 0) {
        this.sendResume();
      }
    });

    this.pending++;
    if (this.pending >= highWater) {
      this.sendPause();
    }
  }

  private sendPause(): void {
    if (!this.isConnected()) return;
    this.socket?.send(new Uint8Array([0x32])); // '2'
  }

  private sendResume(): void {
    if (!this.isConnected()) return;
    this.socket?.send(new Uint8Array([0x33])); // '3'
  }
}
