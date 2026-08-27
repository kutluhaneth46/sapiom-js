import type {
  SystemGraph,
  SystemGraphLifecycleState,
  SystemGraphSnapshot,
  WorkspaceKey,
} from "../shared/system-graph.js";
import type { SystemGraphBuilder, WorkspaceScope } from "./system-graph.js";

export interface SystemGraphStoreOptions {
  /** Called only for an accepted lifecycle transition. */
  onChange?: (snapshot: SystemGraphSnapshot) => void;
}

interface SystemGraphEntry {
  scope: WorkspaceScope;
  snapshot: SystemGraphSnapshot;
  lastGood: SystemGraph | null;
  activeBuild: Promise<SystemGraphSnapshot> | null;
  generation: number;
  refreshPending: boolean;
  automaticRetryUsed: boolean;
  retired: boolean;
}

/**
 * Process-lifetime, workspace-scoped projection store.
 *
 * Cold reads coalesce behind one build. Later refreshes keep the last usable
 * graph visible as stale, serialize rebuilds, and reject an older generation's
 * result when another edit arrives while it is in flight.
 */
export class SystemGraphStore {
  private readonly entries = new Map<WorkspaceKey, SystemGraphEntry>();
  private readonly revisionFloors = new Map<WorkspaceKey, number>();

  constructor(
    private readonly builder: SystemGraphBuilder,
    private readonly options: SystemGraphStoreOptions = {},
  ) {}

  get(scope: WorkspaceScope): Promise<SystemGraphSnapshot> {
    const entry = this.ensureEntry(scope);
    if (entry.activeBuild) {
      return entry.snapshot.graph === null
        ? entry.activeBuild
        : Promise.resolve(entry.snapshot);
    }
    if (entry.snapshot.state === "building" && entry.snapshot.graph === null) {
      return this.startBuild(entry);
    }

    // Non-ready projections are deliberately not healthy cache hits. One
    // later open awaits a recovery build, while a permanent failure cannot
    // charge every collapse/expand forever.
    if (
      (entry.snapshot.state === "degraded" ||
        entry.snapshot.state === "stale") &&
      !entry.automaticRetryUsed
    ) {
      entry.automaticRetryUsed = true;
      this.queueRefresh(entry, entry.snapshot.state === "degraded");
    }
    return Promise.resolve(entry.snapshot);
  }

  /** Marks a workspace dirty and starts (or queues) a background refresh. */
  requestRefresh(scope: WorkspaceScope): SystemGraphSnapshot {
    const entry = this.ensureEntry(scope);
    entry.automaticRetryUsed = false;
    this.queueRefresh(entry);
    return entry.snapshot;
  }

  /** Explicit user recovery: start a fresh projection and await its result. */
  refresh(scope: WorkspaceScope): Promise<SystemGraphSnapshot> {
    const entry = this.ensureEntry(scope);
    entry.automaticRetryUsed = false;
    return this.queueRefresh(entry) ?? Promise.resolve(entry.snapshot);
  }

  peek(workspaceKey: WorkspaceKey): SystemGraphSnapshot | null {
    return this.entries.get(workspaceKey)?.snapshot ?? null;
  }

  /** Records a refresh prerequisite failure while preserving visible data. */
  reportRefreshFailure(scope: WorkspaceScope): SystemGraphSnapshot {
    const entry = this.ensureEntry(scope);
    entry.generation += 1;
    entry.refreshPending = false;
    // Registry recovery must happen before projection. Do not let a later
    // graph read rebuild from the stale inventory and relabel it ready; the
    // watcher retries the failed inventory callback instead.
    entry.automaticRetryUsed = true;
    const visibleGraph = entry.lastGood ?? entry.snapshot.graph;
    return visibleGraph === null
      ? this.transition(entry, "degraded", null)
      : this.transition(entry, "stale", visibleGraph);
  }

