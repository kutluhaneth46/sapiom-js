import type {
  AgentInvocationMode,
  SystemGraph,
  SystemGraphNode,
} from "@shared/system-graph";

import {
  groupSystemGraphEdges,
  type VisibleSystemGraphEdge,
} from "./system-graph";

export const SYSTEM_GRAPH_NODE_WIDTH = 184;
export const SYSTEM_GRAPH_NODE_HEIGHT = 64;
export const SYSTEM_GRAPH_RANK_GAP = 48;
export const SYSTEM_GRAPH_SLOT_GAP = 12;

const COMPONENT_GAP = 64;
const LAYOUT_PADDING = 32;
const PORT_LIMIT = 24;
const PORT_STEP = 8;
const LABEL_HEIGHT = 16;

export interface SystemGraphPoint {
  x: number;
  y: number;
}

export interface SystemGraphLayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  componentId: string;
}

export interface SystemGraphLabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SystemGraphLayoutEdge {
  from: string;
  to: string;
  modes: AgentInvocationMode[];
  path: string;
  points: SystemGraphPoint[];
  label: string;
  labelX: number;
  labelY: number;
  labelBounds: SystemGraphLabelBounds;
  route: "forward" | "cycle";
}

export interface SystemGraphLayout {
  nodes: SystemGraphLayoutNode[];
  edges: SystemGraphLayoutEdge[];
  bounds: { width: number; height: number };
}

export interface SystemGraphStrongComponent {
  id: string;
  nodeIds: string[];
  rank: number;
}

export interface SystemGraphWeakComponent {
  id: string;
  nodeIds: string[];
  stronglyConnected: SystemGraphStrongComponent[];
  connected: boolean;
}

export interface SystemGraphTopology {
  components: SystemGraphWeakComponent[];
}

interface WorkGuard {
  step(): void;
}

interface ComponentBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface EdgeSeed {
  edge: VisibleSystemGraphEdge;
  route: "forward" | "cycle";
  componentId: string;
  sourceOffset: number;
  targetOffset: number;
  cycleLane: number;
  forwardLane: number;
}

interface RoutedEdge extends EdgeSeed {
  points: SystemGraphPoint[];
  label: string;
  labelX: number;
  labelY: number;
  labelBounds: SystemGraphLabelBounds;
}

const compareIds = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const round = (value: number): number => Math.round(value * 100) / 100;

function makeGuard(nodeCount: number, edgeCount: number): WorkGuard {
  const limit = Math.max(128, (nodeCount + edgeCount + 1) * 96);
  let work = 0;
  return {
    step(): void {
      work += 1;
      if (work > limit) {
        throw new Error("System graph layout exceeded its finite work budget");
      }
    },
  };
}

function validateGraph(graph: SystemGraph): void {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || ids.has(node.id)) {
      throw new Error("Invalid system graph layout input");
    }
    ids.add(node.id);
  }
  if (graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) {
    throw new Error("Invalid system graph layout input");
  }
}

function sortedAdjacency(
  nodeIds: readonly string[],
  edges: readonly VisibleSystemGraphEdge[],
): {
  directed: Map<string, string[]>;
  undirected: Map<string, string[]>;
} {
  const directedSets = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  const undirectedSets = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    directedSets.get(edge.from)!.add(edge.to);
    undirectedSets.get(edge.from)!.add(edge.to);
    undirectedSets.get(edge.to)!.add(edge.from);
  }
  const toSorted = (sets: Map<string, Set<string>>): Map<string, string[]> =>
    new Map(
      [...sets.entries()].map(([id, values]) => [
        id,
        [...values].sort(compareIds),
      ]),
    );
  return {
    directed: toSorted(directedSets),
    undirected: toSorted(undirectedSets),
  };
}

