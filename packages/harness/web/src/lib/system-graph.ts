import type {
  GraphWarning,
  SystemGraph,
  SystemGraphEdge,
  SystemGraphLifecycleState,
  SystemGraphNode,
  SystemGraphSnapshot,
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
    (value.mode !== "blocking" && value.mode !== "async")
  ) {
    return null;
  }
  return {
    from: value.from,
    to: value.to,
    kind: "invokes",
    basis: "static",
    mode: value.mode,
  };
}

const WARNING_CODES = new Set<GraphWarning["code"]>([
  "unresolved-target",
  "dynamic-target",
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

export interface VisibleSystemGraphEdge {
  from: string;
  to: string;
  modes: SystemGraphEdge["mode"][];
}

const MODE_ORDER: Record<SystemGraphEdge["mode"], number> = {
  blocking: 0,
  async: 1,
};

const compareIds = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

/** Public graph data retains one record per mode. The V0 Canvas draws one
 * connector per endpoint pair so dual-mode relationships never overlap. */
export function groupSystemGraphEdges(
  edges: readonly SystemGraphEdge[],
): VisibleSystemGraphEdge[] {
  const grouped = new Map<
    string,
    { from: string; to: string; modes: Set<SystemGraphEdge["mode"]> }
  >();
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}`;
    const group = grouped.get(key) ?? {
      from: edge.from,
      to: edge.to,
      modes: new Set<SystemGraphEdge["mode"]>(),
    };
    group.modes.add(edge.mode);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .sort(
      (left, right) =>
        compareIds(left.from, right.from) || compareIds(left.to, right.to),
    )
    .map(({ from, to, modes }) => ({
      from,
      to,
      modes: [...modes].sort(
        (left, right) => MODE_ORDER[left] - MODE_ORDER[right],
      ),
    }));
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
const LIFECYCLE_STATES = new Set<SystemGraphLifecycleState>([
  "building",
  "ready",
  "stale",
  "degraded",
]);

/** Treat the lifecycle envelope as untrusted and keep it path-free. */
export function parseSystemGraphSnapshot(value: unknown): SystemGraphSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["workspaceKey", "revision", "state", "graph"]) ||
    typeof value.workspaceKey !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.state !== "string" ||
    !LIFECYCLE_STATES.has(value.state as SystemGraphLifecycleState) ||
    (value.graph !== null && !isRecord(value.graph))
  ) {
    throw new Error("Invalid system graph response");
  }

  const state = value.state as SystemGraphLifecycleState;
  const graph = value.graph === null ? null : parseSystemGraph(value.graph);
  if (
    (state === "building" && graph !== null) ||
    ((state === "ready" || state === "stale") && graph === null)
  ) {
    throw new Error("Invalid system graph response");
  }
  if (graph && graph.scope.workspaceKey !== value.workspaceKey) {
    throw new Error("Invalid system graph response");
  }

  return {
    workspaceKey: value.workspaceKey,
    revision: value.revision as number,
    state,
    graph,
  };
}
