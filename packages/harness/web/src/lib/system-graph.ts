import type {
  GraphWarning,
  SystemGraph,
  SystemGraphEdge,
  SystemGraphNode,
} from "@shared/system-graph";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseNode(value: unknown): SystemGraphNode | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "agentKey", "label"]))
    return null;
  if (
    typeof value.id !== "string" ||
    typeof value.agentKey !== "string" ||
    typeof value.label !== "string"
  ) {
    return null;
  }
  return { id: value.id, agentKey: value.agentKey, label: value.label };
}

function parseEdge(value: unknown): SystemGraphEdge | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["from", "to", "kind", "basis", "mode"])
  )
    return null;
  if (
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    value.kind !== "invokes" ||
    value.basis !== "static" ||
    value.mode !== "async"
  ) {
    return null;
  }
  return {
    from: value.from,
    to: value.to,
    kind: "invokes",
    basis: "static",
    mode: "async",
  };
}

const WARNING_CODES = new Set<GraphWarning["code"]>([
  "unresolved-target",
  "duplicate-edge",
  "projection-failed",
  "duplicate-agent-key",
  "inventory-extraction-failed",
]);

function parseWarning(value: unknown): GraphWarning | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["code", "message", "agentKey"]))
    return null;
  if (
    typeof value.code !== "string" ||
    !WARNING_CODES.has(value.code as GraphWarning["code"]) ||
    typeof value.message !== "string" ||
    (value.agentKey !== undefined && typeof value.agentKey !== "string")
  ) {
    return null;
  }
  return {
    code: value.code as GraphWarning["code"],
    message: value.message,
    ...(typeof value.agentKey === "string" ? { agentKey: value.agentKey } : {}),
  };
}

/** Treat the HTTP payload as untrusted; malformed or path-bearing shapes fail closed. */
export function parseSystemGraph(value: unknown): SystemGraph {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "scope", "nodes", "edges", "warnings"])
  ) {
    throw new Error("Invalid system graph response");
  }
  if (value.kind !== "system" || !isRecord(value.scope)) {
    throw new Error("Invalid system graph response");
  }
  if (!hasOnlyKeys(value.scope, ["kind", "workspaceKey"])) {
    throw new Error("Invalid system graph response");
  }
  if (
    value.scope.kind !== "working-tree" ||
    typeof value.scope.workspaceKey !== "string"
  ) {
    throw new Error("Invalid system graph response");
  }
  if (
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.warnings)
  ) {
    throw new Error("Invalid system graph response");
  }

  const nodes = value.nodes.map(parseNode);
  const edges = value.edges.map(parseEdge);
  const warnings = value.warnings.map(parseWarning);
  if (
    nodes.some((node) => node === null) ||
    edges.some((edge) => edge === null) ||
    warnings.some((warning) => warning === null)
  ) {
    throw new Error("Invalid system graph response");
  }

  const typedNodes = nodes as SystemGraphNode[];
  const typedEdges = edges as SystemGraphEdge[];
  const typedWarnings = warnings as GraphWarning[];
  const nodeIds = new Set(typedNodes.map((node) => node.id));
  if (
    nodeIds.size !== typedNodes.length ||
    typedEdges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
  ) {
    throw new Error("Invalid system graph response");
  }

  return {
    kind: "system",
    scope: { kind: "working-tree", workspaceKey: value.scope.workspaceKey },
    nodes: typedNodes,
    edges: typedEdges,
    warnings: typedWarnings,
  };
}

/** Stable Kahn order: direct callers render above the agents they invoke. */
export function orderSystemGraphNodes(graph: SystemGraph): SystemGraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const compareIds = (left: string, right: string): number =>
    left.localeCompare(right);
  const ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort(compareIds);
  const ordered: SystemGraphNode[] = [];
  const visited = new Set<string>();

  while (ready.length > 0) {
    const id = ready.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    ordered.push(byId.get(id)!);
    for (const target of [...(outgoing.get(id) ?? [])].sort(compareIds)) {
      const next = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort(compareIds);
      }
    }
  }

  // Cycles have no zero-indegree entry. Preserve the contract's stable order
  // for those remaining nodes instead of dropping them from the view.
  ordered.push(...graph.nodes.filter((node) => !visited.has(node.id)));
  return ordered;
}
