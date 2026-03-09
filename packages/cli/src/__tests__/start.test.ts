import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLoopbackHost, quoteWindowsCliArg, resolveRustBackendLaunch } from "../commands/start.js";

test("isLoopbackHost recognizes local-only bind hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("resolveRustBackendLaunch prefers the newest repo-local Rust binary over bundled fallbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-start-test-"));

  try {
    mkdirSync(join(root, "crates", "conductor-cli"), { recursive: true });
    mkdirSync(join(root, "target", "debug"), { recursive: true });
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    writeFileSync(
      join(root, "crates", "conductor-cli", "Cargo.toml"),
      "[package]\nname='conductor-cli'\nversion='0.0.0'\n",
    );

    const binaryName = process.platform === "win32" ? "conductor.exe" : "conductor";
    const debugBinary = join(root, "target", "debug", binaryName);
    const releaseBinary = join(root, "target", "release", binaryName);
    writeFileSync(releaseBinary, "release");
    writeFileSync(debugBinary, "debug");

    const now = new Date();
    const older = new Date(now.getTime() - 60_000);
    utimesSync(releaseBinary, older, older);
    utimesSync(debugBinary, now, now);

    const resolution = resolveRustBackendLaunch(root, join(root, "conductor.yaml"), 4749);

    assert.equal(resolution.launch?.label, "prebuilt Rust backend");
    assert.equal(resolution.launch?.cmd, debugBinary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quoteWindowsCliArg escapes quotes and trailing backslashes", () => {
  assert.equal(quoteWindowsCliArg("C:\\Program Files\\Conductor"), "\"C:\\Program Files\\Conductor\"");
  assert.equal(quoteWindowsCliArg("C:\\path with spaces\\"), "\"C:\\path with spaces\\\\\"");
  assert.equal(quoteWindowsCliArg("say \"hello\""), "\"say \\\"hello\\\"\"");
});
