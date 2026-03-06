import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectConfigMap, validateConfig } from "../config.js";

test("validateConfig accepts legacy empty project arrays", () => {
  const config = validateConfig({
    projects: [],
  });

  assert.deepEqual(config.projects, {});
});

test("normalizeProjectConfigMap upgrades legacy project arrays into a keyed record", () => {
  const projects = normalizeProjectConfigMap([
    {
      id: "legacy-app",
      repo: "org/legacy-app",
      path: "/tmp/legacy-app",
      defaultBranch: "main",
    },
    {
      repo: "org/second-app",
      path: "/tmp/second-app",
      defaultBranch: "main",
    },
  ]);

  assert.deepEqual(Object.keys(projects), ["legacy-app", "second-app"]);
  assert.equal((projects["legacy-app"] as { repo?: string }).repo, "org/legacy-app");
  assert.equal((projects["second-app"] as { path?: string }).path, "/tmp/second-app");
});

test("validateConfig upgrades legacy project arrays before applying defaults", () => {
  const config = validateConfig({
    projects: [
      {
        id: "legacy-app",
        repo: "org/legacy-app",
        path: "/tmp/legacy-app",
      },
    ],
  });

  assert.equal(config.projects["legacy-app"]?.repo, "org/legacy-app");
  assert.equal(config.projects["legacy-app"]?.defaultBranch, "main");
  assert.equal(config.projects["legacy-app"]?.name, "legacy-app");
  assert.equal(typeof config.projects["legacy-app"]?.sessionPrefix, "string");
});
