import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_NATIVE_TARGETS } from "./cli-native-packages.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createWorkspacePackageMap(rootDir) {
  const candidateDirs = [resolve(rootDir, "packages"), resolve(rootDir, "packages", "plugins")];
  const packageMap = new Map();

  for (const baseDir of candidateDirs) {
    if (!existsSync(baseDir)) {
      continue;
    }

    const entries = execFileSync("find", [baseDir, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);

    for (const dir of entries) {
      const packageJsonPath = join(dir, "package.json");
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      const pkg = readJson(packageJsonPath);
      packageMap.set(pkg.name, dir);
    }
  }

  return packageMap;
}

function copyOptionalFile(sourcePath, destinationPath) {
  if (existsSync(sourcePath)) {
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
}

function shouldIncludeDistEntry(sourcePath) {
  const normalized = sourcePath.replace(/\\/g, "/");
  return !(
    normalized.includes("/__tests__/") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".test.js.map") ||
    normalized.endsWith(".test.d.ts") ||
    normalized.endsWith(".test.d.ts.map")
  );
}

function copyDistDirectory(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    filter: shouldIncludeDistEntry,
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function copyDirectoryResolvingSymlinks(sourcePath, destinationPath) {
  mkdirSync(destinationPath, { recursive: true });
  execFileSync(
    "sh",
    [
      "-lc",
      `tar -chf - -C ${shellQuote(sourcePath)} . | tar -xf - -C ${shellQuote(destinationPath)}`,
    ],
    { stdio: "inherit" },
  );
}

function hydrateStandaloneNodeModules(standaloneRoot) {
  const nodeModulesDir = join(standaloneRoot, "node_modules");
  const pnpmLinksDir = join(nodeModulesDir, ".pnpm", "node_modules");

  if (!existsSync(pnpmLinksDir)) {
    return;
  }

  const hydrateFrom = (sourceDir, destinationDir) => {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name === ".bin") {
        continue;
      }

      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      const stat = lstatSync(sourcePath);

      if (stat.isSymbolicLink()) {
        rmSync(destinationPath, { recursive: true, force: true });
        copyDirectoryResolvingSymlinks(realpathSync(sourcePath), destinationPath);
        continue;
      }

      if (!stat.isDirectory()) {
        continue;
      }

      if (existsSync(join(sourcePath, "package.json"))) {
        rmSync(destinationPath, { recursive: true, force: true });
        copyDirectoryResolvingSymlinks(sourcePath, destinationPath);
        continue;
      }

      mkdirSync(destinationPath, { recursive: true });
      hydrateFrom(sourcePath, destinationPath);
    }
  };

  hydrateFrom(pnpmLinksDir, nodeModulesDir);
}

function sanitizePublishedPackage(pkg, {
  dependencies = {},
  optionalDependencies = undefined,
} = {}) {
  const sanitized = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    type: pkg.type,
    main: pkg.main,
    bin: pkg.bin,
    engines: pkg.engines,
    description: pkg.description,
    keywords: pkg.keywords,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    repository: pkg.repository,
    dependencies,
  };

  if (optionalDependencies && Object.keys(optionalDependencies).length > 0) {
    sanitized.optionalDependencies = optionalDependencies;
  }

  if (pkg.exports) {
    sanitized.exports = pkg.exports;
  }
  if (pkg.types) {
    sanitized.types = pkg.types;
  }

  return sanitized;
}

function addDependency(target, dependencyName, specifier, sourceLabel) {
  const existing = target[dependencyName];
  if (!existing) {
    target[dependencyName] = specifier;
    return;
  }

  if (existing !== specifier) {
    throw new Error(
      `Conflicting dependency specifiers for ${dependencyName}: ${existing} vs ${specifier} (${sourceLabel})`,
    );
  }
}

function ensureWebBundle(rootDir) {
  const webDir = resolve(rootDir, "packages", "web");
  const standaloneDir = resolve(webDir, ".next", "standalone");
  const staticDir = resolve(webDir, ".next", "static");
  const publicDir = resolve(webDir, "public");

  if (!existsSync(standaloneDir)) {
    throw new Error("Missing web standalone build at packages/web/.next/standalone. Run `pnpm build:release` first.");
  }

  if (!existsSync(staticDir)) {
    throw new Error("Missing web static assets at packages/web/.next/static. Run `pnpm build:release` first.");
  }

  return { standaloneDir, staticDir, publicDir };
}

