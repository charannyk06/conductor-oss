import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig } from "../types.js";
import { syncWorkspaceSupportFiles } from "../board-watcher.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createConfig(workspacePath: string, projectPath: string): OrchestratorConfig {
  return {
    configPath: join(workspacePath, "conductor.yaml"),
    port: 4747,
    readyThresholdMs: 300_000,
    maxSessionsPerProject: 5,
    dashboardUrl: undefined,
    boards: [],
    columnAliases: undefined,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      demo: {
        name: "Demo",
        repo: "example/demo",
        path: projectPath,
        defaultBranch: "main",
        sessionPrefix: "demo",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    webhook: undefined,
    preferences: {
      onboardingAcknowledged: true,
      codingAgent: "claude-code",
      ide: "vscode",
      markdownEditor: "obsidian",
      notifications: {
        soundEnabled: true,
        soundFile: "abstract-sound-4",
      },
    },
  };
}

test("syncWorkspaceSupportFiles writes tags and snippets to workspace and project roots", () => {
  const workspacePath = createTempDir("conductor-support-workspace-");
  const projectPath = createTempDir("conductor-support-project-");

  try {
    const config = createConfig(workspacePath, projectPath);
    syncWorkspaceSupportFiles(config, {
      workspacePath,
      agentNames: ["claude-code", "codex"],
    });

    const workspaceTagsPath = join(workspacePath, "CONDUCTOR-TAGS.md");
    const projectTagsPath = join(projectPath, "CONDUCTOR-TAGS.md");
    const workspaceSnippetsPath = join(workspacePath, ".vscode", "conductor.code-snippets");
    const projectSnippetsPath = join(projectPath, ".vscode", "conductor.code-snippets");

    assert.equal(existsSync(workspaceTagsPath), true);
    assert.equal(existsSync(projectTagsPath), true);
    assert.equal(existsSync(workspaceSnippetsPath), true);
    assert.equal(existsSync(projectSnippetsPath), true);

    const projectTags = readFileSync(projectTagsPath, "utf8");
    assert.match(projectTags, /#project\/demo/);
    assert.match(projectTags, /#agent\/claude-code/);

    const projectSnippets = readFileSync(projectSnippetsPath, "utf8");
    assert.match(projectSnippets, /demo/);
    assert.match(projectSnippets, /claude-code/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});

test("syncWorkspaceSupportFiles writes placeholder project tags before first project exists", () => {
  const workspacePath = createTempDir("conductor-support-empty-");

  try {
    const emptyConfig = createConfig(workspacePath, workspacePath);
    emptyConfig.projects = {};
    syncWorkspaceSupportFiles(emptyConfig, {
      workspacePath,
      agentNames: ["codex"],
    });

    const tagsPath = join(workspacePath, "CONDUCTOR-TAGS.md");
    const snippetsPath = join(workspacePath, ".vscode", "conductor.code-snippets");
    const tags = readFileSync(tagsPath, "utf8");
    const snippets = readFileSync(snippetsPath, "utf8");

    assert.match(tags, /#project\/my-project/);
    assert.match(snippets, /my-project/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
