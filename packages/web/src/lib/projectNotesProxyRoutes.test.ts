import assert from "node:assert/strict";
import test from "node:test";

import { GET as getBacklinks } from "@/app/api/project-notes/backlinks/route";
import { POST as postDaily } from "@/app/api/project-notes/daily/route";
import { GET as getGraph } from "@/app/api/project-notes/graph/route";

test("project notes advanced proxy routes are registered", () => {
  assert.equal(typeof getBacklinks, "function");
  assert.equal(typeof postDaily, "function");
  assert.equal(typeof getGraph, "function");
});
