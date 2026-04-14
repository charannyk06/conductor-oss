import assert from "node:assert/strict";
import test from "node:test";
import { parseCreatePreviewSessionRequest } from "./types.js";

test("parseCreatePreviewSessionRequest preserves a trimmed clientSessionId", () => {
  const parsed = parseCreatePreviewSessionRequest({
    clientSessionId: "  bridge:session-123  ",
    bridgePreview: null,
  });

  assert.deepEqual(parsed, {
    clientSessionId: "bridge:session-123",
    bridgePreview: null,
  });
});

test("parseCreatePreviewSessionRequest rejects non-string clientSessionId values", () => {
  const parsed = parseCreatePreviewSessionRequest({
    clientSessionId: 42,
    bridgePreview: null,
  });

  assert.equal(parsed, null);
});