function findWeakComponents(
  nodeIds: readonly string[],
  undirected: ReadonlyMap<string, readonly string[]>,
  guard: WorkGuard,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of nodeIds) {
    guard.step();
    if (visited.has(start)) continue;
    const members: string[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      guard.step();
      const id = queue.shift()!;
      members.push(id);
      for (const neighbor of undirected.get(id) ?? []) {
        guard.step();
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    members.sort(compareIds);
    components.push(members);
  }
  return components;
}

function findStrongComponents(
  members: readonly string[],
  directed: ReadonlyMap<string, readonly string[]>,
  guard: WorkGuard,
): string[][] {
  const memberSet = new Set(members);
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string): void => {
    guard.step();
    indexById.set(id, nextIndex);
    lowById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of directed.get(id) ?? []) {
      guard.step();
      if (!memberSet.has(target)) continue;
      if (!indexById.has(target)) {
        visit(target);
        lowById.set(id, Math.min(lowById.get(id)!, lowById.get(target)!));
      } else if (onStack.has(target)) {
        lowById.set(id, Math.min(lowById.get(id)!, indexById.get(target)!));
      }
    }

    if (lowById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      guard.step();
      const popped = stack.pop()!;
      onStack.delete(popped);
      component.push(popped);
      if (popped === id) break;
    }
    component.sort(compareIds);
    result.push(component);
  };

  for (const id of members) {
    if (!indexById.has(id)) visit(id);
  }
  return result.sort((left, right) => compareIds(left[0]!, right[0]!));
}

function rankStrongComponents(
  strong: readonly string[][],
  edges: readonly VisibleSystemGraphEdge[],
  guard: WorkGuard,
): SystemGraphStrongComponent[] {
  const strongIds = strong.map((members) => `scc:${members[0]}`);
  const strongByNode = new Map<string, string>();
  strong.forEach((members, index) => {
    for (const id of members) strongByNode.set(id, strongIds[index]!);
  });
  const outgoing = new Map(strongIds.map((id) => [id, new Set<string>()]));
  const indegree = new Map(strongIds.map((id) => [id, 0]));
  for (const edge of edges) {
    guard.step();
    const from = strongByNode.get(edge.from);
    const to = strongByNode.get(edge.to);
    if (!from || !to || from === to || outgoing.get(from)!.has(to)) continue;
    outgoing.get(from)!.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const rank = new Map(strongIds.map((id) => [id, 0]));
  const ready = strongIds
    .filter((id) => indegree.get(id) === 0)
    .sort(compareIds);
  let visited = 0;
  while (ready.length > 0) {
    guard.step();
    const id = ready.shift()!;
    visited += 1;
    for (const target of [...outgoing.get(id)!].sort(compareIds)) {
      guard.step();
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(compareIds);
      }
    }
  }
  if (visited !== strong.length) {
    throw new Error("System graph SCC condensation was not acyclic");
  }
  return strong
    .map((nodeIds, index) => ({
      id: strongIds[index]!,
      nodeIds: [...nodeIds],
      rank: rank.get(strongIds[index]!)!,
    }))
    .sort(
      (left, right) => left.rank - right.rank || compareIds(left.id, right.id),
    );
}

export function analyzeSystemGraph(graph: SystemGraph): SystemGraphTopology {
  validateGraph(graph);
  const edges = groupSystemGraphEdges(graph.edges);
  const nodeIds = graph.nodes.map((node) => node.id).sort(compareIds);
  const guard = makeGuard(nodeIds.length, edges.length);
  const { directed, undirected } = sortedAdjacency(nodeIds, edges);
  const weak = findWeakComponents(nodeIds, undirected, guard);
  const components = weak.map((members): SystemGraphWeakComponent => {
    const memberSet = new Set(members);
    const componentEdges = edges.filter(
      (edge) => memberSet.has(edge.from) && memberSet.has(edge.to),
    );
    const stronglyConnected = rankStrongComponents(
      findStrongComponents(members, directed, guard),
      componentEdges,
      guard,
    );
    return {
      id: `component:${members[0]}`,
      nodeIds: [...members],
      stronglyConnected,
      connected: componentEdges.length > 0,
    };
  });
  components.sort(
    (left, right) =>
      Number(right.connected) - Number(left.connected) ||
      compareIds(left.id, right.id),
  );
  return { components };
}

