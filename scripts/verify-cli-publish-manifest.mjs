import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(process.cwd(), "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const workspaceEntries = dependencyFields.flatMap((field) =>
  Object.entries(manifest[field] ?? {})
    .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
    .map(([name, version]) => `${field}.${name}=${version}`),
);

if (workspaceEntries.length > 0) {
  const details = workspaceEntries.map((entry) => `- ${entry}`).join("\n");
  throw new Error(
    [
      "Refusing to pack/publish a raw CLI workspace manifest with unresolved workspace dependencies.",
      "Use the staged release flow instead: `node scripts/pack-cli-release.mjs` or `node scripts/publish-cli-package.mjs`.",
      details,
    ].join("\n"),
  );
}
