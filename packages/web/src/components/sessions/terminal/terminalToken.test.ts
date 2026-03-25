import assert from "node:assert/strict";
import test from "node:test";
import { extractTerminalAuthToken } from "./terminalToken";

test("extractTerminalAuthToken reads token query values from ttyd urls", () => {
  assert.equal(
    extractTerminalAuthToken("https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token=test-token"),
    "test-token",
  );
});

test("extractTerminalAuthToken ignores missing or blank token values", () => {
  assert.equal(
    extractTerminalAuthToken("https://dashboard.example.com/api/sessions/session-1/terminal/ttyd"),
    null,
  );
  assert.equal(
    extractTerminalAuthToken("https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token="),
    null,
  );
});
