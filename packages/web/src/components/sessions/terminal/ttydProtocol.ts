/**
 * ttyd binary WebSocket protocol helpers for the client side.
 *
 * Encodes client -> server messages in the ttyd binary format.
 */
import {
  TTYD_CLIENT_INPUT,
  TTYD_CLIENT_RESIZE,
} from "./terminalConstants";

const textEncoder = new TextEncoder();

/** Encode a ttyd INPUT message: [0x30] [raw bytes]. */
export function encodeTtydInput(data: string): Uint8Array {
  const encoded = textEncoder.encode(data);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = TTYD_CLIENT_INPUT;
  frame.set(encoded, 1);
  return frame;
}

/** Encode a ttyd RESIZE message: [0x31] [JSON {"columns":N,"rows":N}]. */
export function encodeTtydResize(columns: number, rows: number): Uint8Array {
  const json = textEncoder.encode(JSON.stringify({ columns, rows }));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = TTYD_CLIENT_RESIZE;
  frame.set(json, 1);
  return frame;
}
