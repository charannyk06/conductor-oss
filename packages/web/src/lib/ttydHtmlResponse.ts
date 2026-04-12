// Keep in sync with crates/conductor-server/src/routes/terminal.rs.
const MAX_TTYD_HTML_RESPONSE_BYTES = 8 * 1024 * 1024;
const TTYD_HTML_TOO_LARGE_ERROR = "ttyd frontend response is too large";
const HTML_SNIFF_CHAR_LIMIT = 2048;

function looksLikeHtmlDocument(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || trimmed.startsWith("<head") || trimmed.startsWith("<body");
}

export async function readTtydHtmlResponse(proxied: Response): Promise<string | null> {
  const candidate = proxied.clone();
  const contentType = candidate.headers.get("content-type")?.toLowerCase() ?? "";
  const declaredHtml = contentType.startsWith("text/html");

  const contentLength = Number.parseInt(candidate.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_TTYD_HTML_RESPONSE_BYTES) {
    throw new Error(TTYD_HTML_TOO_LARGE_ERROR);
  }

  try {
    const reader = candidate.body?.getReader();
    if (!reader) {
      return null;
    }

    const decoder = new TextDecoder();
    let totalBytes = 0;
    let html = "";
    let sniffedHtml = declaredHtml;

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

      if (!sniffedHtml && html.length >= HTML_SNIFF_CHAR_LIMIT) {
        sniffedHtml = looksLikeHtmlDocument(html);
        if (!sniffedHtml) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
      }
    }

    html += decoder.decode();
    if (!sniffedHtml && !looksLikeHtmlDocument(html)) {
      return null;
    }
    return html;
  } catch (error) {
    if (error instanceof Error && error.message === TTYD_HTML_TOO_LARGE_ERROR) {
      throw error;
    }
    return null;
  }
}