function buildInternalPackageTarballs({ rootDir, cliVersion, tarballRoot, stagingRoot }) {
  const cliPackage = readJson(resolve(rootDir, "packages", "cli", "package.json"));
  const workspacePackages = createWorkspacePackageMap(rootDir);
  const internalDependencyNames = [
    ...new Set(
      Object.keys(cliPackage.dependencies ?? {}).filter((name) => name.startsWith("@conductor-oss/")),
    ),
  ];

  const tarballs = new Map();
  const externalDependencies = {};

  for (const packageName of internalDependencyNames) {
    const sourceDir = workspacePackages.get(packageName);
    if (!sourceDir) {
      throw new Error(`Unable to resolve workspace package for ${packageName}`);
    }

    const sourceManifest = readJson(join(sourceDir, "package.json"));
    const sourceDistDir = join(sourceDir, "dist");
    if (!existsSync(sourceDistDir)) {
      throw new Error(`Missing build output for ${packageName} at ${sourceDistDir}. Run \`pnpm build:release\` first.`);
    }

    const packageStageDir = join(stagingRoot, ...packageName.split("/"));
    mkdirSync(packageStageDir, { recursive: true });

    const dependencies = {};
    for (const [dependencyName, specifier] of Object.entries(sourceManifest.dependencies ?? {})) {
      if (internalDependencyNames.includes(dependencyName)) {
        dependencies[dependencyName] = cliVersion;
      } else {
        dependencies[dependencyName] = specifier;
        addDependency(externalDependencies, dependencyName, specifier, packageName);
      }
    }

    const sanitizedManifest = sanitizePublishedPackage(sourceManifest, { dependencies });
    writeJson(join(packageStageDir, "package.json"), sanitizedManifest);
    copyDistDirectory(sourceDistDir, join(packageStageDir, "dist"));

    const tarballName = execFileSync("npm", ["pack", "--silent", "--pack-destination", tarballRoot], {
      cwd: packageStageDir,
      encoding: "utf8",
    }).trim();

    tarballs.set(packageName, join(tarballRoot, tarballName));
  }

  return { internalDependencyNames, tarballs, externalDependencies };
}

