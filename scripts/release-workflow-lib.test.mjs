import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertArtifactIntegrity,
  assertBundledDependencyVersions,
  calculateFileIntegrity,
  detectReleaseBump,
  highestStableRegistryVersion,
  isNpmNotFound,
  npmCliInvocation,
  parseNpmDistMetadata,
  registryDownloadHeaders,
  resolveExistingArtifact,
  tarArchiveInvocation,
} from "./release-workflow-lib.mjs";

test("npm CLI invocation bypasses Windows command shims without a shell", () => {
  const nodeExecutable = "C:\\hostedtoolcache\\windows\\node\\22.23.1\\x64\\node.exe";
  const npmCli = "C:\\hostedtoolcache\\windows\\node\\22.23.1\\x64\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(
    npmCliInvocation({
      platform: "win32",
      nodeExecutable,
      npmExecPath: undefined,
      pathExists: (candidate) => candidate === npmCli,
    }),
    { command: nodeExecutable, argsPrefix: [npmCli] },
  );
  assert.deepEqual(npmCliInvocation({ platform: "linux" }), {
    command: "npm",
    argsPrefix: [],
  });
  assert.throws(
    () => npmCliInvocation({
      platform: "win32",
      nodeExecutable,
      npmExecPath: "C:\\Program Files\\nodejs\\npm.cmd",
      pathExists: () => false,
    }),
    /unable to locate npm-cli\.js/,
  );
});

test("tar commands localize Windows drive-letter archives for GNU tar and bsdtar", () => {
  assert.deepEqual(
    tarArchiveInvocation(
      "D:\\a\\conductor-oss\\package.tgz",
      ["-xOf"],
      ["package/package.json"],
      "win32",
    ),
    {
      args: ["-xOf", "package.tgz", "package/package.json"],
      cwd: "D:\\a\\conductor-oss",
    },
  );
  assert.deepEqual(
    tarArchiveInvocation("/tmp/conductor/package.tgz", ["-xzf"], ["-C", "/tmp/out"], "darwin"),
    {
      args: ["-xzf", "package.tgz", "-C", "/tmp/out"],
      cwd: "/tmp/conductor",
    },
  );
});

test("bundled package identities match the parent release version", () => {
  const packageManifest = {
    name: "conductor-oss",
    version: "1.2.3",
    dependencies: { "@conductor-oss/core": "1.2.3" },
    bundleDependencies: ["@conductor-oss/core"],
  };
  const bundledManifests = {
    "@conductor-oss/core": { name: "@conductor-oss/core", version: "1.2.3" },
  };

  assert.deepEqual(
    assertBundledDependencyVersions(packageManifest, bundledManifests),
    ["@conductor-oss/core"],
  );
  assert.throws(
    () => assertBundledDependencyVersions(
      packageManifest,
      { "@conductor-oss/core": { name: "@conductor-oss/core", version: "0.2.7" } },
    ),
    /has version 0\.2\.7; expected 1\.2\.3/,
  );
  assert.throws(
    () => assertBundledDependencyVersions(
      { ...packageManifest, dependencies: { "@conductor-oss/core": "workspace:\*" } },
      bundledManifests,
    ),
    /must be declared at 1\.2\.3/,
  );
  assert.throws(
    () => assertBundledDependencyVersions(packageManifest, {}),
    /is missing from the installed package/,
  );
});

test("highestStableRegistryVersion is strict and compares numeric semver parts", () => {
  assert.equal(highestStableRegistryVersion('["0.9.9","0.10.0","1.0.0-beta.1"]'), "0.10.0");
  assert.throws(() => highestStableRegistryVersion("not-json"), /invalid version JSON/);
  assert.throws(() => highestStableRegistryVersion('["1.0.0-beta.1"]'), /no stable/);
});

test("detectReleaseBump sees breaking footers in full commit bodies", () => {
  assert.equal(detectReleaseBump(["fix: ordinary fix\n\nBREAKING CHANGE: removes legacy mode"]), "major");
  assert.equal(detectReleaseBump(["feat(api)!: replace response"]), "major");
  assert.equal(detectReleaseBump(["fix: patch", "feat(web): add panel"]), "minor");
  assert.equal(detectReleaseBump(["fix: patch"]), "patch");
  assert.equal(detectReleaseBump("fix: patch\n\0\nfeat(web): add panel\n\0"), "minor");
});

test("artifact integrity comparison is byte exact", () => {
  const directory = mkdtempSync(join(tmpdir(), "conductor-release-integrity-"));
  try {
    const artifact = join(directory, "artifact.tgz");
    writeFileSync(artifact, "first artifact");
    const integrity = calculateFileIntegrity(artifact);
    assert.equal(assertArtifactIntegrity(artifact, integrity), integrity);
    assert.equal(resolveExistingArtifact(artifact, integrity, "canonicalize"), "verified");
    assert.throws(
      () => resolveExistingArtifact(artifact, integrity, "reject"),
      /refusing an existing package version/,
    );
    writeFileSync(artifact, "different artifact");
    assert.throws(() => assertArtifactIntegrity(artifact, integrity), /integrity mismatch/);
    assert.equal(resolveExistingArtifact(artifact, integrity, "canonicalize"), "canonicalize");
    assert.throws(
      () => resolveExistingArtifact(artifact, integrity, "verify"),
      /integrity mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("npm registry parsing fails closed", () => {
  assert.equal(isNpmNotFound("npm error code E404"), true);
  assert.equal(isNpmNotFound("npm error code E500"), false);
  assert.deepEqual(
    parseNpmDistMetadata(JSON.stringify({
      integrity: `sha512-${"a".repeat(64)}`,
      tarball: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    })),
    {
      integrity: `sha512-${"a".repeat(64)}`,
      tarball: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    },
  );
  assert.throws(
    () => parseNpmDistMetadata('{"integrity":"sha512-value"}'),
    /must contain integrity and tarball/,
  );
  assert.deepEqual(
    registryDownloadHeaders(
      "https://npm.pkg.github.com/download/package.tgz",
      "https://npm.pkg.github.com",
      "secret-token",
    ),
    { authorization: "Bearer secret-token" },
  );
  assert.deepEqual(
    registryDownloadHeaders(
      "https://attacker.example/package.tgz",
      "https://npm.pkg.github.com",
      "secret-token",
    ),
    {},
  );
});
