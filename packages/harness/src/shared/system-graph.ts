/**
 * Public contract for the local workspace dependency graph. Graph payloads
 * never carry filesystem roots; WorkspaceScopeSummary only joins AppState's
 * existing cwd-backed folder projection to an opaque key.
 */
export type WorkspaceKey = string;
export type AgentKey = string;

/** Internal HTTP metadata; it is deliberately not part of SystemGraph JSON. */
export const SYSTEM_GRAPH_CACHE_HEADER = "X-Sapiom-System-Graph-Cache";
export type SystemGraphCacheStatus = "complete" | "degraded";

export interface WorkspaceScopeSummary {
  workspaceKey: WorkspaceKey;
  /** Used only to join the existing workspace-folder projection in AppState. */
  cwd: string;
}

export interface SystemGraphNode {
  id: string;
  agentKey: AgentKey;
  label: string;
}

export type AgentInvocationMode = "blocking" | "async";

export interface SystemGraphEdge {
  from: string;
  to: string;
  kind: "invokes";
  basis: "static";
  mode: AgentInvocationMode;
}

export interface GraphWarning {
  code:
    | "unresolved-target"
    | "dynamic-target"
    | "duplicate-edge"
    | "projection-failed"
    | "duplicate-agent-key"
    | "inventory-extraction-failed";
  message: string;
  agentKey?: AgentKey;
}

export interface SystemGraph {
  kind: "system";
  scope: {
    kind: "working-tree";
    workspaceKey: WorkspaceKey;
  };
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
  warnings: GraphWarning[];
}
