import * as fs from "node:fs";
import * as path from "node:path";

import type { WorkspaceKey } from "../shared/system-graph.js";
import { isAgentProjectScanIgnoredDir } from "./agent-project-discovery.js";
import {
  normalizeWatchPath,
  snapshotWorkflowSources,
} from "./canvas-watcher.js";
import type { WorkspaceScope } from "./system-graph.js";
import {
  snapshotWorkspaceWorkflows,
  snapshotWorkspaceWorkflowsAsync,
} from "./workspace-watcher.js";

const SOURCE_DEBOUNCE_MS = 150;
const INVENTORY_DEBOUNCE_MS = 250;
const INVENTORY_RETRY_MS = 500;
const POLL_INTERVAL_MS = 500;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function ignoredRelativePath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .filter(Boolean)
    .some((segment) => isAgentProjectScanIgnoredDir(segment));
}

function sourceRelativePath(relativePath: string): boolean {
  return (
    !ignoredRelativePath(relativePath) &&
    SOURCE_EXTENSIONS.has(path.extname(relativePath))
  );
}

function confinedSourcePath(root: string, relativePath: string): string | null {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return absolute;
}

export interface SystemGraphWatcherCallbacks {
  onSourceChange: (
    scope: WorkspaceScope,
    /** Null when the platform can only report a workspace-level change. */
    sourcePaths: readonly string[] | null,
  ) => void | Promise<void>;
  onInventoryChange: (scope: WorkspaceScope) => void | Promise<void>;
}

class WorkspaceSystemGraphWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sourceTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private sourcePaths = new Set<string>();
  private ambiguousSourceChange = false;
  private lastSourceSnapshot: string;
  private lastInventorySnapshot: string;
  private pollInFlight = false;
  private callbackQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly scope: WorkspaceScope,
    private readonly callbacks: SystemGraphWatcherCallbacks,
  ) {
    this.lastSourceSnapshot = snapshotWorkflowSources(scope.root);
    this.lastInventorySnapshot = snapshotWorkspaceWorkflows(scope.root);
    this.arm();
  }

  private enqueue(
    callback: () => void | Promise<void>,
    onFailure?: () => void,
  ): void {
    this.callbackQueue = this.callbackQueue.then(async () => {
      if (this.closed) return;
      try {
        await callback();
      } catch {
        // Watch callbacks are refresh hints. A failed scan/build must not tear
        // down the watcher or affect the rest of Studio.
        try {
          onFailure?.();
        } catch {
          // Failure recovery is best-effort too.
        }
      }
    });
  }

  private scheduleSourceChange(sourcePath: string | null): void {
    if (this.closed) return;
    if (sourcePath === null) this.ambiguousSourceChange = true;
    else this.sourcePaths.add(sourcePath);
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    this.sourceTimer = setTimeout(() => {
      this.sourceTimer = null;
      const paths = this.ambiguousSourceChange
        ? null
        : [...this.sourcePaths].sort();
      this.sourcePaths.clear();
      this.ambiguousSourceChange = false;
      this.enqueue(() => this.callbacks.onSourceChange(this.scope, paths));
    }, SOURCE_DEBOUNCE_MS);
  }

  private dispatchInventoryChange(snapshot: string): void {
    const previousSnapshot = this.lastInventorySnapshot;
    this.lastInventorySnapshot = snapshot;
    this.enqueue(
      () => this.callbacks.onInventoryChange(this.scope),
      () => {
        if (this.closed || this.lastInventorySnapshot !== snapshot) return;
        // A failed registry scan did not consume the structural change. Restore
        // the old baseline and retry even when no second filesystem event lands.
        this.lastInventorySnapshot = previousSnapshot;
        this.scheduleInventoryCheck(INVENTORY_RETRY_MS);
      },
    );
  }

  private scheduleInventoryCheck(delay = INVENTORY_DEBOUNCE_MS): void {
    if (this.closed) return;
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = null;
      const snapshot = snapshotWorkspaceWorkflows(this.scope.root);
      if (snapshot === this.lastInventorySnapshot) return;
      this.dispatchInventoryChange(snapshot);
    }, delay);
  }

  private arm(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(
        this.scope.root,
        { recursive: true },
        (_event, rawFilename) => {
          if (rawFilename === null) {
            this.scheduleSourceChange(null);
            this.scheduleInventoryCheck();
            return;
          }
          const relativePath = normalizeWatchPath(rawFilename);
          if (ignoredRelativePath(relativePath)) return;
          if (sourceRelativePath(relativePath)) {
            this.scheduleSourceChange(
              confinedSourcePath(this.scope.root, relativePath),
            );
          }
          // Event kind is unreliable across editors/platforms. The marker
          // fingerprint decides whether inventory really changed.
          this.scheduleInventoryCheck();
        },
      );
      this.watcher.on("error", () => this.fallBackToPolling());
    } catch {
      this.fallBackToPolling();
    }
  }

  private fallBackToPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.watcher?.close();
    this.watcher = null;
    this.lastSourceSnapshot = snapshotWorkflowSources(this.scope.root);
    this.lastInventorySnapshot = snapshotWorkspaceWorkflows(this.scope.root);
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      const sourceSnapshot = snapshotWorkflowSources(this.scope.root);
      if (sourceSnapshot !== this.lastSourceSnapshot) {
        this.lastSourceSnapshot = sourceSnapshot;
        this.scheduleSourceChange(null);
      }
      snapshotWorkspaceWorkflowsAsync(this.scope.root)
        .then((inventorySnapshot) => {
          if (this.closed || inventorySnapshot === this.lastInventorySnapshot) {
            return;
          }
          this.dispatchInventoryChange(inventorySnapshot);
        })
        .catch(() => {
          // The next poll retries an unreadable workspace.
        })
        .finally(() => {
          this.pollInFlight = false;
        });
    }, POLL_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}

/** One watcher per requested workspace, independent of harness sessions. */
export class SystemGraphWatcherManager {
  private readonly watchers = new Map<
    WorkspaceKey,
    WorkspaceSystemGraphWatcher
  >();

  constructor(private readonly callbacks: SystemGraphWatcherCallbacks) {}

  start(scope: WorkspaceScope): void {
    const existing = this.watchers.get(scope.workspaceKey);
    if (existing?.scope.root === scope.root) return;
    this.stop(scope.workspaceKey);
    this.watchers.set(
      scope.workspaceKey,
      new WorkspaceSystemGraphWatcher(scope, this.callbacks),
    );
  }

  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    for (const workspaceKey of [...this.watchers.keys()]) {
      if (!workspaceKeys.has(workspaceKey)) this.stop(workspaceKey);
    }
  }

  stop(workspaceKey: WorkspaceKey): void {
    this.watchers.get(workspaceKey)?.close();
    this.watchers.delete(workspaceKey);
  }

  stopAll(): void {
    for (const workspaceKey of [...this.watchers.keys()]) {
      this.stop(workspaceKey);
    }
  }

  get size(): number {
    return this.watchers.size;
  }
}
