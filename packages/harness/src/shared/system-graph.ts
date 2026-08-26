/**
 * Public contract for the local workspace dependency graph. Graph payloads
 * never carry filesystem roots; WorkspaceScopeSummary only joins AppState's
 * existing cwd-backed folder projection to an opaque key.
 */
export type WorkspaceKey = string;
export type AgentKey = string;

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

export interface SystemGraphEdge {
  from: string;
  to: string;
  kind: "invokes";
  basis: "static";
  mode: "async";
}

export interface GraphWarning {
  code: "unresolved-target" | "duplicate-edge" | "projection-failed";
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

export type CanvasSubject =
  | { kind: "workspace"; workspaceKey: WorkspaceKey }
  | { kind: "agent"; workflowPath: string; sessionId: string | null };
