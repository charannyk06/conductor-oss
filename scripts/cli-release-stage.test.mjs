import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packCliReleasePackage } from "./cli-release-stage.mjs";
import {
  assertBundledDependencyVersionsInTarball,
  assertCliReleaseTarballEquivalence,
} from "./release-workflow-lib.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("release staging gives bundled private packages the parent release identity", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "conductor-cli-stage-fixture-"));
  const stageDir = join(rootDir, "stage");
  const packDir = join(rootDir, "artifacts");

  try {
    const cliDir = join(rootDir, "packages", "cli");
    const coreDir = join(rootDir, "packages", "core");
    const webDir = join(rootDir, "packages", "web");
    mkdirSync(join(cliDir, "dist"), { recursive: true });
    mkdirSync(join(coreDir, "dist"), { recursive: true });
    mkdirSync(join(webDir, ".next", "standalone"), { recursive: true });
    mkdirSync(join(webDir, ".next", "static"), { recursive: true });

    writeJson(join(cliDir, "package.json"), {
      name: "conductor-oss",
      version: "9.8.7",
      type: "module",
      main: "dist/launcher.js",
      bin: { conductor: "dist/launcher.js" },
      dependencies: { "@conductor-oss/core": "workspace:*" },
    });
    writeFileSync(join(cliDir, "dist", "launcher.js"), "#!/usr/bin/env node\n", "utf8");
    writeJson(join(coreDir, "package.json"), {
      name: "@conductor-oss/core",
      version: "0.2.7",
      private: true,
      type: "module",
      main: "dist/index.js",
    });
    writeFileSync(join(coreDir, "dist", "index.js"), "export {};\n", "utf8");
    writeJson(join(webDir, "package.json"), {
      name: "@conductor-oss/web",
      version: "0.2.7",
      private: true,
      dependencies: {},
    });

    const { tarballPath } = packCliReleasePackage({
      rootDir,
      stageDir,
      packDestination: packDir,
    });

    const parentManifest = JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8"));
    const bundledManifest = JSON.parse(readFileSync(
      join(stageDir, "node_modules", "@conductor-oss", "core", "package.json"),
      "utf8",
    ));
    assert.equal(parentManifest.dependencies["@conductor-oss/core"], "9.8.7");
    assert.deepEqual(parentManifest.bundleDependencies, ["@conductor-oss/core"]);
    assert.equal(bundledManifest.name, "@conductor-oss/core");
    assert.equal(bundledManifest.version, "9.8.7");
    assert.equal(
      assertBundledDependencyVersionsInTarball(tarballPath, {
        requiredDependencies: ["@conductor-oss/core"],
      }).version,
      "9.8.7",
    );
    execFileSync("npm", ["ls", "--all", "--omit=dev", "--omit=optional"], {
      cwd: stageDir,
      stdio: "ignore",
    });

    const githubStageDir = join(rootDir, "github-stage");
    const { tarballPath: githubTarballPath } = packCliReleasePackage({
      rootDir,
      stageDir: githubStageDir,
      packDestination: packDir,
      publishedName: "@charannyk06/conductor-oss",
      publishRegistry: "https://npm.pkg.github.com",
    });
    assert.doesNotThrow(() => assertCliReleaseTarballEquivalence({
      publicTarball: tarballPath,
      githubTarball: githubTarballPath,
      version: "9.8.7",
    }));

    const brokenEquivalenceDir = join(rootDir, "broken-equivalence");
    mkdirSync(brokenEquivalenceDir, { recursive: true });
    writeFileSync(join(githubStageDir, "dist", "launcher.js"), "broken launcher\n", "utf8");
    const brokenGithubTarballName = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", brokenEquivalenceDir],
      { cwd: githubStageDir, encoding: "utf8" },
    ).trim();
    assert.throws(
      () => assertCliReleaseTarballEquivalence({
        publicTarball: tarballPath,
        githubTarball: join(brokenEquivalenceDir, brokenGithubTarballName),
        version: "9.8.7",
      }),
      /differ at dist\/launcher\.js/,
    );

    const brokenPackDir = join(rootDir, "broken-artifacts");
    mkdirSync(brokenPackDir, { recursive: true });
    writeJson(
      join(stageDir, "node_modules", "@conductor-oss", "core", "package.json"),
      { ...bundledManifest, version: "0.2.7" },
    );
    const brokenTarballName = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", brokenPackDir],
      { cwd: stageDir, encoding: "utf8" },
    ).trim();
    assert.throws(
      () => assertBundledDependencyVersionsInTarball(join(brokenPackDir, brokenTarballName), {
        requiredDependencies: ["@conductor-oss/core"],
      }),
      /has version 0\.2\.7; expected 9\.8\.7/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
