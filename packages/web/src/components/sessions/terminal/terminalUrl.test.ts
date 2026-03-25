import assert from "node:assert/strict";
import test from "node:test";
import { terminalUrlNeedsReload } from "./terminalUrl";

test("terminalUrlNeedsReload ignores token-only changes", () => {
  assert.equal(
    terminalUrlNeedsReload(
      "https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token=old",
      "https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token=new",
    ),
    false,
  );
});

test("terminalUrlNeedsReload reloads when the terminal identity changes", () => {
  assert.equal(
    terminalUrlNeedsReload(
      "https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token=old",
      "https://dashboard.example.com/api/sessions/session-2/terminal/ttyd?token=new",
    ),
    true,
  );
});

test("terminalUrlNeedsReload reloads when no current url exists", () => {
  assert.equal(
    terminalUrlNeedsReload(null, "https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token=new"),
    true,
  );
});
