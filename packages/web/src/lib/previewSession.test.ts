import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DashboardSession } from "./types";
import { discoverPreviewCandidateUrls, loadPreviewSessionContext } from "./previewSession";

function buildSession(metadata: Record<string, string>): DashboardSession {
  return {
    id: "session-1",
    projectId: "demo",
    status: "working",
    activity: "active",
    branch: "feature/demo",
    issueId: null,
    summary: "Summary with remote preview https://preview.example.com",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: {
      number: 1,
      url: "https://github.com/example/repo/pull/1",
      title: "PR",
      branch: "feature/demo",
      baseBranch: "main",
      isDraft: false,
      state: "open",
      ciStatus: "none",
      reviewDecision: "none",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
      previewUrl: "https://deploy-preview.example.com",
    },
    metadata,
  };
}

test("discoverPreviewCandidateUrls prefers explicit dev server urls and ignores backend api urls", async () => {
  const previousBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
  const previousFetch = global.fetch;
  const tempDir = mkdtempSync(join(tmpdir(), "conductor-preview-test-"));
  const logPath = join(tempDir, "dev-server.log");

  writeFileSync(
    logPath,
    [
      "ready at http://localhost:3001",
      "backend http://127.0.0.1:4749/api/sessions/session-1",
    ].join("\n"),
    "utf8",
  );

  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  global.fetch = (async (input: string | URL) => {
    const url = String(input);
    assert.match(url, /\/api\/sessions\/session-1\/output\?lines=400$/);
    return new Response(JSON.stringify({ output: "stdout http://localhost:3002" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const session = buildSession({
      devServerUrl: "http://0.0.0.0:3000",
      devServerLog: logPath,
      other: "ignored http://127.0.0.1:4749/api/health",
    });

    const urls = await discoverPreviewCandidateUrls(session);

    assert.deepEqual(urls, [
      "http://127.0.0.1:3000/",
      "http://localhost:3001/",
      "https://deploy-preview.example.com/",
      "https://preview.example.com/",
      "http://localhost:3002/",
    ]);
  } finally {
    process.env.CONDUCTOR_BACKEND_URL = previousBackendUrl;
    global.fetch = previousFetch;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadPreviewSessionContext captures backend lookup failures without throwing", async () => {
  const previousBackendUrl = process.env.CONDUCTOR_BACKEND_URL;

  delete process.env.CONDUCTOR_BACKEND_URL;

  try {
    const context = await loadPreviewSessionContext("session-1");

    assert.equal(context.session, null);
    assert.deepEqual(context.candidateUrls, []);
    assert.equal(context.error, "Rust backend URL is not configured");
  } finally {
    if (previousBackendUrl === undefined) {
      delete process.env.CONDUCTOR_BACKEND_URL;
    } else {
      process.env.CONDUCTOR_BACKEND_URL = previousBackendUrl;
    }
  }
});
