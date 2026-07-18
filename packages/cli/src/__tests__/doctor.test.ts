import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDoctorWorkspaceCheck } from "../commands/doctor.js";
import { workspaceIdForPath } from "../workspaceIdentity.js";

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "conductor-doctor-workspace-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "conductor.yaml"), "projects: {}\n", "utf8");
  return workspace;
}

test("doctor accepts the backend for the requested workspace", () => {
  const workspace = createWorkspace();
  const workspaceId = workspaceIdForPath(workspace);

  assert.deepEqual(buildDoctorWorkspaceCheck(workspace, workspaceId), {
    requestedPath: workspace,
    expectedId: workspaceId,
    backendId: workspaceId,
    status: "match",
  });
});

test("doctor rejects a healthy backend for a different workspace", () => {
  const workspace = createWorkspace();
  const expectedId = workspaceIdForPath(workspace);

  assert.deepEqual(buildDoctorWorkspaceCheck(workspace, "deadbeef1234"), {
    requestedPath: workspace,
    expectedId,
    backendId: "deadbeef1234",
    status: "mismatch",
  });
});

test("doctor fails closed when an older backend omits workspace identity", () => {
  const workspace = createWorkspace();

  assert.equal(buildDoctorWorkspaceCheck(workspace, undefined).status, "unsupported");
});
