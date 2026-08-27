import type { SystemGraph, WorkspaceKey } from "@shared/system-graph";

export interface SystemGraphLoadResult {
  graph: SystemGraph;
  degraded: boolean;
}

export interface SystemGraphSource {
  getSystemGraph(workspaceKey: WorkspaceKey): Promise<SystemGraphLoadResult>;
}

/** Process-lifetime browser cache with one later-open retry for degradation. */
export function createSystemGraphLoader(): (
  source: SystemGraphSource,
  workspaceKey: WorkspaceKey,
) => Promise<SystemGraph> {
  const requests = new Map<WorkspaceKey, Promise<SystemGraph>>();
  const degradedRetries = new Set<WorkspaceKey>();

  return (source, workspaceKey) => {
    const existing = requests.get(workspaceKey);
    if (existing) return existing;

    let request: Promise<SystemGraph>;
    request = source.getSystemGraph(workspaceKey).then((result) => {
      if (result.degraded && !degradedRetries.has(workspaceKey)) {
        degradedRetries.add(workspaceKey);
        if (requests.get(workspaceKey) === request) {
          requests.delete(workspaceKey);
        }
      }
      return result.graph;
    });
    requests.set(workspaceKey, request);
    void request.catch(() => {
      if (requests.get(workspaceKey) === request) {
        requests.delete(workspaceKey);
      }
    });
    return request;
  };
}
