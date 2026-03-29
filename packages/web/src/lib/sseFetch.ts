/**
 * Incremental SSE parser over a fetch() body stream — avoids EventSource buffering
 * quirks with some proxies and gives explicit abort control for fast reconnects.
 */

export type SseFrame = {
  /** Named SSE event, or null for the default event */
  event: string | null;
  data: string;
};

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
  const frameSep = /\r\n\r\n|\n\n/;

  try {
    for (;;) {
      if (signal?.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = frameSep.exec(buffer))) {
        const rawFrame = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        frameSep.lastIndex = 0;

        let event: string | null = null;
        const dataLines: string[] = [];
        for (const line of rawFrame.split(/\r?\n/)) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trimStart();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
