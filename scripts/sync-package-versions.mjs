import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const PACKAGES_ROOT = join(ROOT, "packages");

function collectPackageDirs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const dirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;

    const fullPath = join(dir, entry.name);
    if (existsSync(join(fullPath, "package.json"))) {
      dirs.push(fullPath);
      continue;
    }

    dirs.push(...collectPackageDirs(fullPath));
  }

  return dirs;
}

const packageDirs = collectPackageDirs(PACKAGES_ROOT);
const updated = [];

for (const packageDir of packageDirs) {
  const packageJsonPath = join(packageDir, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || version.trim().length === 0) continue;

  const sourcePath = join(packageDir, "src", "index.ts");
  if (!existsSync(sourcePath)) continue;

  const original = readFileSync(sourcePath, "utf8");
  let next = original;

  next = next.replace(/version:\s*"[^"]+"/g, `version: "${version}"`);
  next = next.replace(/\.version\("[^"]+"\)/g, `.version("${version}")`);

  if (next !== original) {
    writeFileSync(sourcePath, next, "utf8");
    updated.push(sourcePath.replace(`${ROOT}/`, ""));
  }
}

if (updated.length > 0) {
  console.log(`Synced versions in ${updated.length} source files:`);
  for (const file of updated) {
    console.log(`- ${file}`);
  }
} else {
  console.log("Package source versions already in sync.");
}
