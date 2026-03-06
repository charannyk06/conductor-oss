import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

function sanitizePublishedPackage(pkg, dependencies) {
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

  if (pkg.exports) {
    sanitized.exports = pkg.exports;
  }
  if (pkg.types) {
    sanitized.types = pkg.types;
  }

  return sanitized;
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
      dependencies[dependencyName] = internalDependencyNames.includes(dependencyName)
        ? cliVersion
        : specifier;
    }

    const sanitizedManifest = sanitizePublishedPackage(sourceManifest, dependencies);
    writeJson(join(packageStageDir, "package.json"), sanitizedManifest);
    cpSync(sourceDistDir, join(packageStageDir, "dist"), { recursive: true });

    const tarballName = execFileSync("npm", ["pack", "--silent", "--pack-destination", tarballRoot], {
      cwd: packageStageDir,
      encoding: "utf8",
    }).trim();

    tarballs.set(packageName, join(tarballRoot, tarballName));
  }

  return { internalDependencyNames, tarballs };
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

  const { internalDependencyNames, tarballs } = buildInternalPackageTarballs({
    rootDir: resolvedRootDir,
    cliVersion: cliPackage.version,
    tarballRoot: internalTarballRoot,
    stagingRoot: internalStagingRoot,
  });

  cpSync(resolve(resolvedRootDir, "packages", "cli", "dist"), join(outputDir, "dist"), { recursive: true });
  copyOptionalFile(resolve(resolvedRootDir, "README.md"), join(outputDir, "README.md"));
  copyOptionalFile(resolve(resolvedRootDir, "LICENSE"), join(outputDir, "LICENSE"));

  const webOutputDir = join(outputDir, "web");
  copyDirectoryResolvingSymlinks(webBundle.standaloneDir, join(webOutputDir, ".next", "standalone"));
  cpSync(webBundle.staticDir, join(webOutputDir, ".next", "static"), { recursive: true });
  cpSync(
    webBundle.staticDir,
    join(webOutputDir, ".next", "standalone", "packages", "web", ".next", "static"),
    { recursive: true },
  );
  if (existsSync(webBundle.publicDir)) {
    cpSync(webBundle.publicDir, join(webOutputDir, "public"), { recursive: true });
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
  for (const [dependencyName, specifier] of Object.entries(webPackage.dependencies ?? {})) {
    if (!dependencyName.startsWith("@conductor-oss/") && !stagedDependencies[dependencyName]) {
      stagedDependencies[dependencyName] = specifier;
    }
  }

  const stagedManifest = sanitizePublishedPackage(cliPackage, stagedDependencies);
  stagedManifest.files = ["dist/", "web/", "README.md", "LICENSE"];
  stagedManifest.bundleDependencies = internalDependencyNames;
  writeJson(join(outputDir, "package.json"), stagedManifest);

  execFileSync("npm", ["install", "--omit=dev", "--no-package-lock"], {
    cwd: outputDir,
    stdio: "inherit",
  });

  const publishedDependencies = {};
  for (const [dependencyName, specifier] of Object.entries(cliPackage.dependencies ?? {})) {
    publishedDependencies[dependencyName] = tarballs.has(dependencyName)
      ? cliPackage.version
      : specifier;
  }
  for (const [dependencyName, specifier] of Object.entries(webPackage.dependencies ?? {})) {
    if (!dependencyName.startsWith("@conductor-oss/") && !publishedDependencies[dependencyName]) {
      publishedDependencies[dependencyName] = specifier;
    }
  }

  const publishedManifest = sanitizePublishedPackage(cliPackage, publishedDependencies);
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