export function createCliReleaseStage({ rootDir = process.cwd(), stageDir } = {}) {
  const resolvedRootDir = resolve(rootDir);
  const cliPackage = readJson(resolve(resolvedRootDir, "packages", "cli", "package.json"));
  const webPackage = readJson(resolve(resolvedRootDir, "packages", "web", "package.json"));
  const webBundle = ensureWebBundle(resolvedRootDir);

  const outputDir = stageDir
    ? resolve(stageDir)
    : mkdtempSync(join(tmpdir(), "conductor-cli-release-"));

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const internalStagingRoot = join(outputDir, ".release-internal");
  const internalTarballRoot = join(outputDir, ".release-tarballs");
  mkdirSync(internalStagingRoot, { recursive: true });
  mkdirSync(internalTarballRoot, { recursive: true });

  const { internalDependencyNames, tarballs, externalDependencies } = buildInternalPackageTarballs({
    rootDir: resolvedRootDir,
    cliVersion: cliPackage.version,
    tarballRoot: internalTarballRoot,
    stagingRoot: internalStagingRoot,
  });

  copyDistDirectory(resolve(resolvedRootDir, "packages", "cli", "dist"), join(outputDir, "dist"));
  copyOptionalFile(resolve(resolvedRootDir, "README.md"), join(outputDir, "README.md"));
  copyOptionalFile(resolve(resolvedRootDir, "LICENSE"), join(outputDir, "LICENSE"));

  const webOutputDir = join(outputDir, "web");
  copyDirectoryResolvingSymlinks(webBundle.standaloneDir, join(webOutputDir, ".next", "standalone"));
  hydrateStandaloneNodeModules(join(webOutputDir, ".next", "standalone"));
  cpSync(webBundle.staticDir, join(webOutputDir, ".next", "static"), { recursive: true });
  cpSync(
    webBundle.staticDir,
    join(webOutputDir, ".next", "standalone", "packages", "web", ".next", "static"),
    { recursive: true },
  );
  if (existsSync(webBundle.publicDir)) {
    cpSync(webBundle.publicDir, join(webOutputDir, "public"), { recursive: true });
    cpSync(webBundle.publicDir, join(webOutputDir, ".next", "standalone", "public"), { recursive: true });
    cpSync(webBundle.publicDir, join(webOutputDir, ".next", "standalone", "packages", "web", "public"), { recursive: true });
  }
  writeJson(join(webOutputDir, "package.json"), {
    name: "@conductor-oss/web-bundle",
    private: true,
    type: "module",
  });

  const stagedDependencies = {};
  for (const [dependencyName, specifier] of Object.entries(cliPackage.dependencies ?? {})) {
    stagedDependencies[dependencyName] = tarballs.has(dependencyName)
      ? `file:${tarballs.get(dependencyName)}`
      : specifier;
  }
  for (const [dependencyName, specifier] of Object.entries(externalDependencies)) {
    addDependency(stagedDependencies, dependencyName, specifier, "internal workspace package");
  }
  for (const [dependencyName, specifier] of Object.entries(webPackage.dependencies ?? {})) {
    if (!dependencyName.startsWith("@conductor-oss/")) {
      addDependency(stagedDependencies, dependencyName, specifier, "@conductor-oss/web");
    }
  }

  const publishedOptionalDependencies = Object.fromEntries(
    CLI_NATIVE_TARGETS.map((target) => [target.packageName, cliPackage.version]),
  );

  const stagedManifest = sanitizePublishedPackage(cliPackage, {
    dependencies: stagedDependencies,
    optionalDependencies: publishedOptionalDependencies,
  });
  stagedManifest.files = ["dist/", "web/", "README.md", "LICENSE"];
  stagedManifest.bundleDependencies = internalDependencyNames;
  writeJson(join(outputDir, "package.json"), stagedManifest);

  // Install external dependencies and resolve file: tarballs for internal ones.
  // Internal package tarballs reference other internal packages by version number,
  // which don't exist on npm until after the first publish. Try a shallow install
  // first so npm only installs direct dependencies without recursing into sub-deps.
  // If that still attempts to resolve unpublished internal versions, fall back to
  // installing only external deps and unpack internal tarballs manually.
  try {
    execFileSync("npm", ["install", "--silent", "--omit=dev", "--omit=optional", "--no-package-lock", "--install-strategy=shallow"], {
      cwd: outputDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // If shallow install fails (pre-publish), fall back to installing only external deps
    // by temporarily removing internal deps from package.json, installing, then restoring.
    console.error("Shallow install failed, falling back to manual external-only install...");
    const manifest = readJson(join(outputDir, "package.json"));
    const fullDeps = { ...manifest.dependencies };
    const externalDeps = {};
    for (const [name, spec] of Object.entries(fullDeps)) {
      if (!name.startsWith("@conductor-oss/")) {
        externalDeps[name] = spec;
      }
    }
    manifest.dependencies = externalDeps;
    writeJson(join(outputDir, "package.json"), manifest);

    execFileSync("npm", ["install", "--silent", "--omit=dev", "--omit=optional", "--no-package-lock"], {
      cwd: outputDir,
      stdio: "inherit",
    });

    // Restore full deps and manually unpack internal tarballs into node_modules
    manifest.dependencies = fullDeps;
    writeJson(join(outputDir, "package.json"), manifest);

    for (const [depName, spec] of Object.entries(fullDeps)) {
      if (depName.startsWith("@conductor-oss/") && spec.startsWith("file:")) {
        const tarPath = spec.replace("file:", "");
        const depDir = join(outputDir, "node_modules", ...depName.split("/"));
        mkdirSync(depDir, { recursive: true });
        execFileSync("tar", ["xzf", tarPath, "--strip-components=1", "-C", depDir], {
          stdio: "inherit",
        });
      }
    }
  }

  const publishedDependencies = {};
  for (const [dependencyName, specifier] of Object.entries(cliPackage.dependencies ?? {})) {
    publishedDependencies[dependencyName] = tarballs.has(dependencyName)
      ? cliPackage.version
      : specifier;
  }
  for (const [dependencyName, specifier] of Object.entries(externalDependencies)) {
    addDependency(publishedDependencies, dependencyName, specifier, "internal workspace package");
  }
  for (const [dependencyName, specifier] of Object.entries(webPackage.dependencies ?? {})) {
    if (!dependencyName.startsWith("@conductor-oss/")) {
      addDependency(publishedDependencies, dependencyName, specifier, "@conductor-oss/web");
    }
  }

  const publishedManifest = sanitizePublishedPackage(cliPackage, {
    dependencies: publishedDependencies,
    optionalDependencies: publishedOptionalDependencies,
  });
  publishedManifest.files = ["dist/", "web/", "README.md", "LICENSE"];
  publishedManifest.bundleDependencies = internalDependencyNames;
  writeJson(join(outputDir, "package.json"), publishedManifest);
  rmSync(join(outputDir, "node_modules", ".package-lock.json"), { force: true });
  rmSync(internalStagingRoot, { recursive: true, force: true });
  rmSync(internalTarballRoot, { recursive: true, force: true });

  return {
    stageDir: outputDir,
    version: cliPackage.version,
    packageName: cliPackage.name,
    internalDependencyNames,
  };
}

export function packCliReleasePackage({ rootDir = process.cwd(), stageDir, packDestination } = {}) {
  const stage = createCliReleaseStage({ rootDir, stageDir });
  const destinationDir = packDestination ? resolve(packDestination) : stage.stageDir;
  mkdirSync(destinationDir, { recursive: true });

  const tarballName = execFileSync("npm", ["pack", "--silent", "--pack-destination", destinationDir], {
    cwd: stage.stageDir,
    encoding: "utf8",
  }).trim();

  return {
    ...stage,
    tarballPath: join(destinationDir, tarballName),
  };
}