  /** Retires projections for workspace scopes Studio no longer exposes. */
  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    for (const workspaceKey of [...this.entries.keys()]) {
      if (!workspaceKeys.has(workspaceKey)) this.retire(workspaceKey);
    }
  }

  /** Stops retaining a scope that Studio no longer exposes. */
  retire(workspaceKey: WorkspaceKey): void {
    const entry = this.entries.get(workspaceKey);
    if (!entry) return;
    entry.retired = true;
    entry.generation += 1;
    this.revisionFloors.set(workspaceKey, entry.snapshot.revision);
    this.entries.delete(workspaceKey);
    this.retainBuilderWorkspaces();
  }

  /** Backward-compatible alias for callers that explicitly drop a snapshot. */
  invalidate(workspaceKey: WorkspaceKey): void {
    this.retire(workspaceKey);
  }

  clear(): void {
    for (const workspaceKey of [...this.entries.keys()]) {
      this.retire(workspaceKey);
    }
    this.revisionFloors.clear();
  }

  private ensureEntry(scope: WorkspaceScope): SystemGraphEntry {
    const existing = this.entries.get(scope.workspaceKey);
    if (existing) {
      existing.scope = scope;
      return existing;
    }
    const entry: SystemGraphEntry = {
      scope,
      snapshot: {
        workspaceKey: scope.workspaceKey,
        revision: this.revisionFloors.get(scope.workspaceKey) ?? 0,
        state: "building",
        graph: null,
      },
      lastGood: null,
      activeBuild: null,
      generation: 0,
      refreshPending: false,
      automaticRetryUsed: false,
      retired: false,
    };
    this.entries.set(scope.workspaceKey, entry);
    return entry;
  }

  private queueRefresh(
    entry: SystemGraphEntry,
    preserveLifecycle = false,
  ): Promise<SystemGraphSnapshot> | null {
    if (entry.retired) return null;
    entry.generation += 1;
    entry.refreshPending = true;
    const visibleGraph = entry.lastGood ?? entry.snapshot.graph;
    if (!preserveLifecycle) {
      this.transition(
        entry,
        visibleGraph === null ? "building" : "stale",
        visibleGraph,
      );
    }
    if (entry.activeBuild) return entry.activeBuild;
    entry.refreshPending = false;
    return this.startBuild(entry);
  }

  private startBuild(entry: SystemGraphEntry): Promise<SystemGraphSnapshot> {
    if (entry.activeBuild) return entry.activeBuild;
    const generation = entry.generation;
    entry.refreshPending = false;
    const visibleGraph = entry.lastGood ?? entry.snapshot.graph;
    if (entry.snapshot.state !== "degraded") {
      this.transition(
        entry,
        visibleGraph === null ? "building" : "stale",
        visibleGraph,
      );
    }

    let build: Promise<Awaited<ReturnType<SystemGraphBuilder["build"]>>>;
    try {
      build = Promise.resolve(this.builder.build(entry.scope));
    } catch (error) {
      build = Promise.reject(error);
    }

    const active = build.then(
      (result) => this.finishBuild(entry, generation, result),
      () => this.finishFailure(entry, generation),
    );
    entry.activeBuild = active;
    return active;
  }

  private finishBuild(
    entry: SystemGraphEntry,
    generation: number,
    result: Awaited<ReturnType<SystemGraphBuilder["build"]>>,
  ): SystemGraphSnapshot | Promise<SystemGraphSnapshot> {
    if (!this.canCommit(entry, generation)) {
      return this.continueAfterSupersededBuild(entry);
    }
    entry.activeBuild = null;
    if (result.cacheable) {
      entry.lastGood = result.graph;
      entry.automaticRetryUsed = false;
      return this.transition(entry, "ready", result.graph);
    }
    return this.transition(entry, "degraded", result.graph);
  }

  private finishFailure(
    entry: SystemGraphEntry,
    generation: number,
  ): SystemGraphSnapshot | Promise<SystemGraphSnapshot> {
    if (!this.canCommit(entry, generation)) {
      return this.continueAfterSupersededBuild(entry);
    }
    entry.activeBuild = null;
    const visibleGraph = entry.lastGood ?? entry.snapshot.graph;
    return visibleGraph === null
      ? this.transition(entry, "degraded", null)
      : this.transition(entry, "stale", visibleGraph, true);
  }

  private canCommit(entry: SystemGraphEntry, generation: number): boolean {
    return (
      !entry.retired &&
      this.entries.get(entry.scope.workspaceKey) === entry &&
      entry.generation === generation
    );
  }

  private continueAfterSupersededBuild(
    entry: SystemGraphEntry,
  ): SystemGraphSnapshot | Promise<SystemGraphSnapshot> {
    entry.activeBuild = null;
    if (
      entry.retired ||
      this.entries.get(entry.scope.workspaceKey) !== entry
    ) {
      this.retainBuilderWorkspaces();
      return entry.snapshot;
    }
    if (entry.refreshPending) {
      entry.refreshPending = false;
      return this.startBuild(entry);
    }
    return entry.snapshot;
  }

  private retainBuilderWorkspaces(): void {
    try {
      this.builder.retainWorkspaces?.(new Set(this.entries.keys()));
    } catch {
      // Cache pruning cannot make graph reads or scope retirement fail.
    }
  }

  private transition(
    entry: SystemGraphEntry,
    state: SystemGraphLifecycleState,
    graph: SystemGraph | null,
    forceRevision = false,
  ): SystemGraphSnapshot {
    if (
      !forceRevision &&
      entry.snapshot.state === state &&
      entry.snapshot.graph === graph
    ) {
      return entry.snapshot;
    }
    entry.snapshot = {
      workspaceKey: entry.scope.workspaceKey,
      revision: entry.snapshot.revision + 1,
      state,
      graph,
    };
    this.revisionFloors.set(
      entry.scope.workspaceKey,
      entry.snapshot.revision,
    );
    try {
      this.options.onChange?.(entry.snapshot);
    } catch {
      // Observers (the event bus) cannot make graph refreshes fail.
    }
    return entry.snapshot;
  }
}
