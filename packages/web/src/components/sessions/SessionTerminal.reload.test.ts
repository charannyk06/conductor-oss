import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("terminal reload button remounts the iframe even when the terminal URL stays the same", () => {
  const source = readFileSync(new URL("./SessionTerminal.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[iframeReloadNonce, setIframeReloadNonce\] = useState\(0\);/);
  assert.match(source, /const handleRetry = useCallback\(\(\) => \{/);
  assert.match(source, /forceTerminalReloadRef\.current = true;/);
  assert.match(source, /frameLoadedRef\.current = false;/);
  assert.match(source, /setFrameLoaded\(false\);/);
  assert.match(source, /setIframeReloadNonce\(\(current\) => current \+ 1\);/);
  assert.match(source, /key=\{`\$\{sessionId\}:\$\{iframeReloadNonce\}`\}/);
});