function placeNodes(topology: SystemGraphTopology): {
  nodes: SystemGraphLayoutNode[];
  componentBoxes: Map<string, ComponentBox>;
  componentByNode: Map<string, string>;
  strongByNode: Map<string, string>;
} {
  const nodes: SystemGraphLayoutNode[] = [];
  const componentBoxes = new Map<string, ComponentBox>();
  const componentByNode = new Map<string, string>();
  const strongByNode = new Map<string, string>();
  let yCursor = 0;

  for (const component of topology.components) {
    const byRank = new Map<number, string[]>();
    for (const strong of component.stronglyConnected) {
      const rankNodes = byRank.get(strong.rank) ?? [];
      rankNodes.push(...strong.nodeIds);
      rankNodes.sort(compareIds);
      byRank.set(strong.rank, rankNodes);
      for (const id of strong.nodeIds) {
        strongByNode.set(id, strong.id);
        componentByNode.set(id, component.id);
      }
    }
    const ranks = [...byRank.keys()].sort((left, right) => left - right);
    const rankHeight = (rank: number): number => {
      const count = byRank.get(rank)!.length;
      return (
        count * SYSTEM_GRAPH_NODE_HEIGHT +
        Math.max(0, count - 1) * SYSTEM_GRAPH_SLOT_GAP
      );
    };
    const componentHeight = Math.max(
      SYSTEM_GRAPH_NODE_HEIGHT,
      ...ranks.map(rankHeight),
    );
    for (const rank of ranks) {
      const rankNodes = byRank.get(rank)!;
      const startY = yCursor + (componentHeight - rankHeight(rank)) / 2;
      rankNodes.forEach((id, row) => {
        nodes.push({
          id,
          x: rank * (SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_RANK_GAP),
          y: startY + row * (SYSTEM_GRAPH_NODE_HEIGHT + SYSTEM_GRAPH_SLOT_GAP),
          width: SYSTEM_GRAPH_NODE_WIDTH,
          height: SYSTEM_GRAPH_NODE_HEIGHT,
          componentId: component.id,
        });
      });
    }
    const componentNodes = nodes.filter(
      (candidate) => candidate.componentId === component.id,
    );
    componentBoxes.set(component.id, {
      minX: Math.min(...componentNodes.map((candidate) => candidate.x)),
      minY: Math.min(...componentNodes.map((candidate) => candidate.y)),
      maxX: Math.max(
        ...componentNodes.map((candidate) => candidate.x + candidate.width),
      ),
      maxY: Math.max(
        ...componentNodes.map((candidate) => candidate.y + candidate.height),
      ),
    });
    yCursor += componentHeight + COMPONENT_GAP;
  }
  nodes.sort((left, right) => compareIds(left.id, right.id));
  return { nodes, componentBoxes, componentByNode, strongByNode };
}

function spreadPortOffsets(
  seeds: EdgeSeed[],
  nodeById: ReadonlyMap<string, SystemGraphLayoutNode>,
  end: "source" | "target",
): void {
  const groups = new Map<string, EdgeSeed[]>();
  for (const seed of seeds) {
    const nodeId = end === "source" ? seed.edge.from : seed.edge.to;
    const side = end === "source" || seed.route === "cycle" ? "right" : "left";
    const key = `${nodeId}:${side}`;
    groups.set(key, [...(groups.get(key) ?? []), seed]);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const leftOther = nodeById.get(
        end === "source" ? left.edge.to : left.edge.from,
      )!;
      const rightOther = nodeById.get(
        end === "source" ? right.edge.to : right.edge.from,
      )!;
      return (
        leftOther.y - rightOther.y ||
        leftOther.x - rightOther.x ||
        compareIds(left.edge.from, right.edge.from) ||
        compareIds(left.edge.to, right.edge.to)
      );
    });
    const step =
      group.length <= 1
        ? 0
        : Math.min(PORT_STEP, (PORT_LIMIT * 2) / (group.length - 1));
    group.forEach((seed, index) => {
      const offset = round((index - (group.length - 1) / 2) * step);
      if (end === "source") seed.sourceOffset = offset;
      else seed.targetOffset = offset;
    });
  }
}

