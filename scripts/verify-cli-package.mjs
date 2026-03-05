import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import cliPackageJson from "../packages/cli/package.json" with { type: "json" };

function fail(message) {
  console.error(`release preflight failed: ${message}`);
  process.exit(1);
}

const packDir = mkdtempSync(join(tmpdir(), "conductor-cli-pack-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: join(process.cwd(), "packages", "cli"),
    stdio: "ignore",
  });

  const tarballPath = join(packDir, `conductor-oss-${cliPackageJson.version}.tgz`);
  const packageJsonRaw = execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
    encoding: "utf8",
  });
  const packageJson = JSON.parse(packageJsonRaw);
  const runtimeDeps = Object.keys(packageJson.dependencies ?? {});
  const internalDeps = runtimeDeps.filter((name) => name.startsWith("@conductor-oss/"));

  if (internalDeps.length > 0) {
    fail(`public CLI tarball still depends on internal workspace packages: ${internalDeps.join(", ")}`);
  }

  const tarContents = execFileSync("tar", ["-tf", tarballPath], {
    encoding: "utf8",
  }).split("\n");

  if (!tarContents.includes("package/web/package.json")) {
    fail("public CLI tarball does not include a bundled dashboard at package/web/");
  }

  console.log("release preflight passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
