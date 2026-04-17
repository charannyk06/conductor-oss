import assert from "node:assert/strict";
import test from "node:test";

import type { GraphEdge, GraphNode, NoteFile } from "./types";
import { buildNotesGraphIndex, collectReachableNodes, filterNotesGraph } from "./notesGraphModel";

const noteFiles: NoteFile[] = [
  {
    path: "/vault/project/design.md",
    displayPath: "project/design.md",
    name: "design.md",
    source: "vault",
    sizeBytes: 128,
    modifiedAt: null,
    kind: "file",
  },
  {
    path: "/vault/project/overview.md",
    displayPath: "project/overview.md",
    name: "overview.md",
    source: "vault",
    sizeBytes: 256,
    modifiedAt: null,
    kind: "file",
  },
  {
    path: "/vault/strategy/launch.md",
    displayPath: "strategy/launch.md",
    name: "launch.md",
    source: "vault",
    sizeBytes: 512,
    modifiedAt: null,
    kind: "file",
  },
  {
    path: "/vault/inbox/orphan.md",
    displayPath: "inbox/orphan.md",
    name: "orphan.md",
    source: "vault",
    sizeBytes: 64,
    modifiedAt: null,
    kind: "file",
  },
];

const nodes: GraphNode[] = [
  { id: "/vault/project/design.md", name: "design.md", tags: ["architecture"] },
  { id: "/vault/project/overview.md", name: "overview.md", tags: ["architecture"] },
  { id: "/vault/strategy/launch.md", name: "launch.md", tags: ["launch"] },
  { id: "/vault/inbox/orphan.md", name: "orphan.md", tags: [] },
];

const edges: GraphEdge[] = [
  { source: "/vault/project/design.md", target: "/vault/project/overview.md" },
  { source: "/vault/project/overview.md", target: "/vault/strategy/launch.md" },
];

test("buildNotesGraphIndex derives folder groups and connection counts from note metadata", () => {
  const graphIndex = buildNotesGraphIndex(nodes, edges, noteFiles);

  assert.equal(graphIndex.nodesById.get("/vault/project/overview.md")?.degree, 2);
  assert.equal(graphIndex.nodesById.get("/vault/project/design.md")?.folder, "project");
  assert.deepEqual(
    Array.from(graphIndex.groups)
      .map((group) => ({ id: group.id, count: group.count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: "inbox", count: 1 },
      { id: "project", count: 2 },
      { id: "strategy", count: 1 },
    ],
  );
});

test("collectReachableNodes walks outward from the selected local graph node", () => {
  const graphIndex = buildNotesGraphIndex(nodes, edges, noteFiles);

  assert.deepEqual(
    Array.from(collectReachableNodes(graphIndex, "/vault/project/overview.md", 1)).sort(),
    [
      "/vault/project/design.md",
      "/vault/project/overview.md",
      "/vault/strategy/launch.md",
    ],
  );

  assert.deepEqual(
    Array.from(collectReachableNodes(graphIndex, "/vault/project/overview.md", 0)),
    ["/vault/project/overview.md"],
  );
});

test("filterNotesGraph keeps neighbor context for search while hiding orphans and honoring group filters", () => {
  const graphIndex = buildNotesGraphIndex(nodes, edges, noteFiles);

  const searched = filterNotesGraph(graphIndex, {
    search: "design",
    showOrphans: false,
    activeGroupId: null,
    localRootId: null,
    localDepth: 1,
  });
  assert.deepEqual(
    searched.nodes.map((node) => node.id).sort(),
    ["/vault/project/design.md", "/vault/project/overview.md"],
  );
  assert.deepEqual(searched.edges.map((edge) => `${edge.source}->${edge.target}`), [
    "/vault/project/design.md->/vault/project/overview.md",
  ]);

  const grouped = filterNotesGraph(graphIndex, {
    search: "",
    showOrphans: false,
    activeGroupId: "strategy",
    localRootId: null,
    localDepth: 1,
  });
  assert.deepEqual(grouped.nodes.map((node) => node.id), ["/vault/strategy/launch.md"]);
  assert.equal(grouped.edges.length, 0);
});
