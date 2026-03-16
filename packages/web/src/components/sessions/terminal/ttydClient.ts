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

export interface FlowControlConfig {
  limit: number;     // bytes accumulated before engaging flow control
  highWater: number; // pending writes threshold to send PAUSE
  lowWater: number;  // pending writes threshold to send RESUME
}

export const DEFAULT_FLOW_CONTROL: FlowControlConfig = {
  limit: 100_000,
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

  // Flow control state — mirrors reference ttyd exactly
  private written = 0;
  private pending = 0;

  // Write batching — accumulate chunks between animation frames so a single
  // TUI update (which the backend may split across multiple 4KB PTY reads)
  // lands as one atomic terminal.write() call with no intermediate renders.
  private batchChunks: Uint8Array[] = [];
  private batchBytes = 0;
  private batchFrame: number | null = null;

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
          this.cancelBatch();
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
   * Handlers are nulled before close to prevent spurious callbacks during cleanup.
   */
  disconnect(): void {
    this.cancelBatch();
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
        // Terminal output — accumulate into the write batch.
        // The batch is flushed to xterm.js on the next animation frame so
        // multiple small WebSocket messages land as one atomic write.
        this.enqueueOutput(payload);
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
   * Enqueue output data for the next batched write.
   *
   * Data is copied into the batch buffer immediately (the WebSocket
   * ArrayBuffer may be reused). A rAF callback is scheduled to flush all
   * accumulated chunks as a single terminal.write() call, eliminating
   * intermediate renders that cause garbled TUI output.
   */
  private enqueueOutput(data: Uint8Array): void {
    // Copy the data — subarray shares the WebSocket ArrayBuffer which may
    // not be retained across message events in all browser implementations.
    const copy = new Uint8Array(data.length);
    copy.set(data);

    this.batchChunks.push(copy);
    this.batchBytes += copy.length;

    if (this.batchFrame === null) {
      this.batchFrame = requestAnimationFrame(() => {
        this.batchFrame = null;
        this.flushBatch();
      });
    }
  }

  /**
   * Flush the accumulated write batch to xterm.js as a single write.
   *
   * Concatenates all queued chunks into one Uint8Array and calls
   * terminal.write() once. This ensures xterm.js processes the entire
   * batch atomically — the parser handles the full sequence of escape codes
   * before the renderer paints, eliminating partial/garbled intermediate frames.
   *
   * Flow control (PAUSE/RESUME) is applied per the ttyd protocol.
   */
  private flushBatch(): void {
    if (this.batchChunks.length === 0) {
      return;
    }

    // Fast path: single chunk — no concatenation needed
    let batch: Uint8Array;
    if (this.batchChunks.length === 1) {
      batch = this.batchChunks[0]!;
    } else {
      batch = new Uint8Array(this.batchBytes);
      let offset = 0;
      for (const chunk of this.batchChunks) {
        batch.set(chunk, offset);
        offset += chunk.length;
      }
    }

    this.batchChunks = [];
    this.batchBytes = 0;

    // Apply flow control on the aggregated batch
    this.writeTerminalData(batch);
  }

  /**
   * Write data to xterm.js with ttyd flow control.
   *
   * Below the byte limit: fast path — terminal.write(data) with zero overhead.
   * Above the byte limit: flow control — track pending xterm.js renders,
   * send PAUSE when too many queued, RESUME when caught up.
   */
  private writeTerminalData(data: Uint8Array): void {
    const { limit, highWater, lowWater } = this.flowControl;

    // Decode bytes to string for xterm.js parser
    const str = this.textDecoder.decode(data, { stream: true });
    if (!str) return; // Empty or incomplete UTF-8 sequence

    this.written += data.length;
    if (this.written > limit) {
      // Flow control path: track xterm.js render completion
      this.terminal.write(str, () => {
        this.pending = Math.max(this.pending - 1, 0);
        if (this.pending < lowWater) {
          this.sendResume();
        }
      });
      this.pending++;
      this.written = 0;
      if (this.pending > highWater) {
        this.sendPause();
      }
    } else {
      // Fast path: direct write, no callback, no tracking
      this.terminal.write(str);
    }
  }

  /** Cancel any pending batch flush. */
  private cancelBatch(): void {
    if (this.batchFrame !== null) {
      cancelAnimationFrame(this.batchFrame);
      this.batchFrame = null;
    }
    this.batchChunks = [];
    this.batchBytes = 0;
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
