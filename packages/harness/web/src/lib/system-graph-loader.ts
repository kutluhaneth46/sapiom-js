import type { SystemGraphSnapshot, WorkspaceKey } from "@shared/system-graph";

export interface SystemGraphSource {
  getSystemGraph(
    workspaceKey: WorkspaceKey,
    options?: { refresh?: boolean },
  ): Promise<SystemGraphSnapshot>;
}

export interface SystemGraphLoader {
  load(
    source: SystemGraphSource,
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphSnapshot>;
  /** Invalidates only a newer announcement; omit revision for an explicit retry. */
  invalidate(workspaceKey: WorkspaceKey, revision?: number): boolean;
  /** Drops browser state for workspace scopes Studio no longer exposes. */
  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void;
  peek(workspaceKey: WorkspaceKey): SystemGraphSnapshot | null;
}

/**
 * Process-lifetime browser cache keyed by the server's opaque workspace key.
 * Revisions invalidate resolved and in-flight requests, and a generation guard
 * makes an older HTTP response follow the newest request instead of poisoning
 * the cache after a source edit.
 */
export function createSystemGraphLoader(): SystemGraphLoader {
  interface WorkspaceLifetime {
    generation: number;
    retired: boolean;
  }

  const requests = new Map<
    WorkspaceKey,
    {
      lifetime: WorkspaceLifetime;
      generation: number;
      promise: Promise<SystemGraphSnapshot>;
    }
  >();
  const snapshots = new Map<WorkspaceKey, SystemGraphSnapshot>();
  const lifetimes = new Map<WorkspaceKey, WorkspaceLifetime>();
  const announcedRevisions = new Map<WorkspaceKey, number>();
  const forcedReloads = new Set<WorkspaceKey>();
  const retryableSeen = new Set<WorkspaceKey>();
  const retryConsumed = new Set<WorkspaceKey>();

  const lifetimeFor = (workspaceKey: WorkspaceKey): WorkspaceLifetime => {
    const existing = lifetimes.get(workspaceKey);
    if (existing) return existing;
    const lifetime = { generation: 0, retired: false };
    lifetimes.set(workspaceKey, lifetime);
    return lifetime;
  };

  const load = (
    source: SystemGraphSource,
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphSnapshot> => {
    const lifetime = lifetimeFor(workspaceKey);
    const generation = lifetime.generation;
    const existing = requests.get(workspaceKey);
    if (existing?.lifetime === lifetime && existing.generation === generation) {
      return existing.promise;
    }

    const cached = snapshots.get(workspaceKey);
    const announcedRevision = announcedRevisions.get(workspaceKey) ?? -1;
    const cachedIsRetryable = cached !== undefined && cached.state !== "ready";
    const shouldRetry =
      cachedIsRetryable &&
      retryableSeen.has(workspaceKey) &&
      !retryConsumed.has(workspaceKey);
    if (
      cached &&
      cached.revision >= announcedRevision &&
      !forcedReloads.has(workspaceKey) &&
      !shouldRetry
    ) {
      const promise = Promise.resolve(cached);
      requests.set(workspaceKey, { lifetime, generation, promise });
      return promise;
    }
    if (shouldRetry) retryConsumed.add(workspaceKey);
    const explicitRefresh = forcedReloads.has(workspaceKey);

    let request!: Promise<SystemGraphSnapshot>;
    request = Promise.resolve()
      .then(() =>
        explicitRefresh
          ? source.getSystemGraph(workspaceKey, { refresh: true })
          : source.getSystemGraph(workspaceKey),
      )
      .then((snapshot) => {
        if (snapshot.workspaceKey !== workspaceKey) {
          throw new Error("Invalid system graph response");
        }
        if (lifetime.retired) {
          // The scope was retired while this request was in flight. Its caller
          // may finish, but the response cannot repopulate browser state.
          return snapshot;
        }
        const newestAnnouncement = announcedRevisions.get(workspaceKey) ?? -1;
        if (
          snapshot.revision < newestAnnouncement ||
          (lifetime.generation !== generation &&
            forcedReloads.has(workspaceKey) &&
            !explicitRefresh)
        ) {
          if (requests.get(workspaceKey)?.promise === request) {
            requests.delete(workspaceKey);
          }
          return load(source, workspaceKey);
        }

        snapshots.set(workspaceKey, snapshot);
        forcedReloads.delete(workspaceKey);
        if (
          snapshot.state !== "ready" &&
          !retryableSeen.has(workspaceKey)
        ) {
          retryableSeen.add(workspaceKey);
          // A later open gets one recovery attempt. Keep the snapshot itself
          // so the current view can continue showing loading, partial, or
          // last-good data.
          if (requests.get(workspaceKey)?.promise === request) {
            requests.delete(workspaceKey);
          }
        } else if (snapshot.state === "ready") {
          retryableSeen.delete(workspaceKey);
          retryConsumed.delete(workspaceKey);
        }
        return snapshot;
      });
    requests.set(workspaceKey, { lifetime, generation, promise: request });
    void request.catch(() => {
      if (requests.get(workspaceKey)?.promise === request) {
        requests.delete(workspaceKey);
      }
    });
    return request;
  };

  return {
    load,
    invalidate(workspaceKey, revision) {
      const knownRevision = Math.max(
        snapshots.get(workspaceKey)?.revision ?? -1,
        announcedRevisions.get(workspaceKey) ?? -1,
      );
      if (revision !== undefined && revision <= knownRevision) return false;
      if (revision !== undefined)
        announcedRevisions.set(workspaceKey, revision);
      else forcedReloads.add(workspaceKey);
      lifetimeFor(workspaceKey).generation += 1;
      requests.delete(workspaceKey);
      retryableSeen.delete(workspaceKey);
      retryConsumed.delete(workspaceKey);
      return true;
    },
    retain(workspaceKeys) {
      const cachedKeys = new Set<WorkspaceKey>([
        ...requests.keys(),
        ...snapshots.keys(),
        ...lifetimes.keys(),
        ...announcedRevisions.keys(),
        ...forcedReloads,
        ...retryableSeen,
        ...retryConsumed,
      ]);
      for (const workspaceKey of cachedKeys) {
        if (workspaceKeys.has(workspaceKey)) continue;
        const lifetime = lifetimes.get(workspaceKey);
        if (lifetime) lifetime.retired = true;
        lifetimes.delete(workspaceKey);
        requests.delete(workspaceKey);
        snapshots.delete(workspaceKey);
        announcedRevisions.delete(workspaceKey);
        forcedReloads.delete(workspaceKey);
        retryableSeen.delete(workspaceKey);
        retryConsumed.delete(workspaceKey);
      }
    },
    peek: (workspaceKey) => snapshots.get(workspaceKey) ?? null,
  };
}

/** One cache for the browser tab, invalidated by the global event subscriber. */
export const systemGraphLoader = createSystemGraphLoader();