function labelForModes(modes: readonly AgentInvocationMode[]): string {
  return modes.length === 2 ? "blocking + async" : modes[0]!;
}

function labelWidth(label: string): number {
  return Math.max(40, label.length * 6.5 + 8);
}

function overlaps(
  left: SystemGraphLabelBounds,
  right: SystemGraphLabelBounds,
  margin = 0,
): boolean {
  return !(
    left.x + left.width + margin <= right.x ||
    right.x + right.width + margin <= left.x ||
    left.y + left.height + margin <= right.y ||
    right.y + right.height + margin <= left.y
  );
}

function chooseLabelBounds(
  routed: Omit<RoutedEdge, "labelX" | "labelY" | "labelBounds">,
  nodeById: ReadonlyMap<string, SystemGraphLayoutNode>,
  allNodes: readonly SystemGraphLayoutNode[],
  existing: readonly SystemGraphLabelBounds[],
  componentBox: ComponentBox,
): SystemGraphLabelBounds {
  const source = nodeById.get(routed.edge.from)!;
  const target = nodeById.get(routed.edge.to)!;
  const width = labelWidth(routed.label);
  const start = routed.points[0]!;
  const end = routed.points.at(-1)!;
  const middleX = (start.x + end.x) / 2;
  const top = Math.min(source.y, target.y);
  const bottom = Math.max(source.y + source.height, target.y + target.height);
  const corridorX = routed.points[1]?.x ?? middleX;
  const targetLabelX =
    routed.route === "cycle"
      ? target.x + target.width / 2
      : target.x - width / 2 - 8;
  const candidates: SystemGraphPoint[] = [
    { x: targetLabelX, y: target.y - LABEL_HEIGHT / 2 - 4 },
    { x: targetLabelX, y: target.y + target.height + LABEL_HEIGHT / 2 + 4 },
    { x: corridorX, y: top - LABEL_HEIGHT / 2 - 4 },
    { x: corridorX, y: bottom + LABEL_HEIGHT / 2 + 4 },
    { x: middleX, y: top - LABEL_HEIGHT / 2 - 4 },
    { x: middleX, y: bottom + LABEL_HEIGHT / 2 + 4 },
  ];
  const nodeBounds = allNodes.map(
    (node): SystemGraphLabelBounds => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }),
  );
  const available = candidates
    .map(
      (center): SystemGraphLabelBounds => ({
        x: center.x - width / 2,
        y: center.y - LABEL_HEIGHT / 2,
        width,
        height: LABEL_HEIGHT,
      }),
    )
    .find(
      (candidate) =>
        !nodeBounds.some((node) => overlaps(candidate, node, 2)) &&
        !existing.some((label) => overlaps(candidate, label, 2)),
    );
  if (available) return available;

  const centerX = (componentBox.minX + componentBox.maxX - width) / 2;
  const fallbackSlots = (allNodes.length + existing.length + 1) * 6;
  for (let slot = 0; slot < fallbackSlots; slot += 1) {
    for (const y of [
      componentBox.minY - LABEL_HEIGHT - 8 - slot * (LABEL_HEIGHT + 4),
      componentBox.maxY + 8 + slot * (LABEL_HEIGHT + 4),
    ]) {
      const candidate = { x: centerX, y, width, height: LABEL_HEIGHT };
      if (
        !nodeBounds.some((node) => overlaps(candidate, node, 2)) &&
        !existing.some((label) => overlaps(candidate, label, 2))
      ) {
        return candidate;
      }
    }
  }
  throw new Error("System graph labels exceeded their finite placement budget");
}

