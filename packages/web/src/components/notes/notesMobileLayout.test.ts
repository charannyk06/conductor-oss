import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("project notes workspace keeps a compact mobile mode with dedicated file and share sheets", () => {
  const source = readFileSync(new URL("./ProjectNotesWorkspace.tsx", import.meta.url), "utf8");

  assert.match(source, /window\.matchMedia\("\(max-width: 1279px\)"\)/);
  assert.match(source, /mobileSidebarOpen/);
  assert.match(source, /mobileShareOpen/);
  assert.match(source, /compactViewport/);
  assert.match(source, /<Dialog\.Root open=\{mobileSidebarOpen\}/);
  assert.match(source, /<Dialog\.Root open=\{mobileShareOpen\}/);
});

test("notes toolbar exposes a compact actions menu for mobile", () => {
  const source = readFileSync(new URL("./NotesToolbar.tsx", import.meta.url), "utf8");

  assert.match(source, /@radix-ui\/react-dropdown-menu/);
  assert.match(source, /compact/);
  assert.match(source, /Files/);
  assert.match(source, /More/);
  assert.match(source, /Share note/);
});

test("notes graph exposes obsidian-style search, groups, local graph, and force controls", () => {
  const source = readFileSync(new URL("./NotesGraph.tsx", import.meta.url), "utf8");

  assert.match(source, /Search files/);
  assert.match(source, /Groups/);
  assert.match(source, /Local graph/);
  assert.match(source, /Link distance/);
  assert.match(source, /Repel force/);
  assert.match(source, /Node size/);
  assert.match(source, /showArrows/);
  assert.match(source, /Zoom in/);
});
