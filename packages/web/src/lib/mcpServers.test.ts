import assert from "node:assert/strict";
import test from "node:test";
import {
  MASKED_ENV_VALUE,
  draftToServer,
  emptyDraft,
  formatArgs,
  normalizeMcpServers,
  parseArgs,
  parseEnv,
  serverToDraft,
  validateDrafts,
} from "./mcpServers";

test("parseArgs honours quotes and collapses whitespace", () => {
  assert.deepEqual(parseArgs("  -y  @scope/server --root \"/my path\" '' "), [
    "-y",
    "@scope/server",
    "--root",
    "/my path",
    "",
  ]);
  assert.deepEqual(parseArgs(""), []);
});

test("formatArgs round-trips through parseArgs", () => {
  const args = ["-y", "pkg", "/my path", ""];
  assert.deepEqual(parseArgs(formatArgs(args)), args);
});

test("parseEnv reads KEY=value lines and keeps '=' in values", () => {
  assert.deepEqual(parseEnv("TOKEN=abc=def\n# comment\n\nbad line\n MODE = ro \n=nokey"), {
    TOKEN: "abc=def",
    MODE: "ro",
  });
});

test("normalizeMcpServers drops malformed entries", () => {
  const servers = normalizeMcpServers({
    servers: [
      { name: "fs", command: "npx", args: ["-y", 3], env: { A: MASKED_ENV_VALUE, B: 1 }, cwd: " ", enabled: false },
      { name: "broken" },
      null,
    ],
  });
  assert.deepEqual(servers, [
    { name: "fs", command: "npx", args: ["-y"], env: { A: MASKED_ENV_VALUE }, cwd: null, enabled: false },
  ]);
  assert.deepEqual(normalizeMcpServers(null), []);
});

test("drafts keep masked env values so stored secrets survive a save", () => {
  const draft = serverToDraft(
    { name: "gh", command: "gh-mcp", args: ["--stdio"], env: { TOKEN: MASKED_ENV_VALUE }, cwd: null, enabled: true },
    "k1",
  );
  assert.equal(draft.envText, `TOKEN=${MASKED_ENV_VALUE}`);
  assert.deepEqual(draftToServer(draft), {
    name: "gh",
    command: "gh-mcp",
    args: ["--stdio"],
    env: { TOKEN: MASKED_ENV_VALUE },
    cwd: null,
    enabled: true,
  });
});

test("validateDrafts reports the first blocking problem", () => {
  const draft = (name: string, command = "cmd") => ({ ...emptyDraft(name), name, command });
  assert.equal(validateDrafts([draft("fs"), draft("gh_1")]), null);
  assert.match(validateDrafts([draft("")]) ?? "", /needs a name/);
  assert.match(validateDrafts([draft("bad name")]) ?? "", /not a valid name/);
  assert.match(validateDrafts([draft("Conductor")]) ?? "", /reserved/);
  assert.match(validateDrafts([draft("fs"), draft("fs")]) ?? "", /listed twice/);
  assert.match(validateDrafts([draft("fs", " ")]) ?? "", /needs a command/);
});
