import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getUncheckedTasks,
  parseBoardSections,
  resolveColumnAliases,
  resolveColumnsFromBoard,
} from "../board-parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "__fixtures__", "boards");

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

test("quoted lines fixture parses sections and ready tasks", () => {
  const content = fixture("quoted-lines.md");
  const sections = parseBoardSections(content);
  assert.ok(sections.some((section) => section.heading === "Inbox"));
  const ready = getUncheckedTasks(content, "Ready to Dispatch");
  assert.equal(ready.length, 1);
  assert.match(ready[0] ?? "", /implement parser hardening/);
});

test("indented checkboxes are parsed as unchecked tasks", () => {
  const content = fixture("indented-checkboxes.md");
  const ready = getUncheckedTasks(content, "Ready to Dispatch");
  assert.deepEqual(ready, ["indented task one", "indented task two"]);
});

test("multiple checklist markers (+, *) are parsed", () => {
  const content = [
    "## Inbox",
    "- [ ] alpha task",
    "* [x] beta task",
    "+ [ ] gamma task",
    "",
  ].join("\n");
  const ready = getUncheckedTasks(content, "Inbox");
  assert.deepEqual(ready, ["alpha task", "gamma task"]);
});

test("custom columns resolve with aliases", () => {
  const content = fixture("custom-columns.md");
  const aliases = resolveColumnAliases(undefined, {
    intake: ["Backlog"],
    ready: ["Ready"],
    review: ["In Review"],
    done: ["Done"],
  });
  const resolved = resolveColumnsFromBoard(content, aliases);
  assert.equal(resolved.columnsByRole.ready, "Ready");
  assert.equal(resolved.columnsByRole.review, "In Review");
});

test("mixed board styles parse multiline ready task", () => {
  const content = fixture("mixed-styles.md");
  const ready = getUncheckedTasks(content, "Ready");
  assert.equal(ready.length, 1);
  assert.match(ready[0] ?? "", /details line continues here/);
});

test("non-CONDUCTOR filename board fixture still parses", () => {
  const content = fixture("project-backlog.md");
  const aliases = resolveColumnAliases(undefined, {
    intake: ["Backlog"],
    ready: ["Ready"],
    review: ["Review"],
    done: ["Done"],
  });
  const resolved = resolveColumnsFromBoard(content, aliases);
  assert.equal(resolved.columnsByRole.ready, "Ready");
  const ready = getUncheckedTasks(content, resolved.columnsByRole.ready);
  assert.equal(ready[0], "dispatch from backlog-only board");
});
