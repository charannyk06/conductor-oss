/**
 * ttyd protocol client for efficient binary terminal streaming
 * Implements the ttyd binary protocol for low-latency terminal data transfer
 * Reference: https://github.com/tsl0922/ttyd
 */

/**
 * Convert relative or absolute URL to WebSocket URL
 */
function resolveWebSocketUrl(url: string): string {
  // If already a WebSocket URL, return as-is
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return url;
  }

  // If relative path, convert to WebSocket URL
  if (url.startsWith("/")) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}${url}`;
    console.log("[TTyD] Resolved relative URL", { original: url, resolved: wsUrl, windowHost: window.location.host });
    return wsUrl;
  }

  // If absolute HTTP/HTTPS URL, convert to WebSocket
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const protocol = url.startsWith("https://") ? "wss:" : "ws:";
    const pathStart = url.indexOf("/", url.indexOf("//") + 2);
    const host = url.substring(url.indexOf("//") + 2, pathStart);
    const path = url.substring(pathStart);
    const wsUrl = `${protocol}//${host}${path}`;
    console.log("[TTyD] Resolved absolute URL", { original: url, resolved: wsUrl, host });
    return wsUrl;
  }

  console.warn("[TTyD] URL format not recognized", { url });
  return url;
}

// Command bytes for ttyd protocol
const CMD_OUTPUT = 0x30; // '0' - terminal output
const CMD_INPUT = 0x30; // '0' - keyboard input
const CMD_RESIZE = 0x31; // '1' - resize terminal
const CMD_PAUSE = 0x32; // '2' - pause output
const CMD_RESUME = 0x33; // '3' - resume output
const CMD_PREFS = 0x32; // '2' - set preferences

/**
 * Flow control configuration based on ttyd defaults
 */
export interface FlowControlConfig {
  writeThreshold: number; // bytes written before checking backpressure (default: 100KB)
  highWater: number; // pending writes before sending PAUSE (default: 10)
  lowWater: number; // pending writes before sending RESUME (default: 4)
}

export const DEFAULT_FLOW_CONTROL: FlowControlConfig = {
  writeThreshold: 100_000,
  highWater: 10,
  lowWater: 4,
};

/**
 * TTyD protocol client for bidirectional terminal communication
 * Handles binary WebSocket frames with ttyd protocol encoding/decoding
 */
export class TtydClient {
  private socket: WebSocket | null = null;
  private pendingReconnect = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  // Flow control state
  private flowControl: FlowControlConfig;
  private bytesWritten = 0;
  private pendingWrites = 0;
  private paused = false;

  // Callbacks
  private onData: ((data: string | Uint8Array) => void) | null = null;
  private onTitle: ((title: string) => void) | null = null;
  private onPreferences: ((prefs: unknown) => void) | null = null;
  private onConnected: (() => void) | null = null;
  private onDisconnected: ((code: number, reason: string) => void) | null = null;
  private onError: ((error: string) => void) | null = null;

  // Text encoding for efficient UTF-8 handling
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder("utf-8", { fatal: false });

  constructor(flowControl?: Partial<FlowControlConfig>) {
    this.flowControl = {
      ...DEFAULT_FLOW_CONTROL,
      ...flowControl,
    };
  }

  /**
   * Connect to the ttyd WebSocket endpoint
   */
  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = resolveWebSocketUrl(url);
        console.log("[TTyD] === INITIATING CONNECTION ===", {
          originalUrl: url,
          resolvedWsUrl: wsUrl,
          timestamp: new Date().toISOString(),
          windowLocation: { protocol: window.location.protocol, host: window.location.host }
        });

        console.log("[TTyD] Creating WebSocket object...");
        this.socket = new WebSocket(wsUrl);
        console.log("[TTyD] WebSocket object created, readyState:", this.socket.readyState);
        this.socket.binaryType = "arraybuffer";

        // Add timeout for connection attempts
        const timeout = setTimeout(() => {
          if (this.socket && this.socket.readyState !== WebSocket.OPEN && this.socket.readyState !== WebSocket.CLOSED) {
            console.error("[TTyD] Connection timeout after 10 seconds", { readyState: this.socket?.readyState });
            this.socket.close();
            reject(new Error("WebSocket connection timeout"));
          }
        }, 10000);

