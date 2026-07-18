import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  normalizeWorkspaceIdentityPath,
  resolveWorkspaceConfigPath,
  workspaceIdForDirectory,
  workspaceIdForPath,
} from "./workspaceIdentity.js";

test("workspace identity matches the backend config-directory hash contract", () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-workspace-id-"));
  const workspace = join(root, "workspace");
  const configPath = join(workspace, "conductor.yaml");
  mkdirSync(workspace);
  writeFileSync(configPath, "projects: {}\n", "utf8");

  const canonicalDirectory = dirname(realpathSync(configPath));
  const expected = createHash("sha256")
    .update(canonicalDirectory)
    .digest("hex")
    .slice(0, 12);

  assert.equal(resolveWorkspaceConfigPath(workspace), configPath);
  assert.equal(resolveWorkspaceConfigPath(configPath), configPath);
  assert.equal(workspaceIdForPath(workspace), expected);
  assert.equal(workspaceIdForPath(configPath), expected);
  assert.equal(workspaceIdForDirectory(workspace), expected);
});

test("workspace identity normalizes Windows extended paths", () => {
  assert.equal(
    normalizeWorkspaceIdentityPath("\\\\?\\C:\\Users\\dev\\workspace"),
    "C:\\Users\\dev\\workspace",
  );
  assert.equal(
    normalizeWorkspaceIdentityPath("\\\\?\\UNC\\server\\share\\workspace"),
    "\\\\server\\share\\workspace",
  );
});
