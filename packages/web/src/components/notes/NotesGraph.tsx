"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import type { GraphNode, GraphEdge } from "./types";
import { withBridgeQuery } from "@/lib/bridgeQuery";

interface NotesGraphProps {
  projectId: string;
  bridgeId?: string | null;
  onNavigate: (path: string) => void;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
}

const NODE_RADIUS = 6;
const NOTES_GRAPH_SURFACE_CLASS_NAME = "flex h-full min-h-[min(560px,70dvh)] flex-col overflow-hidden bg-[var(--vk-bg-main)] xl:min-h-0";
const COLORS = [
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#f59e0b", // amber
  "#10b981", // green
  "#ef4444", // red
  "#ec4899", // pink
  "#3b82f6", // blue
  "#f97316", // orange
];

function getNodeColor(path: string): string {
  const depth = path.split("/").length - 1;
  return COLORS[depth % COLORS.length];
}

export function NotesGraph({ projectId, bridgeId, onNavigate }: NotesGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [edges, setEdges] = useState<SimEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

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

      // Initialize node positions
      const simNodes: SimNode[] = graphData.nodes.map((n, i) => ({
        ...n,
        x: Math.cos((i / graphData.nodes.length) * 2 * Math.PI) * 200,
        y: Math.sin((i / graphData.nodes.length) * 2 * Math.PI) * 200,
      }));

      const simEdges: SimEdge[] = graphData.edges.map((e) => ({
        source: e.source,
        target: e.target,
      }));

      setNodes(simNodes);
      setEdges(simEdges);

      // Run simulation
      const simulation = forceSimulation<SimNode>(simNodes)
        .force(
          "link",
          forceLink<SimNode, SimEdge>(simEdges)
            .id((d) => d.id)
            .distance(80),
        )
        .force("charge", forceManyBody().strength(-120))
        .force("center", forceCenter(0, 0))
        .force("collide", forceCollide(NODE_RADIUS * 2.5))
        .stop();

      // Run synchronously for 300 ticks
      for (let i = 0; i < 300; i++) {
        simulation.tick();
      }

      setNodes([...simNodes]);
      setEdges([...simEdges]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
    } finally {
      setLoading(false);
    }
  }, [bridgeId, projectId]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button === 0) {
        isPanning.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
    },
    [],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (isPanning.current) {
        const dx = e.clientX - lastMouse.current.x;
        const dy = e.clientY - lastMouse.current.y;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        setTransform((prev) => ({
          x: prev.x + dx,
          y: prev.y + dy,
          k: prev.k,
        }));
      }
    },
    [],
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform((prev) => ({
      x: prev.x,
      y: prev.y,
      k: Math.max(0.2, Math.min(4, prev.k * delta)),
    }));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
        Loading graph…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-red)]">
        {error}
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        No notes to graph
      </div>
    );
  }

  const svgWidth = 800;
  const svgHeight = 600;
  const centerX = svgWidth / 2 + transform.x;
  const centerY = svgHeight / 2 + transform.y;

  return (
    <div className={NOTES_GRAPH_SURFACE_CLASS_NAME}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--vk-border)] px-4 py-2">
        <span className="text-[12px] text-[var(--vk-text-muted)]">
          {nodes.length} notes · {edges.length} links
        </span>
        <button
          type="button"
          onClick={() => void fetchGraph()}
          className="text-[12px] text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]"
        >
          Refresh
        </button>
      </div>

      {/* SVG */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{ cursor: isPanning.current ? "grabbing" : "grab" }}
        >
          <g transform={`translate(${centerX}, ${centerY}) scale(${transform.k})`}>
            {/* Edges */}
            {edges.map((edge, idx) => {
              const source = typeof edge.source === "object" ? edge.source : null;
              const target = typeof edge.target === "object" ? edge.target : null;
              if (!source || !target) return null;
              return (
                <line
                  key={`edge-${idx}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="var(--vk-border)"
                  strokeWidth={1}
                  opacity={0.6}
                />
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const color = getNodeColor(node.id);
              const isHovered = hoveredNode === node.id;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  onClick={() => onNavigate(node.id)}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                  style={{ cursor: "pointer" }}
                >
                  <circle
                    r={isHovered ? NODE_RADIUS * 1.5 : NODE_RADIUS}
                    fill={color}
                    stroke={isHovered ? "var(--vk-text-strong)" : "transparent"}
                    strokeWidth={isHovered ? 2 : 0}
                    opacity={0.85}
                  />
                  {(isHovered || transform.k > 1.2) && (
                    <text
                      x={NODE_RADIUS + 4}
                      y={4}
                      fontSize={10}
                      fill="var(--vk-text-normal)"
                      style={{ pointerEvents: "none" }}
                    >
                      {node.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
