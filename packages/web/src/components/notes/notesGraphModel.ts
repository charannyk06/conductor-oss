import type { GraphEdge, GraphNode, NoteFile } from "./types";

const GROUP_COLORS = [
  "#8b5cf6",
  "#14b8a6",
  "#f59e0b",
  "#ef4444",
  "#22c55e",
  "#ec4899",
  "#3b82f6",
  "#f97316",
];

export type NotesGraphGroup = {
  id: string;
  label: string;
  count: number;
  color: string;
};

export type NotesGraphNodeRecord = {
  id: string;
  name: string;
  displayPath: string;
  source: string | null;
  folder: string;
  tags: string[];
  degree: number;
  isOrphan: boolean;
};

export type NotesGraphEdgeRecord = {
  id: string;
  source: string;
  target: string;
};

export type NotesGraphIndex = {
  nodes: NotesGraphNodeRecord[];
  edges: NotesGraphEdgeRecord[];
  nodesById: Map<string, NotesGraphNodeRecord>;
  adjacency: Map<string, Set<string>>;
  groups: NotesGraphGroup[];
};

export type NotesGraphFilterOptions = {
  search: string;
  showOrphans: boolean;
  activeGroupId: string | null;
  localRootId: string | null;
  localDepth: number;
};

function normalizeFolderId(displayPath: string): string {
  const normalized = displayPath.replace(/^\/+/, "");
  const firstSegment = normalized.split("/").find((segment) => segment.trim().length > 0);
  return firstSegment ?? "root";
}

function humanizeGroupLabel(groupId: string): string {
  if (groupId === "root") return "Root";
  return groupId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function makeSearchHaystack(node: NotesGraphNodeRecord): string {
  return [node.name, node.displayPath, node.folder, ...node.tags].join(" ").toLowerCase();
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set(Array.from(left).filter((value) => right.has(value)));
}

export function buildNotesGraphIndex(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  noteFiles: NoteFile[],
): NotesGraphIndex {
  const metadataById = new Map(noteFiles.map((file) => [file.path, file]));
  const nodesById = new Map<string, NotesGraphNodeRecord>();
  const adjacency = new Map<string, Set<string>>();
  const groupCounts = new Map<string, number>();
  const edges: NotesGraphEdgeRecord[] = [];
  const seenEdgeIds = new Set<string>();

  for (const rawNode of rawNodes) {
    const metadata = metadataById.get(rawNode.id);
    const displayPath = metadata?.displayPath ?? rawNode.name;
    const folder = normalizeFolderId(displayPath);
    const record: NotesGraphNodeRecord = {
      id: rawNode.id,
      name: rawNode.name,
      displayPath,
      source: metadata?.source ?? null,
      folder,
      tags: rawNode.tags ?? [],
      degree: 0,
      isOrphan: true,
    };
    nodesById.set(record.id, record);
    adjacency.set(record.id, new Set());
    groupCounts.set(folder, (groupCounts.get(folder) ?? 0) + 1);
  }

  for (const rawEdge of rawEdges) {
    if (!nodesById.has(rawEdge.source) || !nodesById.has(rawEdge.target)) continue;
    const id = `${rawEdge.source}->${rawEdge.target}`;
    if (seenEdgeIds.has(id)) continue;
    seenEdgeIds.add(id);
    edges.push({ id, source: rawEdge.source, target: rawEdge.target });
    adjacency.get(rawEdge.source)?.add(rawEdge.target);
    adjacency.get(rawEdge.target)?.add(rawEdge.source);
  }

  const nodes = Array.from(nodesById.values()).map((node) => {
    const degree = adjacency.get(node.id)?.size ?? 0;
    const next = {
      ...node,
      degree,
      isOrphan: degree === 0,
    };
    nodesById.set(node.id, next);
    return next;
  });

  const groups = Array.from(groupCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id, count], index) => ({
      id,
      label: humanizeGroupLabel(id),
      count,
      color: GROUP_COLORS[index % GROUP_COLORS.length],
    }));

  return {
    nodes,
    edges,
    nodesById,
    adjacency,
    groups,
  };
}

export function collectReachableNodes(
  graphIndex: NotesGraphIndex,
  startId: string,
  depth: number,
): Set<string> {
  if (!graphIndex.nodesById.has(startId)) return new Set();
  const clampedDepth = Math.max(0, Math.floor(depth));
  const visited = new Set<string>([startId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.depth >= clampedDepth) continue;
    for (const neighbor of Array.from(graphIndex.adjacency.get(current.id) ?? [])) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push({ id: neighbor, depth: current.depth + 1 });
    }
  }

  return visited;
}

export function filterNotesGraph(
  graphIndex: NotesGraphIndex,
  options: NotesGraphFilterOptions,
): { nodes: NotesGraphNodeRecord[]; edges: NotesGraphEdgeRecord[] } {
  const search = options.search.trim().toLowerCase();
  let visibleIds = new Set(graphIndex.nodes.map((node) => node.id));

  if (options.activeGroupId) {
    const groupedIds = new Set(
      graphIndex.nodes
        .filter((node) => node.folder === options.activeGroupId)
        .map((node) => node.id),
    );
    visibleIds = intersectSets(visibleIds, groupedIds);
  }

  if (search.length > 0) {
    const matches = graphIndex.nodes
      .filter((node) => makeSearchHaystack(node).includes(search))
      .map((node) => node.id);
    const expandedMatches = new Set<string>();
    for (const match of matches) {
      for (const reachable of Array.from(collectReachableNodes(graphIndex, match, 1))) {
        expandedMatches.add(reachable);
      }
    }
    visibleIds = intersectSets(visibleIds, expandedMatches);
  }

  if (options.localRootId) {
    const localIds = collectReachableNodes(graphIndex, options.localRootId, options.localDepth);
    visibleIds = intersectSets(visibleIds, localIds);
  }

  let edges = graphIndex.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );

  if (!options.showOrphans) {
    visibleIds = new Set(
      Array.from(visibleIds).filter((id) => {
        if (options.localRootId && id === options.localRootId) return true;
        return graphIndex.nodesById.get(id)?.isOrphan === false;
      }),
    );
    edges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  }

  const nodes = graphIndex.nodes
    .filter((node) => visibleIds.has(node.id))
    .sort((left, right) => {
      return right.degree - left.degree || left.displayPath.localeCompare(right.displayPath);
    });

  return { nodes, edges };
}
