import assert from "node:assert/strict";
import test from "node:test";
import { parseTerminalFileLinks } from "./filePathLinkProvider";

test("parseTerminalFileLinks detects relative file paths with line and column", () => {
  const links = parseTerminalFileLinks("Error at crates/conductor-server/src/routes/terminal.rs:628:7");

  assert.deepEqual(links, [
    {
      path: "crates/conductor-server/src/routes/terminal.rs",
      line: 628,
      column: 7,
      startIndex: 9,
      endIndex: 61,
    },
  ]);
});

test("parseTerminalFileLinks strips diff prefixes and trailing punctuation", () => {
  const links = parseTerminalFileLinks("Updated +++ b/packages/web/src/components/sessions/SessionTerminal.tsx:643.");

  assert.deepEqual(links, [
    {
      path: "packages/web/src/components/sessions/SessionTerminal.tsx",
      line: 643,
      column: undefined,
      startIndex: 12,
      endIndex: 74,
    },
  ]);
});

test("parseTerminalFileLinks skips urls and bare filenames without location", () => {
  const links = parseTerminalFileLinks(
    "Docs: https://example.com and README.md but keep src/main.rs:12",
  );

  assert.deepEqual(links, [
    {
      path: "src/main.rs",
      line: 12,
      column: undefined,
      startIndex: 49,
      endIndex: 63,
    },
  ]);
});
