import type { SystemGraph, WorkspaceKey } from "../shared/system-graph.js";
import type { SystemGraphBuilder, WorkspaceScope } from "./system-graph.js";

export interface StoredSystemGraph {
  graph: SystemGraph;
  degraded: boolean;
}

/** Read-through cache. Promises coalesce concurrent opens. A degraded first
 * read gets one later re-enrichment; its second result is retained so a
 * permanent inspection failure cannot charge every workspace open. */
export class SystemGraphStore {
  private readonly entries = new Map<
    WorkspaceKey,
    Promise<StoredSystemGraph>
  >();
  private readonly degradedRetries = new Set<WorkspaceKey>();

  constructor(private readonly builder: SystemGraphBuilder) {}

  get(scope: WorkspaceScope): Promise<StoredSystemGraph> {
    const existing = this.entries.get(scope.workspaceKey);
    if (existing) return existing;

    let building: Promise<StoredSystemGraph>;
    try {
      building = this.builder.build(scope).then(({ cacheable, graph }) => {
        if (this.entries.get(scope.workspaceKey) === building) {
          if (cacheable) {
            this.degradedRetries.delete(scope.workspaceKey);
          } else if (!this.degradedRetries.has(scope.workspaceKey)) {
            this.degradedRetries.add(scope.workspaceKey);
            this.entries.delete(scope.workspaceKey);
          }
        }
        return { graph, degraded: !cacheable };
      });
    } catch (err) {
      building = Promise.reject(err);
    }
    this.entries.set(scope.workspaceKey, building);
    void building.catch(() => {
      if (this.entries.get(scope.workspaceKey) === building) {
        this.entries.delete(scope.workspaceKey);
      }
    });
    return building;
  }

  invalidate(workspaceKey: WorkspaceKey): void {
    this.entries.delete(workspaceKey);
    this.degradedRetries.delete(workspaceKey);
  }

  clear(): void {
    this.entries.clear();
    this.degradedRetries.clear();
  }
}
