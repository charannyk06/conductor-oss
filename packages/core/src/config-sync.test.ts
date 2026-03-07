import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { detectConfigDrift, startupConfigSync, GENERATED_MARKER_KEY } from "./index.js";
import type { OrchestratorConfig } from "./types.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `co-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMinimalConfig(projectPath: string): OrchestratorConfig {
  return {
    port: 4747,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "test-proj": {
        name: "test-proj",
        repo: "user/test-proj",
        path: projectPath,
        defaultBranch: "main",
        sessionPrefix: "tp",
        agentConfig: { permissions: "skip" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: ["desktop"], action: ["desktop"], warning: ["desktop"], info: ["desktop"] },
    reactions: {},
    preferences: {
      onboardingAcknowledged: false,
      modelAccess: {},
      notifications: { soundEnabled: true, soundFile: "abstract-sound-4" },
    },
    configPath: "/tmp/conductor.yaml",
  } as unknown as OrchestratorConfig;
}

describe("config-sync", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects missing project-local config", () => {
    const projectPath = join(tmpDir, "proj-missing");
    mkdirSync(projectPath, { recursive: true });
    const config = makeMinimalConfig(projectPath);

    const reports = detectConfigDrift(config);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "missing");
    assert.equal(reports[0].projectId, "test-proj");
  });

  it("detects unmanaged config (no marker)", () => {
    const projectPath = join(tmpDir, "proj-unmanaged");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "conductor.yaml"), "port: 4747\n", "utf-8");
    const config = makeMinimalConfig(projectPath);

    const reports = detectConfigDrift(config);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "unmanaged");
  });

  it("startupConfigSync creates missing configs", () => {
    const projectPath = join(tmpDir, "proj-sync");
    mkdirSync(projectPath, { recursive: true });
    const config = makeMinimalConfig(projectPath);

    const result = startupConfigSync(config);
    assert.equal(result.fixed, 1);
    assert.ok(existsSync(join(projectPath, "conductor.yaml")));

    const content = readFileSync(join(projectPath, "conductor.yaml"), "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    assert.ok(parsed[GENERATED_MARKER_KEY], "should have generation marker");
  });

  it("detects ok after sync", () => {
    const projectPath = join(tmpDir, "proj-ok");
    mkdirSync(projectPath, { recursive: true });
    const config = makeMinimalConfig(projectPath);

    startupConfigSync(config);
    const reports = detectConfigDrift(config);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "ok");
  });

  it("detects drift when local config is modified", () => {
    const projectPath = join(tmpDir, "proj-drift");
    mkdirSync(projectPath, { recursive: true });
    const config = makeMinimalConfig(projectPath);

    startupConfigSync(config);

    // Tamper with the local config
    const localPath = join(projectPath, "conductor.yaml");
    const content = readFileSync(localPath, "utf-8");
    writeFileSync(localPath, content.replace("4747", "9999"), "utf-8");

    const reports = detectConfigDrift(config);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "drifted");
    assert.ok(reports[0].driftedFields?.includes("port"));
  });

  it("skips unmanaged files during startup sync unless force", () => {
    const projectPath = join(tmpDir, "proj-unmanaged2");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "conductor.yaml"), "port: 1234\ncustom: true\n", "utf-8");
    const config = makeMinimalConfig(projectPath);

    const result = startupConfigSync(config);
    assert.equal(result.fixed, 0, "should not touch unmanaged files");

    const resultForce = startupConfigSync(config, { force: true });
    assert.equal(resultForce.fixed, 1, "should fix with force");
  });
});
