import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("project notes workspace restores a mobile scroll owner", () => {
  const source = readFileSync(new URL("./ProjectNotesWorkspace.tsx", import.meta.url), "utf8");

  assert.match(source, /overflow-y-auto/);
  assert.match(source, /overscroll-contain/);
  assert.match(source, /touch-pan-y/);
  assert.match(source, /-webkit-overflow-scrolling:touch/);
});

test("project notes workspace keeps a stacked mobile fallback before switching to the desktop grid", () => {
  const source = readFileSync(new URL("./ProjectNotesWorkspace.tsx", import.meta.url), "utf8");

  assert.match(source, /flex min-h-0 flex-1 flex-col/);
  assert.match(source, /xl:grid xl:grid-cols-\[280px_minmax\(0,1fr\)\]/);
});

test("notes sidebar constrains its mobile height so the tree can scroll inside the tab", () => {
  const source = readFileSync(new URL("./NotesSidebar.tsx", import.meta.url), "utf8");

  assert.match(source, /max-h-\[min\(42dvh,360px\)\]/);
  assert.match(source, /xl:border-r/);
});

test("notes graph keeps a usable mobile canvas height", () => {
  const source = readFileSync(new URL("./NotesGraph.tsx", import.meta.url), "utf8");

  assert.match(source, /min-h-\[min\(560px,70dvh\)\]/);
});
