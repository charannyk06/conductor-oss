// Keep in sync with crates/conductor-server/src/routes/terminal.rs.
const MAX_TTYD_HTML_RESPONSE_BYTES = 8 * 1024 * 1024;
const TTYD_HTML_TOO_LARGE_ERROR = "ttyd frontend response is too large";
const HTML_SNIFF_CHAR_LIMIT = 2048;
const BRIDGE_PROXY_META_KEY = "$bridgeProxy";

function looksLikeHtmlDocument(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html")
    || trimmed.startsWith("<html")
    || trimmed.startsWith("<head")
    || trimmed.startsWith("<body");
}

function unwrapBridgeProxyHtmlPayload(payloadText: string): string | null {
  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (typeof parsed === "string") {
      return looksLikeHtmlDocument(parsed) ? parsed : null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const proxyMeta = (parsed as Record<string, unknown>)[BRIDGE_PROXY_META_KEY];
    if (!proxyMeta || typeof proxyMeta !== "object") {
      return null;
    }

    const kind = typeof (proxyMeta as Record<string, unknown>).kind === "string"
      ? ((proxyMeta as Record<string, unknown>).kind as string).trim().toLowerCase()
      : "";
    const contentType = typeof (proxyMeta as Record<string, unknown>).contentType === "string"
      ? ((proxyMeta as Record<string, unknown>).contentType as string).trim().toLowerCase()
      : "";

    if (kind === "text") {
      const text = typeof (proxyMeta as Record<string, unknown>).text === "string"
        ? (proxyMeta as Record<string, unknown>).text as string
        : null;
      if (!text) {
        return null;
      }
      return contentType.startsWith("text/html") || looksLikeHtmlDocument(text)
        ? text
        : null;
    }

    if (kind === "bytes") {
      const base64 = typeof (proxyMeta as Record<string, unknown>).base64 === "string"
        ? (proxyMeta as Record<string, unknown>).base64 as string
        : null;
      if (!base64 || !(contentType.startsWith("text/html") || contentType.includes("html"))) {
        return null;
      }
      const decoded = Buffer.from(base64, "base64").toString("utf8");
      return looksLikeHtmlDocument(decoded) ? decoded : null;
    }

    return null;
  } catch {
    return null;
  }
}

export async function readTtydHtmlResponse(proxied: Response): Promise<string | null> {
  const candidate = proxied.clone();
  const contentType = candidate.headers.get("content-type")?.toLowerCase() ?? "";
  const declaredHtml = contentType.startsWith("text/html");
  const declaredJson = contentType.includes("application/json");

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
    let sniffBuffer = "";
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

      const decodedChunk = decoder.decode(value, { stream: true });
      html += decodedChunk;

      if (!sniffedHtml && sniffBuffer.length < HTML_SNIFF_CHAR_LIMIT) {
        sniffBuffer = `${sniffBuffer}${decodedChunk}`.slice(0, HTML_SNIFF_CHAR_LIMIT);
        sniffedHtml = looksLikeHtmlDocument(sniffBuffer);
        if (!sniffedHtml && !declaredJson && sniffBuffer.length >= HTML_SNIFF_CHAR_LIMIT) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
      }
    }

    html += decoder.decode();
    if (sniffedHtml || looksLikeHtmlDocument(html)) {
      return html;
    }

    return unwrapBridgeProxyHtmlPayload(html);
  } catch (error) {
    if (error instanceof Error && error.message === TTYD_HTML_TOO_LARGE_ERROR) {
      throw error;
    }
    return null;
  }
}
