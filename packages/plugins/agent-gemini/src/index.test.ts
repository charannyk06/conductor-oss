import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { __test__ } from "./index.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gemini-plugin-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("agent-gemini session helpers", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves the project alias from projects.json", async () => {
    const workspacePath = "/tmp/demo-workspace";
    writeFileSync(
      join(tmpDir, "projects.json"),
      JSON.stringify({ projects: { [workspacePath]: "demo-workspace" } }, null, 2),
      "utf-8",
    );

    const alias = await __test__.resolveGeminiProjectAlias(workspacePath, tmpDir);
    assert.equal(alias, "demo-workspace");
  });

  it("finds the newest session file for a workspace", async () => {
    const workspacePath = "/tmp/find-session-workspace";
    const chatsDir = join(tmpDir, "tmp", "find-session", "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "projects.json"),
      JSON.stringify({ projects: { [workspacePath]: "find-session" } }, null, 2),
      "utf-8",
    );

    const olderFile = join(chatsDir, "session-older.json");
    const newerFile = join(chatsDir, "session-newer.json");
    writeFileSync(olderFile, JSON.stringify({ sessionId: "older" }), "utf-8");
    writeFileSync(newerFile, JSON.stringify({ sessionId: "newer" }), "utf-8");
    utimesSync(olderFile, new Date("2026-03-08T15:00:00.000Z"), new Date("2026-03-08T15:00:00.000Z"));
    utimesSync(newerFile, new Date("2026-03-08T15:05:00.000Z"), new Date("2026-03-08T15:05:00.000Z"));

    const sessionFile = await __test__.findGeminiSessionFile(workspacePath, tmpDir);
    assert.equal(sessionFile, newerFile);
  });

  it("prefers the latest Gemini response for session summaries", () => {
    const summary = __test__.extractGeminiSummary({
      messages: [
        {
          type: "user",
          content: [{ text: "review repo" }],
        },
        {
          type: "gemini",
          content: "",
          thoughts: [{ description: "Inspecting the codebase." }],
        },
        {
          type: "gemini",
          content: "Here is the current state of the repository.",
        },
      ],
    });

    assert.deepEqual(summary, {
      summary: "Here is the current state of the repository.",
      summaryIsFallback: false,
    });
  });
});