function routeEdges(
  graph: SystemGraph,
  nodes: SystemGraphLayoutNode[],
  componentBoxes: ReadonlyMap<string, ComponentBox>,
  componentByNode: ReadonlyMap<string, string>,
  strongByNode: ReadonlyMap<string, string>,
): RoutedEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const seeds: EdgeSeed[] = groupSystemGraphEdges(graph.edges).map((edge) => {
    const componentId = componentByNode.get(edge.from)!;
    return {
      edge,
      route:
        strongByNode.get(edge.from) === strongByNode.get(edge.to)
          ? "cycle"
          : "forward",
      componentId,
      sourceOffset: 0,
      targetOffset: 0,
      cycleLane: 0,
      forwardLane: 0,
    };
  });
  spreadPortOffsets(seeds, nodeById, "source");
  spreadPortOffsets(seeds, nodeById, "target");
  const cycleGroups = new Map<string, EdgeSeed[]>();
  for (const seed of seeds.filter((candidate) => candidate.route === "cycle")) {
    const key = strongByNode.get(seed.edge.from)!;
    cycleGroups.set(key, [...(cycleGroups.get(key) ?? []), seed]);
  }
  for (const group of cycleGroups.values()) {
    group
      .sort(
        (left, right) =>
          compareIds(left.edge.from, right.edge.from) ||
          compareIds(left.edge.to, right.edge.to),
      )
      .forEach((seed, index) => {
        seed.cycleLane = index;
      });
  }

  const longForwardGroups = new Map<string, EdgeSeed[]>();
  for (const seed of seeds.filter((candidate) => {
    if (candidate.route !== "forward") return false;
    const source = nodeById.get(candidate.edge.from)!;
    const target = nodeById.get(candidate.edge.to)!;
    return (
      target.x - source.x > SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_RANK_GAP
    );
  })) {
    longForwardGroups.set(seed.componentId, [
      ...(longForwardGroups.get(seed.componentId) ?? []),
      seed,
    ]);
  }
  for (const group of longForwardGroups.values()) {
    group
      .sort(
        (left, right) =>
          compareIds(left.edge.from, right.edge.from) ||
          compareIds(left.edge.to, right.edge.to),
      )
      .forEach((seed, index) => {
        seed.forwardLane = index;
      });
  }

  const labels: SystemGraphLabelBounds[] = [];
  return seeds.map((seed): RoutedEdge => {
    const source = nodeById.get(seed.edge.from)!;
    const target = nodeById.get(seed.edge.to)!;
    const start = {
      x: source.x + source.width,
      y: source.y + source.height / 2 + seed.sourceOffset,
    };
    let points: SystemGraphPoint[];
    if (seed.route === "forward") {
      const end = {
        x: target.x - 1,
        y: target.y + target.height / 2 + seed.targetOffset,
      };
      const skipsRank =
        target.x - source.x > SYSTEM_GRAPH_NODE_WIDTH + SYSTEM_GRAPH_RANK_GAP;
      if (skipsRank) {
        // Crossing an occupied intermediate rank would draw through a card.
        // Reserve a quiet corridor just above this weak component instead;
        // modulo keeps even dense graphs inside the inter-component gutter.
        const lane = seed.forwardLane % 5;
        const sourceGutterX = source.x + source.width + 8 + lane * 4;
        const targetGutterX = target.x - 8 - lane * 4;
        const corridorY =
          componentBoxes.get(seed.componentId)!.minY - 12 - lane * 4;
        points = [
          start,
          { x: sourceGutterX, y: start.y },
          { x: sourceGutterX, y: corridorY },
          { x: targetGutterX, y: corridorY },
          { x: targetGutterX, y: end.y },
          end,
        ];
      } else {
        const elbowX = round(start.x + (target.x - start.x) * 0.32);
        points = [
          start,
          { x: elbowX, y: start.y },
          { x: elbowX, y: end.y },
          end,
        ];
      }
    } else {
      const endY =
        source.id === target.id && seed.targetOffset === seed.sourceOffset
          ? target.y + target.height / 2 - 12
          : target.y + target.height / 2 + seed.targetOffset;
      const end = { x: target.x + target.width + 1, y: endY };
      const gutterX =
        Math.max(source.x + source.width, target.x + target.width) +
        8 +
        (seed.cycleLane % 10) * 4;
      if (source.id === target.id) {
        const loopY = target.y - 12 - Math.floor(seed.cycleLane / 10) * 8;
        points = [
          start,
          { x: gutterX, y: start.y },
          { x: gutterX, y: loopY },
          { x: target.x + target.width + 4, y: loopY },
          { x: target.x + target.width + 4, y: end.y },
          end,
        ];
      } else {
        points = [
          start,
          { x: gutterX, y: start.y },
          { x: gutterX, y: end.y },
          end,
        ];
      }
    }
    points = points.map((point) => ({ x: round(point.x), y: round(point.y) }));
    const label = labelForModes(seed.edge.modes);
    const partial = { ...seed, points, label };
    const labelBounds = chooseLabelBounds(
      partial,
      nodeById,
      nodes,
      labels,
      componentBoxes.get(seed.componentId)!,
    );
    labels.push(labelBounds);
    return {
      ...partial,
      labelBounds,
      labelX: round(labelBounds.x + labelBounds.width / 2),
      labelY: round(labelBounds.y + labelBounds.height - 3),
    };
  });
}

