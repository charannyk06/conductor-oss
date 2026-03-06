import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { packCliReleasePackage } from "./cli-release-stage.mjs";

const rootDir = resolve(process.cwd());
const artifactDir = resolve(rootDir, ".release-artifacts");

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });

const { stageDir, tarballPath, version, packageName } = packCliReleasePackage({
  rootDir,
  packDestination: artifactDir,
});

rmSync(stageDir, { recursive: true, force: true });

console.log(tarballPath);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `tarball_path=${tarballPath}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `tarball_name=${basename(tarballPath)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `package_name=${packageName}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `tag_name=v${version}\n`);
}
