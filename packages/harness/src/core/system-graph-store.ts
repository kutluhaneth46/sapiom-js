import type { SystemGraph, WorkspaceKey } from "../shared/system-graph.js";
import type { SystemGraphBuilder, WorkspaceScope } from "./system-graph.js";

/** Read-through cache. Promises coalesce concurrent opens, even when a
 * degraded result is intentionally evicted as soon as it resolves. */
export class SystemGraphStore {
  private readonly entries = new Map<WorkspaceKey, Promise<SystemGraph>>();

  constructor(private readonly builder: SystemGraphBuilder) {}

  get(scope: WorkspaceScope): Promise<SystemGraph> {
    const existing = this.entries.get(scope.workspaceKey);
    if (existing) return existing;

    let building: Promise<SystemGraph>;
    try {
      building = this.builder.build(scope).then(({ cacheable, graph }) => {
        if (!cacheable && this.entries.get(scope.workspaceKey) === building) {
          this.entries.delete(scope.workspaceKey);
        }
        return graph;
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
  }

  clear(): void {
    this.entries.clear();
  }
}
