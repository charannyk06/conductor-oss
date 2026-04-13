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

test("terminal UI copy stays product-facing and does not expose ttyd wording", () => {
  const source = readFileSync(new URL("./SessionTerminal.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label="Reload terminal"/);
  assert.match(source, /Loading terminal…/);
  assert.match(source, /title=\{`terminal for \$\{sessionId\}`\}/);
  assert.match(source, /Open the terminal directly/);
  assert.doesNotMatch(source, /Reload ttyd terminal/);
  assert.doesNotMatch(source, /Loading ttyd terminal/);
  assert.doesNotMatch(source, /Open the ttyd terminal directly/);
});
