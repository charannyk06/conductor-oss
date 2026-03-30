/**
 * Incremental SSE parser over a fetch() body stream — avoids EventSource buffering
 * quirks with some proxies and gives explicit abort control for fast reconnects.
 */

export type SseFrame = {
  /** Named SSE event, or null for the default event */
  event: string | null;
  data: string;
};

const FRAME_SEPARATOR = /\r?\n\r?\n/;

function parseSseValue(rawValue: string): string {
  return rawValue.trimStart();
}

function parseRawSseFrame(rawFrame: string): SseFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = parseSseValue(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(parseSseValue(line.slice(5)));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join("\n") };
}

/**
 * Yield each complete SSE frame (`event` + concatenated `data` lines).
 */
export async function* iterateSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode(undefined, { stream: false });
        if (tail.length > 0) {
          buffer += tail;
        }
      } else if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      for (;;) {
        const match = buffer.match(FRAME_SEPARATOR);
        if (!match || typeof match.index !== "number") {
          break;
        }
        const rawFrame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseRawSseFrame(rawFrame);
        if (!frame) {
          continue;
        }
        yield frame;
      }

      if (done) {
        const finalFrame = parseRawSseFrame(buffer);
        if (finalFrame) {
          yield finalFrame;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
