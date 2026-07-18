export const TTYD_SERVER_COMMAND = Object.freeze({
  output: "0".charCodeAt(0),
  setWindowTitle: "1".charCodeAt(0),
  setPreferences: "2".charCodeAt(0),
});

export const TTYD_CLIENT_COMMAND = Object.freeze({
  input: "0".charCodeAt(0),
  resize: "1".charCodeAt(0),
  pause: "2".charCodeAt(0),
  resume: "3".charCodeAt(0),
});

export function encodeTtydHandshakeFrame(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ columns: cols, rows }));
}

export function encodeTtydResizeFrame(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify({ columns: cols, rows }));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = TTYD_CLIENT_COMMAND.resize;
  frame.set(payload, 1);
  return frame;
}

export function encodeTtydInputFrame(data: string): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = TTYD_CLIENT_COMMAND.input;
  frame.set(payload, 1);
  return frame;
}
