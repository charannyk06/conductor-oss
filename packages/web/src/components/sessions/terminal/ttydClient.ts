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
  private paused = false;

  // Write batching — accumulate output within a single animation frame
  // and flush as one terminal.write() call to prevent mid-frame rendering.
  private batchChunks: Uint8Array[] = [];
  private batchBytes = 0;
  private batchFrameId: number | null = null;

  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder("utf-8", { fatal: false });
  // Streaming decoder for terminal output — maintains state across flushes
  // to correctly handle multi-byte UTF-8 sequences split across frames.
  private streamDecoder = new TextDecoder("utf-8", { fatal: false });

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
        // Close any existing socket before opening a new one
        if (this.socket) {
          this.socket.onopen = null;
          this.socket.onmessage = null;
          this.socket.onclose = null;
          this.socket.onerror = null;
          this.socket.close(1000, "Reconnecting");
          this.socket = null;
        }

        // Reset flow control, batch state, and streaming decoder for the new connection
        this.pending = 0;
        this.paused = false;
        this.cancelBatch();
        this.streamDecoder = new TextDecoder("utf-8", { fatal: false });

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
          if (typeof event.data === "string") {
            return;
          }
          this.handleMessage(event.data as ArrayBuffer);
        };

        this.socket.onclose = (event) => {
          clearTimeout(timeout);
          this.socket = null;
          this.flushBatch(); // flush any pending output before signalling disconnect
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
    this.flushBatch();
    // Flush any incomplete UTF-8 bytes remaining in the streaming decoder
    const trailing = this.streamDecoder.decode(new Uint8Array(0), { stream: false });
    if (trailing.length > 0 && this.terminal) {
      this.terminal.write(trailing);
    }
    this.cancelBatch();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close(1000, "Normal closure");
      this.socket = null;
    }
  }

  /**
   * Send keyboard/paste input to the PTY: [INPUT='0'][payload]
   *
   * Large pastes are chunked into 4 KB frames to avoid overwhelming the PTY
   * write buffer or hitting WebSocket frame limits — matches the reference
   * ttyd client behaviour.
   */
  private static readonly INPUT_CHUNK_SIZE = 4096;

  sendInput(data: string | Uint8Array): void {
    if (!this.isConnected()) return;

    const bytes = typeof data === "string"
      ? this.textEncoder.encode(data)
      : data;

    // Small inputs (single keystrokes, short pastes): send in one frame.
    if (bytes.length <= TtydClient.INPUT_CHUNK_SIZE) {
      const frame = new Uint8Array(1 + bytes.length);
      frame[0] = CMD_INPUT;
      frame.set(bytes, 1);
      this.socket?.send(frame);
      return;
    }

    // Large pastes: chunk to avoid PTY buffer overflow.
    for (let offset = 0; offset < bytes.length; offset += TtydClient.INPUT_CHUNK_SIZE) {
      const end = Math.min(offset + TtydClient.INPUT_CHUNK_SIZE, bytes.length);
      const chunk = bytes.subarray(offset, end);
      const frame = new Uint8Array(1 + chunk.length);
      frame[0] = CMD_INPUT;
      frame.set(chunk, 1);
      this.socket?.send(frame);
    }
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
        // Terminal output — accumulate into batch buffer, flush on next frame
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
   * Accumulate output data into the batch buffer. The batch is flushed as a
   * single terminal.write() call on the next animation frame. This prevents
   * xterm.js from rendering intermediate partial TUI states when the backend
   * sends a large update as multiple WebSocket messages within one frame.
   */
  private enqueueOutput(data: Uint8Array): void {
    if (!this.terminal || data.byteLength === 0) return;

    // Copy the data since the underlying ArrayBuffer may be reused
    this.batchChunks.push(new Uint8Array(data));
    this.batchBytes += data.byteLength;

    // Schedule flush on next animation frame (only once per frame)
    if (this.batchFrameId === null) {
      this.batchFrameId = requestAnimationFrame(() => {
        this.batchFrameId = null;
        this.flushBatch();
      });
    }
  }

  /**
   * Flush all accumulated output to the terminal as a single write.
   */
  private flushBatch(): void {
    if (this.batchChunks.length === 0 || !this.terminal) return;

    const { highWater, lowWater } = this.flowControl;

    // Combine all chunks into a single buffer
    let combined: Uint8Array;
    if (this.batchChunks.length === 1) {
      combined = this.batchChunks[0]!;
    } else {
      combined = new Uint8Array(this.batchBytes);
      let offset = 0;
      for (const chunk of this.batchChunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    // Reset batch state before writing (in case write triggers synchronous events)
    this.batchChunks.length = 0;
    this.batchBytes = 0;

    // Decode bytes to string using the streaming decoder. This correctly
    // handles multi-byte UTF-8 sequences split across animation frames —
    // the decoder buffers incomplete trailing bytes and prepends them to
    // the next flush. Passing { stream: true } is critical; without it,
    // split sequences produce U+FFFD replacement characters (blocks).
    const text = this.streamDecoder.decode(combined, { stream: true });
    if (text.length === 0) return;

    // Small batches: fast path without callback overhead
    if (text.length < 4096) {
      this.terminal.write(text);
      return;
    }

    // Large batches: track pending writes for flow control
    this.terminal.write(text, () => {
      this.pending = Math.max(this.pending - 1, 0);
      // Send RESUME exactly once when pending drops below lowWater
      if (this.paused && this.pending < lowWater) {
        this.paused = false;
        this.sendResume();
      }
    });

    this.pending++;
    if (!this.paused && this.pending >= highWater) {
      this.paused = true;
      this.sendPause();
    }
  }

  /** Cancel any pending batch flush. */
  private cancelBatch(): void {
    if (this.batchFrameId !== null) {
      cancelAnimationFrame(this.batchFrameId);
      this.batchFrameId = null;
    }
    this.batchChunks.length = 0;
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
