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

test("validateConfig sanitizes null optional project fields from mixed writers", () => {
  const config = validateConfig({
    projects: {
      demo: {
        repo: "org/demo",
        path: "/tmp/demo",
        defaultWorkingDirectory: null,
        sessionPrefix: null,
        boardDir: null,
        scm: null,
        agent: null,
        agentConfig: {
          permissions: null,
          model: null,
          reasoningEffort: null,
        },
      },
    },
  });

  assert.equal(config.projects["demo"]?.repo, "org/demo");
  assert.equal(config.projects["demo"]?.defaultWorkingDirectory, undefined);
  assert.equal(typeof config.projects["demo"]?.sessionPrefix, "string");
  assert.equal(config.projects["demo"]?.boardDir, undefined);
  assert.deepEqual(config.projects["demo"]?.scm, { plugin: "github" });
  assert.equal(config.projects["demo"]?.agent, undefined);
  assert.equal(config.projects["demo"]?.agentConfig?.permissions, "skip");
  assert.equal(config.projects["demo"]?.agentConfig?.model, undefined);
  assert.equal(config.projects["demo"]?.agentConfig?.reasoningEffort, undefined);
});

test("validateConfig upgrades flat dev server preview fields into nested config", () => {
  const config = validateConfig({
    projects: {
      demo: {
        repo: "org/demo",
        path: "/tmp/demo",
        devServerScript: "pnpm dev",
        devServerCwd: "apps/web",
        devServerPort: "3100",
        devServerHost: "0.0.0.0",
        devServerPath: "preview",
        devServerHttps: true,
      },
    },
  });

  assert.deepEqual(config.projects["demo"]?.devServer, {
    command: "pnpm dev",
    cwd: "apps/web",
    port: 3100,
    host: "0.0.0.0",
    path: "preview",
    https: true,
  });
});
