import { describe, expect, it } from "vitest";
import type {
  AgentInvocationMode,
  SystemGraph,
  SystemGraphEdge,
} from "@shared/system-graph";

import {
  SYSTEM_GRAPH_NODE_HEIGHT,
  SYSTEM_GRAPH_NODE_WIDTH,
  layoutSystemGraph,
  type SystemGraphLayout,
} from "./system-graph-layout";

const node = (id: string) => ({ id, agentKey: id, label: id.toUpperCase() });
const edge = (
  from: string,
  to: string,
  mode: AgentInvocationMode = "blocking",
): SystemGraphEdge => ({
  from,
  to,
  kind: "invokes",
  basis: "static-invocation",
  mode,
});

function graph(nodeIds: string[], edges: SystemGraphEdge[]): SystemGraph {
  return {
    kind: "system",
    scope: { kind: "working-tree", workspaceKey: "workspace-test" },
    nodes: nodeIds.map(node),
    edges,
    warnings: [],
  };
}

function byId(layout: SystemGraphLayout, id: string) {
  const placed = layout.nodes.find((candidate) => candidate.id === id);
  if (!placed) throw new Error(`Missing layout node ${id}`);
  return placed;
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function expectNodesNotToOverlap(layout: SystemGraphLayout): void {
  for (let left = 0; left < layout.nodes.length; left += 1) {
    for (let right = left + 1; right < layout.nodes.length; right += 1) {
      expect(
        rectanglesOverlap(layout.nodes[left]!, layout.nodes[right]!),
        `${layout.nodes[left]!.id} overlaps ${layout.nodes[right]!.id}`,
      ).toBe(false);
    }
  }
}

function expectEdgesNotToCrossCards(layout: SystemGraphLayout): void {
  for (const routed of layout.edges) {
    for (let index = 1; index < routed.points.length; index += 1) {
      const start = routed.points[index - 1]!;
      const end = routed.points[index]!;
      for (const placed of layout.nodes) {
        const crossesHorizontalInterior =
          start.y === end.y &&
          start.y > placed.y &&
          start.y < placed.y + placed.height &&
          Math.max(start.x, end.x) > placed.x &&
          Math.min(start.x, end.x) < placed.x + placed.width;
        const crossesVerticalInterior =
          start.x === end.x &&
          start.x > placed.x &&
          start.x < placed.x + placed.width &&
          Math.max(start.y, end.y) > placed.y &&
          Math.min(start.y, end.y) < placed.y + placed.height;
        expect(
          crossesHorizontalInterior || crossesVerticalInterior,
          `${routed.from} -> ${routed.to} crosses ${placed.id}`,
        ).toBe(false);
      }
    }
  }
}

describe("layoutSystemGraph", () => {
  it("ranks a direct chain strictly from left to right", () => {
    const layout = layoutSystemGraph(
      graph(["c", "a", "b"], [edge("a", "b"), edge("b", "c")]),
    );

    expect(byId(layout, "a").x).toBeLessThan(byId(layout, "b").x);
    expect(byId(layout, "b").x).toBeLessThan(byId(layout, "c").x);
  });

  it("keeps fan-out targets together and fan-in targets after every caller", () => {
    const fanOut = layoutSystemGraph(
      graph(
        ["source", "left", "right"],
        [edge("source", "left"), edge("source", "right", "async")],
      ),
    );
    expect(byId(fanOut, "left").x).toBe(byId(fanOut, "right").x);
    expect(byId(fanOut, "source").x).toBeLessThan(byId(fanOut, "left").x);

    const fanIn = layoutSystemGraph(
      graph(
        ["target", "left", "right"],
        [edge("left", "target"), edge("right", "target")],
      ),
    );
    expect(byId(fanIn, "target").x).toBeGreaterThan(byId(fanIn, "left").x);
    expect(byId(fanIn, "target").x).toBeGreaterThan(byId(fanIn, "right").x);
  });

  it("condenses cycles, routes their return edges, and ranks downstream SCCs later", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c", "downstream"],
        [
          edge("a", "b"),
          edge("b", "c", "async"),
          edge("c", "a"),
          edge("c", "downstream"),
        ],
      ),
    );

    expect(byId(layout, "a").x).toBe(byId(layout, "b").x);
    expect(byId(layout, "b").x).toBe(byId(layout, "c").x);
    expect(byId(layout, "downstream").x).toBeGreaterThan(byId(layout, "c").x);
    expect(
      layout.edges.filter((candidate) => candidate.route === "cycle"),
    ).toHaveLength(3);
    expect(
      layout.edges.every((candidate) => !candidate.path.includes("NaN")),
    ).toBe(true);
    expectEdgesNotToCrossCards(layout);
  });

  it("keeps disconnected components and isolated agents exactly once", () => {
    const layout = layoutSystemGraph(
      graph(["isolated", "a", "b", "x", "y"], [edge("a", "b"), edge("x", "y")]),
    );

    expect(layout.nodes.map((candidate) => candidate.id).sort()).toEqual([
      "a",
      "b",
      "isolated",
      "x",
      "y",
    ]);
    expect(
      new Set(layout.nodes.map((candidate) => candidate.componentId)).size,
    ).toBe(3);
    expectNodesNotToOverlap(layout);
  });

  it("groups dual-mode records into one connector with stable mode semantics", () => {
    const layout = layoutSystemGraph(
      graph(
        ["caller", "target"],
        [
          edge("caller", "target", "async"),
          edge("caller", "target", "blocking"),
          edge("caller", "target", "async"),
        ],
      ),
    );

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({
      from: "caller",
      to: "target",
      modes: ["blocking", "async"],
      label: "blocking + async",
      route: "forward",
    });
  });

  it("stagger ports, lands arrows at card borders, and keeps label boxes off cards", () => {
    const layout = layoutSystemGraph(
      graph(
        ["source", "one", "two", "three"],
        [
          edge("source", "one"),
          edge("source", "two", "async"),
          edge("source", "three"),
        ],
      ),
    );
    const sourcePorts = layout.edges.map((candidate) => candidate.points[0]!.y);
    expect(new Set(sourcePorts).size).toBe(sourcePorts.length);

    for (const routed of layout.edges) {
      const target = byId(layout, routed.to);
      const end = routed.points.at(-1)!;
      expect(end.x).toBe(target.x - 1);
      expect(end.y).toBeGreaterThanOrEqual(target.y);
      expect(end.y).toBeLessThanOrEqual(target.y + target.height);
      for (const placed of layout.nodes) {
        expect(
          rectanglesOverlap(routed.labelBounds, placed),
          `${routed.label} overlaps ${placed.id}`,
        ).toBe(false);
      }
    }
  });

  it("routes rank-skipping connectors outside intermediate cards", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c", "side"],
        [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("side", "c")],
      ),
    );

    expect(byId(layout, "c").x).toBeGreaterThan(byId(layout, "b").x);
    expectEdgesNotToCrossCards(layout);
  });

  it("returns fixed card geometry and bounds containing every routed primitive", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c"],
        [edge("a", "b"), edge("b", "a", "async"), edge("b", "c")],
      ),
    );
    expectNodesNotToOverlap(layout);
    expectEdgesNotToCrossCards(layout);

    for (const placed of layout.nodes) {
      expect(placed.width).toBe(SYSTEM_GRAPH_NODE_WIDTH);
      expect(placed.height).toBe(SYSTEM_GRAPH_NODE_HEIGHT);
      expect(placed.x).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeGreaterThanOrEqual(0);
      expect(placed.x + placed.width).toBeLessThanOrEqual(layout.bounds.width);
      expect(placed.y + placed.height).toBeLessThanOrEqual(
        layout.bounds.height,
      );
    }
    for (const routed of layout.edges) {
      for (const point of routed.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(layout.bounds.width);
        expect(point.y).toBeLessThanOrEqual(layout.bounds.height);
      }
      expect(routed.labelBounds.x).toBeGreaterThanOrEqual(0);
      expect(routed.labelBounds.y).toBeGreaterThanOrEqual(0);
      expect(
        routed.labelBounds.x + routed.labelBounds.width,
      ).toBeLessThanOrEqual(layout.bounds.width);
      expect(
        routed.labelBounds.y + routed.labelBounds.height,
      ).toBeLessThanOrEqual(layout.bounds.height);
    }
  });

  it("is deeply deterministic when node and edge input order changes", () => {
    const edges = [
      edge("a", "b"),
      edge("a", "c", "async"),
      edge("c", "a"),
      edge("d", "e"),
    ];
    const forward = layoutSystemGraph(
      graph(["a", "b", "c", "d", "e", "z"], edges),
    );
    const reversed = layoutSystemGraph(
      graph(["z", "e", "d", "c", "b", "a"], [...edges].reverse()),
    );

    expect(reversed).toEqual(forward);
  });

  it("fails closed for malformed endpoint geometry instead of hanging", () => {
    expect(() =>
      layoutSystemGraph(graph(["known"], [edge("known", "missing")])),
    ).toThrow("Invalid system graph layout input");
  });
});