        this.socket.onopen = () => {
          clearTimeout(timeout);
          console.log("[TTyD] WebSocket ONOPEN FIRED - connection successfully opened", {
            readyState: this.socket?.readyState,
            readyStateStr: "OPEN",
            timestamp: new Date().toISOString()
          });

          // Send client handshake immediately to signal that browser is ready
          // Send as BINARY frame with JSON content (matches ttyd protocol)
          const handshake = JSON.stringify({ type: "handshake" });
          const handshakeBytes = new TextEncoder().encode(handshake);
          console.log("[TTyD] Sending client handshake", {
            length: handshakeBytes.length,
            firstByte: handshakeBytes[0],
            firstChar: String.fromCharCode(handshakeBytes[0])
          });
          try {
            this.socket?.send(handshakeBytes);
            console.log("[TTyD] Handshake sent successfully");
          } catch (err) {
            console.error("[TTyD] Error sending handshake:", err);
            throw err;
          }

          this.reconnectAttempts = 0;
          this.pendingReconnect = false;
          this.onConnected?.();
          resolve();
        };

        this.socket.onmessage = (event) => {
          const data = event.data as ArrayBuffer;
          const view = new Uint8Array(data);
          console.log("[TTyD] Received message", {
            size: data.byteLength,
            firstByte: view[0],
            firstByteChar: String.fromCharCode(view[0]),
            readyState: this.socket?.readyState,
            timestamp: new Date().toISOString()
          });
          this.handleMessage(event.data as ArrayBuffer);
        };

