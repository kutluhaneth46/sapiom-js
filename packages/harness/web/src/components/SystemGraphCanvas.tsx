import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { SystemGraph, WorkspaceKey } from "@shared/system-graph";

import type { HarnessApi } from "../lib/api";
import { orderSystemGraphNodes } from "../lib/system-graph";
import { EmptyState } from "./EmptyState";

const requests = new Map<WorkspaceKey, Promise<SystemGraph>>();

function loadSystemGraph(
  api: HarnessApi,
  workspaceKey: WorkspaceKey,
): Promise<SystemGraph> {
  const existing = requests.get(workspaceKey);
  if (existing) return existing;
  const request = api.getSystemGraph(workspaceKey);
  requests.set(workspaceKey, request);
  void request.catch(() => {
    if (requests.get(workspaceKey) === request) requests.delete(workspaceKey);
  });
  return request;
}

interface SystemGraphCanvasProps {
  workspaceKey: WorkspaceKey;
  api: HarnessApi;
}

export function SystemGraphCanvas({
  workspaceKey,
  api,
}: SystemGraphCanvasProps): JSX.Element {
  const [graph, setGraph] = useState<SystemGraph | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setGraph(null);
    setError(false);
    void loadSystemGraph(api, workspaceKey).then(
      (next) => {
        if (active) setGraph(next);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, workspaceKey, attempt]);

  if (error) {
    return (
      <EmptyState
        className="canvas-empty system-graph-state"
        testId="system-graph-error"
        icon="TriangleAlert"
        title="Couldn't load this workspace graph"
        body="The local projection failed. Retry the filesystem scan."
        cta={
          <button
            className="btn-primary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!graph) {
    return (
      <div
        className="canvas-loading system-graph-state"
        data-testid="system-graph-loading"
      >
        <span className="canvas-task-spinner" aria-hidden="true" />
        <p className="canvas-empty-hint">Loading workspace graph…</p>
      </div>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        className="canvas-empty system-graph-state"
        testId="system-graph-empty"
        icon="Frame"
        title="No agents in this workspace"
        body="Agent projects discovered inside this folder will appear here."
      />
    );
  }

  const width = 420;
  const cardWidth = 240;
  const cardHeight = 72;
  const cardX = (width - cardWidth) / 2;
  const top = 44;
  const gap = 76;
  const orderedNodes = orderSystemGraphNodes(graph);
  const positions = new Map(
    orderedNodes.map((node, index) => [
      node.id,
      { x: cardX, y: top + index * (cardHeight + gap) },
    ]),
  );
  const height = Math.max(
    320,
    top * 2 + graph.nodes.length * cardHeight + (graph.nodes.length - 1) * gap,
  );

  return (
    <div className="system-graph-canvas" data-testid="system-graph-canvas">
      <div className="system-graph-heading">
        <span>Workspace dependencies</span>
        <span>{graph.nodes.length} agents</span>
      </div>
      <div className="system-graph-scroll">
        <svg
          className="system-graph-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Workspace dependency graph"
        >
          <defs>
            <marker
              id="system-graph-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="system-graph-arrow" />
            </marker>
          </defs>

          {graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const startX = from.x + cardWidth / 2;
            const startY = from.y + cardHeight;
            const endX = to.x + cardWidth / 2;
            const endY = to.y;
            const middleY = (startY + endY) / 2;
            return (
              <g
                key={`${edge.from}-${edge.to}`}
                data-testid={`system-graph-edge-${edge.from}-${edge.to}`}
              >
                <path
                  className="system-graph-edge"
                  d={`M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY - 8}`}
                  markerEnd="url(#system-graph-arrow)"
                />
                <text
                  className="system-graph-edge-label"
                  x={startX + 12}
                  y={middleY + 4}
                >
                  invokes · static · async
                </text>
              </g>
            );
          })}

          {orderedNodes.map((node) => {
            const position = positions.get(node.id)!;
            return (
              <g
                key={node.id}
                className="system-graph-node"
                data-testid={`system-graph-node-${node.agentKey}`}
                transform={`translate(${position.x} ${position.y})`}
              >
                <rect width={cardWidth} height={cardHeight} rx="10" />
                <circle cx="24" cy="25" r="5" />
                <text className="system-graph-node-label" x="40" y="30">
                  {node.label}
                </text>
                <text className="system-graph-node-meta" x="40" y="50">
                  agent
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {graph.warnings.length > 0 && (
        <p className="system-graph-warning" data-testid="system-graph-warning">
          {graph.warnings.length} static projection{" "}
          {graph.warnings.length === 1 ? "warning" : "warnings"}
        </p>
      )}
    </div>
  );
}
