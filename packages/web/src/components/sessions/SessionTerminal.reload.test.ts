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

test("embedded terminal keeps a desktop bottom gutter so the input row is not clipped", () => {
  const source = readFileSync(new URL("./IframeTerminalPage.tsx", import.meta.url), "utf8");

  assert.match(source, /const IFRAME_TERMINAL_HOST_CLASSNAME =/);
  assert.match(source, /box-border h-full w-full/);
  assert.match(source, /pt-2 pb-\[calc\(0\.5rem\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /py-2 text-left touch-pan-y pb-\[env\(safe-area-inset-bottom\)\]/);
});

test("embedded terminal schedules a geometry burst so desktop panes do not stay at 80x24", () => {
  const source = readFileSync(new URL("./IframeTerminalPage.tsx", import.meta.url), "utf8");

  assert.match(source, /let scheduleGeometryBurst: \(\(\) => void\) \| null = null;/);
  assert.match(source, /scheduleGeometryBurst = \(\) => \{/);
  assert.match(source, /try \{\n\s*fitAddon\.fit\(\);\n\s*\} catch \{/);
  assert.match(source, /for \(const delay of \[60, 180, 360, 720, 1200, 2400, 4000\]\)/);
  assert.match(source, /window\.addEventListener\("resize", scheduleGeometryBurst\)/);
  assert.match(source, /const scheduleSyntheticResizeBurst = \(\) => \{/);
  assert.match(source, /window\.dispatchEvent\(new Event\("resize"\)\);/);
  assert.match(source, /scheduleSyntheticResizeBurst\(\);\n\s*void document\.fonts\?\.ready/);
  assert.match(source, /clearGeometryBurst\?\.\(\);\n\s*clearReconnectTimer\(\);/);
});

test("embedded terminal route avoids server-importing browser-only xterm values", () => {
  const pageSource = readFileSync(new URL("../../app/embed/terminal/[id]/page.tsx", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("./IframeTerminalPage.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /IframeTerminalPage/);
  assert.match(terminalSource, /import type \{ FitAddon \} from "@xterm\/addon-fit";/);
  assert.match(terminalSource, /import type \{ Terminal \} from "xterm";/);
  assert.doesNotMatch(terminalSource, /import \{ FitAddon \} from "@xterm\/addon-fit";/);
  assert.doesNotMatch(terminalSource, /import \{ Terminal \} from "xterm";/);
  assert.match(terminalSource, /import\("xterm"\)/);
  assert.match(terminalSource, /import\("@xterm\/addon-fit"\)/);
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
