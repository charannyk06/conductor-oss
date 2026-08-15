"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import {
  ArrowUpRight,
  LocateFixed,
  Network,
  Search,
  Settings2,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { withBridgeQuery } from "@/lib/bridgeQuery";

import type { GraphEdge, GraphNode, NoteFile } from "./types";
import {
  buildNotesGraphIndex,
  collectReachableNodes,
  filterNotesGraph,
  type NotesGraphEdgeRecord,
  type NotesGraphNodeRecord,
} from "./notesGraphModel";

interface NotesGraphProps {
  projectId: string;
  bridgeId?: string | null;
  onNavigate: (path: string) => void;
  noteFiles: NoteFile[];
  selectedPath?: string | null;
}

interface SimNode extends NotesGraphNodeRecord {
  x: number;
  y: number;
}

interface SimEdge {
  id: string;
  source: SimNode | string;
  target: SimNode | string;
}

const NOTES_GRAPH_SURFACE_CLASS_NAME = "flex h-full min-h-[min(560px,70dvh)] flex-col overflow-hidden bg-[var(--vk-bg-main)] xl:min-h-0";
const NOTES_GRAPH_PANEL_CLASS_NAME = "rounded-[14px] border border-[color:rgba(148,163,184,0.16)] bg-[linear-gradient(180deg,rgba(15,23,42,0.88),rgba(2,6,23,0.96))] shadow-[0_26px_80px_rgba(2,6,23,0.45)] backdrop-blur-sm";
const NOTES_GRAPH_RANGE_CLASS_NAME = "h-1.5 w-full cursor-pointer accent-[var(--vk-accent)]";
const NOTES_GRAPH_GROUP_COLORS = [
  "#8b5cf6",
  "#14b8a6",
  "#f59e0b",
  "#ef4444",
  "#22c55e",
  "#ec4899",
  "#3b82f6",
  "#f97316",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getFittedTransform(nodes: SimNode[], width: number, height: number): { x: number; y: number; k: number } {
  if (nodes.length === 0 || width <= 0 || height <= 0) {
    return { x: 0, y: 0, k: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }

  const graphWidth = Math.max(maxX - minX, 120);
  const graphHeight = Math.max(maxY - minY, 120);
  const padding = Math.min(width, height) * 0.12;
  const k = clamp(
    Math.min((width - padding) / graphWidth, (height - padding) / graphHeight),
    0.32,
    2.4,
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    x: -(centerX * k),
    y: -(centerY * k),
    k,
  };
}

function getNodeRadius(node: NotesGraphNodeRecord, nodeSize: number): number {
  return clamp(nodeSize + node.degree * 1.1, 5, 24);
}

function nodeMatchesSearch(node: NotesGraphNodeRecord, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return false;
  return [node.name, node.displayPath, node.folder, ...node.tags]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function NotesGraph({
  projectId,
  bridgeId,
  onNavigate,
  noteFiles,
  selectedPath = null,
}: NotesGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const defaultsInitializedRef = useRef(false);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const [rawNodes, setRawNodes] = useState<GraphNode[]>([]);
  const [rawEdges, setRawEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(selectedPath);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [localGraphEnabled, setLocalGraphEnabled] = useState(false);
  const [localDepth, setLocalDepth] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showArrows, setShowArrows] = useState(false);
  const [nodeSize, setNodeSize] = useState(7);
  const [linkThickness, setLinkThickness] = useState(1.15);
  const [linkDistance, setLinkDistance] = useState(120);
  const [repelForce, setRepelForce] = useState(220);
  const [centerForce, setCenterForce] = useState(0.09);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ projectId });
      const response = await fetch(
        withBridgeQuery(`/api/project-notes/graph?${params.toString()}`, bridgeId),
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as
        | { nodes: GraphNode[]; edges: GraphEdge[] }
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(
          payload && "error" in payload
            ? payload.error ?? "Failed to load graph"
            : `Failed to load graph (${response.status})`,
        );
      }

      const graphData = payload as { nodes: GraphNode[]; edges: GraphEdge[] };
      setRawNodes(graphData.nodes ?? []);
      setRawEdges(graphData.edges ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
      setRawNodes([]);
      setRawEdges([]);
    } finally {
      setLoading(false);
    }
  }, [bridgeId, projectId]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  useEffect(() => {
    if (selectedPath) {
      setFocusedNodeId(selectedPath);
    }
  }, [selectedPath]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const syncViewport = () => {
      setViewport({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    syncViewport();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(syncViewport);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (defaultsInitializedRef.current || viewport.width <= 0) return;
    const compactGraphViewport = viewport.width < 960;
    setSettingsOpen(!compactGraphViewport);
    setShowLabels(!compactGraphViewport);
    defaultsInitializedRef.current = true;
  }, [viewport.width]);

  const graphIndex = useMemo(
    () => buildNotesGraphIndex(rawNodes, rawEdges, noteFiles),
    [noteFiles, rawEdges, rawNodes],
  );

  const groupColorById = useMemo(
    () => new Map(graphIndex.groups.map((group) => [group.id, group.color])),
    [graphIndex.groups],
  );

  const prefilteredGraph = useMemo(
    () =>
      filterNotesGraph(graphIndex, {
        search,
        showOrphans,
        activeGroupId,
        localRootId: null,
        localDepth,
      }),
    [activeGroupId, graphIndex, localDepth, search, showOrphans],
  );

  const effectiveLocalRootId = useMemo(() => {
    if (!localGraphEnabled) return null;
    if (focusedNodeId && prefilteredGraph.nodes.some((node) => node.id === focusedNodeId)) {
      return focusedNodeId;
    }
    if (selectedPath && prefilteredGraph.nodes.some((node) => node.id === selectedPath)) {
      return selectedPath;
    }
    return prefilteredGraph.nodes[0]?.id ?? null;
  }, [focusedNodeId, localGraphEnabled, prefilteredGraph.nodes, selectedPath]);

  const visibleGraph = useMemo(() => {
    if (!localGraphEnabled || !effectiveLocalRootId) {
      return prefilteredGraph;
    }
    return filterNotesGraph(graphIndex, {
      search,
      showOrphans,
      activeGroupId,
      localRootId: effectiveLocalRootId,
      localDepth,
    });
  }, [
    activeGroupId,
    effectiveLocalRootId,
    graphIndex,
    localDepth,
    localGraphEnabled,
    prefilteredGraph,
    search,
    showOrphans,
  ]);

  useEffect(() => {
    if (focusedNodeId && visibleGraph.nodes.some((node) => node.id === focusedNodeId)) {
      return;
    }
    if (selectedPath && visibleGraph.nodes.some((node) => node.id === selectedPath)) {
      setFocusedNodeId(selectedPath);
      return;
    }
    setFocusedNodeId(visibleGraph.nodes[0]?.id ?? null);
  }, [focusedNodeId, selectedPath, visibleGraph.nodes]);

  const activeNodeId = hoveredNodeId ?? focusedNodeId ?? effectiveLocalRootId;
  const highlightedNodeIds = useMemo(() => {
    if (!activeNodeId) return null;
    return collectReachableNodes(graphIndex, activeNodeId, 1);
  }, [activeNodeId, graphIndex]);

  const layout = useMemo(() => {
    const groupOrder = new Map(graphIndex.groups.map((group, index) => [group.id, index]));
    const groupCount = Math.max(graphIndex.groups.length, 1);

    const simNodes: SimNode[] = visibleGraph.nodes.map((node, index) => {
      const groupIndexForNode = groupOrder.get(node.folder) ?? 0;
      const angle = (groupIndexForNode / groupCount) * Math.PI * 2 + (index % 9) * 0.37;
      const radius = 180 + (index % 11) * 16;
      return {
        ...node,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });

    const simEdges: SimEdge[] = visibleGraph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));

    const simulation = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(simEdges)
          .id((node) => node.id)
          .distance(linkDistance)
          .strength(0.32),
      )
      .force("charge", forceManyBody<SimNode>().strength(-repelForce))
      .force("center-x", forceX<SimNode>(0).strength(centerForce))
      .force("center-y", forceY<SimNode>(0).strength(centerForce))
      .force("collide", forceCollide<SimNode>((node) => getNodeRadius(node, nodeSize) + 8))
      .stop();

    for (let tick = 0; tick < 220; tick += 1) {
      simulation.tick();
    }

    const edges: NotesGraphEdgeRecord[] = simEdges
      .map((edge) => {
        const source = typeof edge.source === "object" ? edge.source : simNodes.find((node) => node.id === edge.source);
        const target = typeof edge.target === "object" ? edge.target : simNodes.find((node) => node.id === edge.target);
        if (!source || !target) return null;
        return {
          id: edge.id,
          source: source.id,
          target: target.id,
        };
      })
      .filter((edge): edge is NotesGraphEdgeRecord => edge !== null);

    return { nodes: simNodes, edges };
  }, [
    centerForce,
    graphIndex.groups,
    linkDistance,
    nodeSize,
    repelForce,
    visibleGraph.edges,
    visibleGraph.nodes,
  ]);

  useEffect(() => {
    setTransform(getFittedTransform(layout.nodes, viewport.width, viewport.height));
  }, [layout.nodes, viewport.height, viewport.width]);

  const searchMatches = useMemo(
    () => new Set(visibleGraph.nodes.filter((node) => nodeMatchesSearch(node, search)).map((node) => node.id)),
    [search, visibleGraph.nodes],
  );

  const focusedNode = layout.nodes.find((node) => node.id === focusedNodeId) ?? null;
  const visibleNodeCount = layout.nodes.length;
  const visibleEdgeCount = layout.edges.length;
  const compactGraphViewport = viewport.width > 0 && viewport.width < 960;
  const labelVisibilityThreshold = compactGraphViewport ? 1.32 : 0.9;

  const zoomAtPoint = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    setTransform((current) => {
      const k = clamp(nextScale, 0.28, 3.4);
      const container = containerRef.current;
      if (!container) {
        return { ...current, k };
      }
      const rect = container.getBoundingClientRect();
      const screenX = clientX == null ? rect.width / 2 : clientX - rect.left;
      const screenY = clientY == null ? rect.height / 2 : clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const worldX = (screenX - centerX - current.x) / current.k;
      const worldY = (screenY - centerY - current.y) / current.k;
      return {
        x: screenX - centerX - worldX * k,
        y: screenY - centerY - worldY * k,
        k,
      };
    });
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const nextScale = event.deltaY > 0 ? transform.k * 0.9 : transform.k * 1.1;
    zoomAtPoint(nextScale, event.clientX, event.clientY);
  }, [transform.k, zoomAtPoint]);

  const handleStartPan = useCallback((event: React.PointerEvent<SVGRectElement>) => {
    if (event.button !== 0 && event.pointerType !== "touch") return;
    panStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [transform.x, transform.y]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) return;
    setTransform((current) => ({
      ...current,
      x: panState.originX + (event.clientX - panState.startX),
      y: panState.originY + (event.clientY - panState.startY),
    }));
  }, []);

  const handleStopPan = useCallback((event: React.PointerEvent<SVGSVGElement | SVGRectElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) return;
    panStateRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
        <Sparkles className="h-4 w-4 animate-pulse text-[var(--vk-accent)]" />
        Loading graph…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-[var(--vk-red)]">
        {error}
      </div>
    );
  }

  return (
    <div className={NOTES_GRAPH_SURFACE_CLASS_NAME}>
      <div className="flex items-center justify-between border-b border-[var(--vk-border)] px-4 py-2">
        <div>
          <p className="text-[13px] font-medium text-[var(--vk-text-strong)]">Obsidian-style graph</p>
          <p className="text-[11px] text-[var(--vk-text-muted)]">
            {visibleNodeCount} visible notes, {visibleEdgeCount} visible links
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSettingsOpen((current) => !current)}
            className="oc-mobile-touch-target inline-flex min-h-11 items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-2.5 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] sm:min-h-[32px]"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => void fetchGraph()}
            className="oc-mobile-touch-target inline-flex min-h-11 items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-2.5 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] sm:min-h-[32px]"
          >
            <Network className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3 xl:grid-cols-[320px_minmax(0,1fr)]">
        {settingsOpen ? (
          <aside className={`${NOTES_GRAPH_PANEL_CLASS_NAME} min-h-0 overflow-auto px-4 py-4`}>
            <section>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">
                Search files
              </p>
              <label className="mt-2 flex items-center gap-2 rounded-[10px] border border-[color:rgba(148,163,184,0.16)] bg-black/20 px-3 py-2">
                <Search className="h-4 w-4 text-[var(--vk-text-muted)]" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search files, folders, or tags"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                />
              </label>
            </section>

            <section className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">
                  Groups
                </p>
                {activeGroupId ? (
                  <button
                    type="button"
                    onClick={() => setActiveGroupId(null)}
                    className="text-[11px] text-[var(--vk-accent)] hover:underline"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {graphIndex.groups.map((group) => {
                  const active = activeGroupId === group.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => setActiveGroupId(active ? null : group.id)}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] ${
                        active
                          ? "border-[var(--vk-accent)] bg-[rgba(139,92,246,0.16)] text-[var(--vk-text-strong)]"
                          : "border-[color:rgba(148,163,184,0.16)] bg-black/20 text-[var(--vk-text-muted)] hover:bg-[rgba(255,255,255,0.04)]"
                      }`}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.color }} />
                      <span>{group.label}</span>
                      <span className="opacity-70">{group.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="mt-5 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">
                Local graph
              </p>
              <label className="flex items-center justify-between gap-3 rounded-[10px] border border-[color:rgba(148,163,184,0.16)] bg-black/20 px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                <span>Focus on the active note neighborhood</span>
                <input
                  checked={localGraphEnabled}
                  onChange={(event) => setLocalGraphEnabled(event.target.checked)}
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--vk-accent)]"
                />
              </label>
              <label className="block text-[12px] text-[var(--vk-text-muted)]">
                <span className="flex items-center justify-between">
                  <span>Depth</span>
                  <span>{localDepth}</span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={localDepth}
                  onChange={(event) => setLocalDepth(Number(event.target.value))}
                  className={`${NOTES_GRAPH_RANGE_CLASS_NAME} mt-2`}
                />
              </label>
              <p className="rounded-[10px] border border-[color:rgba(148,163,184,0.12)] bg-black/10 px-3 py-2 text-[11px] leading-5 text-[var(--vk-text-muted)]">
                {effectiveLocalRootId
                  ? `Rooting around ${graphIndex.nodesById.get(effectiveLocalRootId)?.displayPath ?? effectiveLocalRootId}.`
                  : "Pick a note to use local graph depth controls."}
              </p>
            </section>

            <section className="mt-5 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">
                Display
              </p>
              <label className="flex items-center justify-between gap-3 rounded-[10px] border border-[color:rgba(148,163,184,0.16)] bg-black/20 px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                <span>Labels</span>
                <input
                  checked={showLabels}
                  onChange={(event) => setShowLabels(event.target.checked)}
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--vk-accent)]"
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-[10px] border border-[color:rgba(148,163,184,0.16)] bg-black/20 px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                <span>Arrows</span>
                <input
                  checked={showArrows}
                  onChange={(event) => setShowArrows(event.target.checked)}
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--vk-accent)]"
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-[10px] border border-[color:rgba(148,163,184,0.16)] bg-black/20 px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                <span>Show orphans</span>
                <input
                  checked={showOrphans}
                  onChange={(event) => setShowOrphans(event.target.checked)}
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--vk-accent)]"
                />
              </label>
              <label className="block text-[12px] text-[var(--vk-text-muted)]">
                <span className="flex items-center justify-between">
                  <span>Node size</span>
                  <span>{nodeSize.toFixed(0)}</span>
                </span>
                <input
                  type="range"
                  min={5}
                  max={14}
                  step={1}
                  value={nodeSize}
                  onChange={(event) => setNodeSize(Number(event.target.value))}
                  className={`${NOTES_GRAPH_RANGE_CLASS_NAME} mt-2`}
                />
              </label>
              <label className="block text-[12px] text-[var(--vk-text-muted)]">
                <span className="flex items-center justify-between">
                  <span>Link thickness</span>
                  <span>{linkThickness.toFixed(1)}</span>
                </span>
                <input
                  type="range"
                  min={0.6}
                  max={3}
                  step={0.1}
                  value={linkThickness}
                  onChange={(event) => setLinkThickness(Number(event.target.value))}
                  className={`${NOTES_GRAPH_RANGE_CLASS_NAME} mt-2`}
                />
              </label>
            </section>

            <section className="mt-5 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">
                Forces
              </p>
              <label className="block text-[12px] text-[var(--vk-text-muted)]">
                <span className="flex items-center justify-between">
                  <span>Link distance</span>
                  <span>{linkDistance.toFixed(0)}</span>
                </span>
                <input
                  type="range"
                  min={70}
                  max={220}
                  step={5}
                  value={linkDistance}
                  onChange={(event) => setLinkDistance(Number(event.target.value))}
                  className={`${NOTES_GRAPH_RANGE_CLASS_NAME} mt-2`}
                />
              </label>
              <label className="block text-[12px] text-[var(--vk-text-muted)]">
                <span className="flex items-center justify-between">
                  <span>Repel force</span>
                  <span>{repelForce.toFixed(0)}</span>
                </span>
                <input
                  type="range"
                  min={120}
                  max={460}
                  step={10}
                  value={repelForce}
                  onChange={(event) => setRepelForce(Number(event.target.value))}
                  className={`${NOTES_GRAPH_RANGE_CLASS_NAME} mt-2`}
                />
              </label>
              <label className="block text-[12px] text-[var(--vk-text-muted)]">
                <span className="flex items-center justify-between">
                  <span>Center force</span>
                  <span>{centerForce.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={0.02}
                  max={0.2}
                  step={0.01}
                  value={centerForce}
                  onChange={(event) => setCenterForce(Number(event.target.value))}
                  className={`${NOTES_GRAPH_RANGE_CLASS_NAME} mt-2`}
                />
              </label>
            </section>

            {focusedNode ? (
              <section className="mt-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--vk-text-muted)]">
                  Selected note
                </p>
                <div className="mt-2 rounded-[12px] border border-[color:rgba(148,163,184,0.16)] bg-black/25 p-3">
                  <p className="text-[13px] font-medium text-[var(--vk-text-strong)]">{focusedNode.name}</p>
                  <p className="mt-1 break-all text-[11px] text-[var(--vk-text-muted)]">{focusedNode.displayPath}</p>
                  <p className="mt-2 text-[11px] text-[var(--vk-text-muted)]">
                    {focusedNode.degree} connections{focusedNode.tags.length > 0 ? ` · #${focusedNode.tags.join(" #")}` : ""}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onNavigate(focusedNode.id)}
                      className="oc-mobile-touch-target inline-flex min-h-11 items-center gap-1.5 rounded-[8px] border border-[var(--vk-accent)] bg-[rgba(139,92,246,0.16)] px-3 text-[12px] text-[var(--vk-text-strong)] hover:bg-[rgba(139,92,246,0.22)] sm:min-h-[32px]"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      Open note
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFocusedNodeId(focusedNode.id);
                        setLocalGraphEnabled(true);
                      }}
                      className="oc-mobile-touch-target inline-flex min-h-11 items-center gap-1.5 rounded-[8px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] sm:min-h-[32px]"
                    >
                      <LocateFixed className="h-3.5 w-3.5" />
                      Use as local root
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
          </aside>
        ) : null}

        <div className="relative min-h-[420px] min-w-0 overflow-hidden rounded-[16px] border border-[color:rgba(148,163,184,0.14)] bg-[radial-gradient(circle_at_top,rgba(30,41,59,0.96),rgba(2,6,23,0.98))] shadow-[0_30px_90px_rgba(2,6,23,0.52)]">
          <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
            <span className="rounded-full border border-[color:rgba(148,163,184,0.16)] bg-black/30 px-2.5 py-1 text-[11px] text-[var(--vk-text-muted)]">
              {graphIndex.nodes.length} total notes
            </span>
            {localGraphEnabled ? (
              <span className="rounded-full border border-[color:rgba(139,92,246,0.24)] bg-[rgba(139,92,246,0.16)] px-2.5 py-1 text-[11px] text-[var(--vk-text-strong)]">
                Local graph depth {localDepth}
              </span>
            ) : null}
            {search ? (
              <span className="rounded-full border border-[color:rgba(56,189,248,0.24)] bg-[rgba(56,189,248,0.16)] px-2.5 py-1 text-[11px] text-[var(--vk-text-strong)]">
                Search: {search}
              </span>
            ) : null}
          </div>

          <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
            <button
              type="button"
              title="Zoom out"
              aria-label="Zoom out"
              onClick={() => zoomAtPoint(transform.k * 0.88)}
              className="oc-mobile-touch-target inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:rgba(148,163,184,0.16)] bg-black/35 text-[var(--vk-text-normal)] hover:bg-black/55 sm:h-9 sm:w-9"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Zoom in"
              aria-label="Zoom in"
              onClick={() => zoomAtPoint(transform.k * 1.12)}
              className="oc-mobile-touch-target inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:rgba(148,163,184,0.16)] bg-black/35 text-[var(--vk-text-normal)] hover:bg-black/55 sm:h-9 sm:w-9"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Fit graph"
              aria-label="Fit graph"
              onClick={() => setTransform(getFittedTransform(layout.nodes, viewport.width, viewport.height))}
              className="oc-mobile-touch-target inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:rgba(148,163,184,0.16)] bg-black/35 text-[var(--vk-text-normal)] hover:bg-black/55 sm:h-9 sm:w-9"
            >
              <LocateFixed className="h-4 w-4" />
            </button>
          </div>

          {compactGraphViewport ? null : (
            <div className="absolute bottom-3 left-3 z-10 rounded-[10px] border border-[color:rgba(148,163,184,0.14)] bg-black/35 px-3 py-2 text-[11px] leading-5 text-[var(--vk-text-muted)] backdrop-blur-sm">
              Hover to highlight neighbors, drag the canvas to pan, double-click a node to open its note.
            </div>
          )}

          <div ref={containerRef} className="h-full w-full touch-none">
            {visibleNodeCount === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[var(--vk-text-muted)]">
                No notes match the current graph filters. Clear the search or group filter to widen the graph.
              </div>
            ) : (
              <svg
                width="100%"
                height="100%"
                viewBox={`0 0 ${Math.max(viewport.width, 900)} ${Math.max(viewport.height, 620)}`}
                onPointerMove={handlePointerMove}
                onPointerUp={handleStopPan}
                onPointerCancel={handleStopPan}
                onWheel={handleWheel}
                className="h-full w-full"
              >
                <defs>
                  <marker
                    id="notes-graph-arrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(148,163,184,0.55)" />
                  </marker>
                  <filter id="notes-graph-node-glow" x="-120%" y="-120%" width="340%" height="340%">
                    <feGaussianBlur stdDeviation="3.4" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <rect
                  x={0}
                  y={0}
                  width="100%"
                  height="100%"
                  fill="transparent"
                  onPointerDown={handleStartPan}
                  onPointerUp={handleStopPan}
                  onPointerCancel={handleStopPan}
                />
                <g
                  transform={`translate(${Math.max(viewport.width, 900) / 2 + transform.x}, ${Math.max(viewport.height, 620) / 2 + transform.y}) scale(${transform.k})`}
                >
                  {layout.edges.map((edge) => {
                    const source = layout.nodes.find((node) => node.id === edge.source);
                    const target = layout.nodes.find((node) => node.id === edge.target);
                    if (!source || !target) return null;
                    const edgeHighlighted = !highlightedNodeIds
                      || (highlightedNodeIds.has(edge.source) && highlightedNodeIds.has(edge.target));
                    return (
                      <line
                        key={edge.id}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke="rgba(148,163,184,0.72)"
                        strokeOpacity={edgeHighlighted ? 0.58 : 0.12}
                        strokeWidth={linkThickness}
                        markerEnd={showArrows ? "url(#notes-graph-arrow)" : undefined}
                      />
                    );
                  })}
                  {layout.nodes.map((node) => {
                    const radius = getNodeRadius(node, nodeSize);
                    const color = groupColorById.get(node.folder) ?? NOTES_GRAPH_GROUP_COLORS[0];
                    const connectedToActive = !highlightedNodeIds || highlightedNodeIds.has(node.id);
                    const matchesSearch = searchMatches.size === 0 || searchMatches.has(node.id);
                    const selected = focusedNodeId === node.id;
                    const labelVisible = showLabels && (selected || hoveredNodeId === node.id || transform.k >= labelVisibilityThreshold);
                    return (
                      <g
                        key={node.id}
                        transform={`translate(${node.x}, ${node.y})`}
                        onClick={() => setFocusedNodeId(node.id)}
                        onDoubleClick={() => onNavigate(node.id)}
                        onMouseEnter={() => setHoveredNodeId(node.id)}
                        onMouseLeave={() => setHoveredNodeId(null)}
                        style={{ cursor: "pointer" }}
                      >
                        <circle
                          r={radius + 2}
                          fill={color}
                          opacity={connectedToActive ? 0.18 : 0.05}
                          filter="url(#notes-graph-node-glow)"
                        />
                        <circle
                          r={radius}
                          fill={color}
                          opacity={connectedToActive ? (matchesSearch ? 0.92 : 0.66) : 0.16}
                          stroke={selected ? "rgba(248,250,252,0.95)" : "rgba(15,23,42,0.9)"}
                          strokeWidth={selected ? 2.4 : 1.1}
                        />
                        {labelVisible ? (
                          <text
                            x={radius + 6}
                            y={4}
                            fontSize={11}
                            fill="rgba(226,232,240,0.94)"
                            style={{ pointerEvents: "none", userSelect: "none" }}
                          >
                            {node.displayPath}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                </g>
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
