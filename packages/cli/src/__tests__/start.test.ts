import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inferNpmGlobalPrefixFromPackageRoot,
  isLoopbackHost,
  quoteWindowsCliArg,
  resolveDashboardPackageManager,
  resolveLocalDashboardAuthEnv,
  resolveRustBackendLaunch,
} from "../commands/start.js";

test("isLoopbackHost recognizes local-only bind hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("resolveLocalDashboardAuthEnv enables loopback packaged dashboards unless overridden", () => {
  assert.deepEqual(resolveLocalDashboardAuthEnv("127.0.0.1", {}), {
    CONDUCTOR_ALLOW_LOCAL_UNAUTHENTICATED: "true",
  });
  assert.deepEqual(resolveLocalDashboardAuthEnv("localhost", {}), {
    CONDUCTOR_ALLOW_LOCAL_UNAUTHENTICATED: "true",
  });
  assert.deepEqual(resolveLocalDashboardAuthEnv("0.0.0.0", {}), {});
  assert.deepEqual(resolveLocalDashboardAuthEnv("127.0.0.1", {
    CONDUCTOR_ALLOW_LOCAL_UNAUTHENTICATED: "false",
  }), {});
});

test("inferNpmGlobalPrefixFromPackageRoot derives npm prefixes from package roots", () => {
  assert.equal(
    inferNpmGlobalPrefixFromPackageRoot("/Users/test/.conductor/npm/lib/node_modules/conductor-oss"),
    "/Users/test/.conductor/npm",
  );
  assert.equal(
    inferNpmGlobalPrefixFromPackageRoot("/Users/test/project/node_modules/conductor-oss"),
    null,
  );
  assert.equal(
    inferNpmGlobalPrefixFromPackageRoot(
      "/Users/test/.conductor/npm/lib/node_modules/conductor-oss/node_modules/conductor-oss-native-darwin-universal",
    ),
    null,
  );
  assert.equal(
    inferNpmGlobalPrefixFromPackageRoot("/Users/test/conductor-oss/packages/cli"),
    null,
  );
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

test("resolveDashboardPackageManager honors the workspace packageManager field", () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-dashboard-pm-"));

  try {
    mkdirSync(join(root, "packages", "web"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.2.0" }),
    );

    assert.equal(resolveDashboardPackageManager(join(root, "packages", "web")), "bun");

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );

    assert.equal(resolveDashboardPackageManager(join(root, "packages", "web")), "pnpm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
