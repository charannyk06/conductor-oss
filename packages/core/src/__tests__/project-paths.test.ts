import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.js";
import { resolveConfiguredProjectPath } from "../project-paths.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("resolveConfiguredProjectPath heals legacy markdown-file project paths", () => {
  const sandbox = createTempDir("conductor-project-paths-");

  try {
    const projectsDir = join(sandbox, "projects");
    const repoDir = join(projectsDir, "aba-copilot");
    const markdownPath = join(projectsDir, "ABA-Copilot.md");

    mkdirSync(repoDir, { recursive: true });
    writeFileSync(markdownPath, "# legacy board pointer\n", "utf8");

    const resolved = resolveConfiguredProjectPath(markdownPath, "your-org/aba-copilot");
    assert.equal(resolved, realpathSync.native(repoDir));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("validateConfig normalizes project paths to the actual repository directory", () => {
  const sandbox = createTempDir("conductor-config-paths-");

  try {
    const projectsDir = join(sandbox, "projects");
    const repoDir = join(projectsDir, "aba-copilot");
    const markdownPath = join(projectsDir, "ABA-Copilot.md");

    mkdirSync(repoDir, { recursive: true });
    writeFileSync(markdownPath, "# legacy board pointer\n", "utf8");

    const config = validateConfig({
      projects: {
        "aba-copilot": {
          repo: "your-org/aba-copilot",
          path: markdownPath,
        },
      },
    });

    assert.equal(config.projects["aba-copilot"]?.path, realpathSync.native(repoDir));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
