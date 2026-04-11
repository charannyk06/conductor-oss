const MAX_TTYD_HTML_RESPONSE_BYTES = 512 * 1024;
const TTYD_HTML_TOO_LARGE_ERROR = "ttyd frontend response is too large";

export async function readTtydHtmlResponse(proxied: Response): Promise<string | null> {
  const contentType = proxied.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/html")) {
    return null;
  }

  const contentLength = Number.parseInt(proxied.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_TTYD_HTML_RESPONSE_BYTES) {
    throw new Error(TTYD_HTML_TOO_LARGE_ERROR);
  }

  try {
    const reader = proxied.body?.getReader();
    if (!reader) {
      return null;
    }

    const decoder = new TextDecoder();
    let totalBytes = 0;
    let html = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TTYD_HTML_RESPONSE_BYTES) {
        throw new Error(TTYD_HTML_TOO_LARGE_ERROR);
      }
      html += decoder.decode(value, { stream: true });
    }

    html += decoder.decode();
    return html;
  } catch (error) {
    if (error instanceof Error && error.message === TTYD_HTML_TOO_LARGE_ERROR) {
      throw error;
    }
    return null;
  }
}