        this.socket.onclose = (event) => {
          clearTimeout(timeout);
          console.warn("[TTyD] WebSocket onclose fired", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            readyState: this.socket?.readyState,
            timestamp: new Date().toISOString()
          });
          this.handleDisconnect(event.code, event.reason || "");
          reject(new Error(`WebSocket closed with code ${event.code}`));
        };

        this.socket.onerror = (event) => {
          clearTimeout(timeout);
          const readyState = this.socket?.readyState;
          const readyStateStr = readyState === 0 ? 'CONNECTING' : readyState === 1 ? 'OPEN' : readyState === 2 ? 'CLOSING' : readyState === 3 ? 'CLOSED' : 'UNKNOWN';

          console.error("[TTyD] WebSocket ERROR FIRED (BEFORE onopen check)", {
            timestamp: new Date().toISOString(),
            readyState,
            readyStateStr,
            eventType: event.type,
          });

          // Try to get error details from various properties
          const errorDetails: any = {
            type: event.type,
            currentTarget: event.currentTarget?.constructor.name,
            isTrusted: event.isTrusted,
            eventKeys: Object.keys(event).filter(k => !k.startsWith('_')),
          };

          // Check for error/message properties (even though they typically don't exist on WebSocket error events)
          if ((event as any).error) errorDetails.error = String((event as any).error);
          if ((event as any).message) errorDetails.message = String((event as any).message);
          if ((event as any).reason) errorDetails.reason = String((event as any).reason);
          if ((event as any).code) errorDetails.code = (event as any).code;

          console.error("[TTyD] Error event details:", errorDetails);

          // Also log the socket state in detail
          if (this.socket) {
            console.error("[TTyD] Socket state at error time:", {
              readyState: this.socket.readyState,
              url: this.socket.url,
              binaryType: this.socket.binaryType,
              bufferedAmount: this.socket.bufferedAmount,
            });
          }

          reject(new Error("WebSocket connection failed"));
        };
      } catch (err) {
        console.error("[TTyD] Connection error", err);
        reject(err);
      }
    });
  }

  /**
   * Disconnect from the WebSocket
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.close(1000, "Normal closure");
      this.socket = null;
    }
  }

  /**
   * Send keyboard input to the PTY
   */
  sendInput(data: string | Uint8Array): void {
    if (!this.isConnected()) {
      console.warn("[TTyD] Cannot send input - not connected", { connected: this.isConnected(), socketState: this.socket?.readyState });
      return;
    }

    let payload: Uint8Array;

    if (typeof data === "string") {
      // Pre-allocate buffer for UTF-8 encoding (worst case: 3 bytes per char)
      const buffer = new Uint8Array(data.length * 3 + 1);
      buffer[0] = CMD_INPUT;

      // Encode string to UTF-8 and get actual length
      const stats = this.textEncoder.encodeInto(data, buffer.subarray(1));
      const actualLength = (stats.written as number) + 1;

      payload = buffer.subarray(0, actualLength);
    } else {
      // Binary input
      payload = new Uint8Array(data.length + 1);
      payload[0] = CMD_INPUT;
      payload.set(data, 1);
    }

    console.debug("[TTyD] Sending input", { length: payload.length, data: data.toString().slice(0, 50) });
    this.socket?.send(payload);
  }

  /**
   * Send resize request to the PTY
   */
  sendResize(cols: number, rows: number): void {
    if (!this.isConnected()) return;

    const resizeData = { columns: Math.max(1, cols), rows: Math.max(1, rows) };
    const json = JSON.stringify(resizeData);
    const jsonBytes = this.textEncoder.encode(json);

    const payload = new Uint8Array(1 + jsonBytes.length);
    payload[0] = CMD_RESIZE;
    payload.set(jsonBytes, 1);

    this.socket?.send(payload);
  }

  /**
   * Request pause (backpressure: client is behind)
   * The server should slow down sending data
   */
  private sendPause(): void {
    if (!this.isConnected() || this.paused) return;

    this.paused = true;
    const payload = new Uint8Array([CMD_PAUSE]);
    this.socket?.send(payload);
  }

  /**
   * Request resume (client ready for more data)
   */
  private sendResume(): void {
    if (!this.isConnected() || !this.paused) return;

    this.paused = false;
    const payload = new Uint8Array([CMD_RESUME]);
    this.socket?.send(payload);
  }

  /**
   * Set callback for when server sends output
   */
  setOnData(callback: (data: string | Uint8Array) => void): void {
    this.onData = callback;
  }

  /**
   * Set callback for when server sets window title
   */
  setOnTitle(callback: (title: string) => void): void {
    this.onTitle = callback;
  }

  /**
   * Set callback for when server sends preferences
   */
  setOnPreferences(callback: (prefs: unknown) => void): void {
    this.onPreferences = callback;
  }

  /**
   * Set callback for when connection is established
   */
  setOnConnected(callback: () => void): void {
    this.onConnected = callback;
  }

  /**
   * Set callback for when connection is closed
   */
  setOnDisconnected(callback: (code: number, reason: string) => void): void {
    this.onDisconnected = callback;
  }

  /**
   * Set callback for errors
   */
  setOnError(callback: (error: string) => void): void {
    this.onError = callback;
  }

  /**
   * Check if WebSocket is connected and open
   */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Handle incoming WebSocket message (binary frame)
   */
  private handleMessage(arrayBuffer: ArrayBuffer): void {
    const view = new Uint8Array(arrayBuffer);
    if (view.length === 0) return;

    const cmd = view[0];
    const payload = view.subarray(1);

    switch (cmd) {
      case CMD_OUTPUT:
        this.handleOutput(payload);
        break;
      case CMD_RESIZE:
        this.handleWindowTitle(payload);
        break;
      case CMD_PREFS:
        this.handlePreferences(payload);
        break;
      default:
        // Unknown command, ignore
        break;
    }
  }

  /**
   * Handle OUTPUT message from server (terminal data)
   */
  private handleOutput(data: Uint8Array): void {
    this.bytesWritten += data.length;
    this.pendingWrites++;

    // Invoke callback with the terminal data
    try {
      // Try to decode as UTF-8 string first
      const str = this.textDecoder.decode(data, { stream: true });
      this.onData?.(str);
    } catch {
      // Fall back to raw bytes if not valid UTF-8
      this.onData?.(data);
    }

    // Check flow control
    if (this.bytesWritten > this.flowControl.writeThreshold) {
      if (this.pendingWrites > this.flowControl.highWater && !this.paused) {
        this.sendPause();
      } else if (
        this.pendingWrites <= this.flowControl.lowWater &&
        this.paused
      ) {
        this.sendResume();
      }

      this.bytesWritten = 0;
    }
  }

  /**
   * Handle window title message from server
   */
  private handleWindowTitle(data: Uint8Array): void {
    try {
      const title = this.textDecoder.decode(data);
      this.onTitle?.(title);
    } catch {
      // Ignore decode errors
    }
  }

  /**
   * Handle preferences message from server
   */
  private handlePreferences(data: Uint8Array): void {
    try {
      const json = this.textDecoder.decode(data);
      const prefs = JSON.parse(json);
      this.onPreferences?.(prefs);
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Handle WebSocket disconnect
   */
  private handleDisconnect(code: number, reason: string): void {
    this.socket = null;
    this.onDisconnected?.(code, reason);

    // Auto-reconnect on abnormal closure
    if (
      code !== 1000 &&
      this.reconnectAttempts < this.maxReconnectAttempts &&
      !this.pendingReconnect
    ) {
      this.pendingReconnect = true;
      this.reconnectAttempts++;

      const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
      setTimeout(() => {
        this.pendingReconnect = false;
        // Reconnect would be handled by the consuming code
      }, delayMs);
    }
  }

  /**
   * Track xterm.js write completion for flow control
   */
  markWriteComplete(): void {
    if (this.pendingWrites > 0) {
      this.pendingWrites--;

      if (this.pendingWrites <= this.flowControl.lowWater && this.paused) {
        this.sendResume();
      }
    }
  }
}