function pathFromPoints(points: readonly SystemGraphPoint[]): string {
  if (points.length === 0) return "";
  const parts = [`M ${round(points[0]!.x)} ${round(points[0]!.y)}`];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    if (point.y === previous.y) parts.push(`H ${round(point.x)}`);
    else if (point.x === previous.x) parts.push(`V ${round(point.y)}`);
    else parts.push(`L ${round(point.x)} ${round(point.y)}`);
  }
  return parts.join(" ");
}

function shiftLayout(
  nodes: SystemGraphLayoutNode[],
  edges: RoutedEdge[],
): SystemGraphLayout {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const node of nodes) {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  }
  for (const edge of edges) {
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
    xs.push(edge.labelBounds.x, edge.labelBounds.x + edge.labelBounds.width);
    ys.push(edge.labelBounds.y, edge.labelBounds.y + edge.labelBounds.height);
  }
  if (xs.length === 0 || ys.length === 0) {
    return { nodes: [], edges: [], bounds: { width: 0, height: 0 } };
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const dx = LAYOUT_PADDING - minX;
  const dy = LAYOUT_PADDING - minY;
  const shiftedNodes = nodes.map((node) => ({
    ...node,
    x: round(node.x + dx),
    y: round(node.y + dy),
  }));
  const shiftedEdges = edges.map((edge): SystemGraphLayoutEdge => {
    const points = edge.points.map((point) => ({
      x: round(point.x + dx),
      y: round(point.y + dy),
    }));
    const labelBounds = {
      ...edge.labelBounds,
      x: round(edge.labelBounds.x + dx),
      y: round(edge.labelBounds.y + dy),
    };
    return {
      from: edge.edge.from,
      to: edge.edge.to,
      modes: [...edge.edge.modes],
      path: pathFromPoints(points),
      points,
      label: edge.label,
      labelX: round(edge.labelX + dx),
      labelY: round(edge.labelY + dy),
      labelBounds,
      route: edge.route,
    };
  });
  return {
    nodes: shiftedNodes,
    edges: shiftedEdges,
    bounds: {
      width: round(maxX - minX + LAYOUT_PADDING * 2),
      height: round(maxY - minY + LAYOUT_PADDING * 2),
    },
  };
}

export function layoutSystemGraph(graph: SystemGraph): SystemGraphLayout {
  const topology = analyzeSystemGraph(graph);
  if (graph.nodes.length === 0) {
    return { nodes: [], edges: [], bounds: { width: 0, height: 0 } };
  }
  const placed = placeNodes(topology);
  const edges = routeEdges(
    graph,
    placed.nodes,
    placed.componentBoxes,
    placed.componentByNode,
    placed.strongByNode,
  );
  return shiftLayout(placed.nodes, edges);
}

export function systemGraphNodeById(
  graph: SystemGraph,
): ReadonlyMap<string, SystemGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}
