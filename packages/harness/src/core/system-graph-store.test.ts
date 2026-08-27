import { describe, expect, it, vi } from "vitest";

import type {
  SystemGraph,
  SystemGraphSnapshot,
} from "../shared/system-graph.js";
import type {
  SystemGraphBuildResult,
  SystemGraphBuilder,
  WorkspaceScope,
} from "./system-graph.js";
import { SystemGraphStore } from "./system-graph-store.js";

const scope: WorkspaceScope = {
  workspaceKey: "workspace-one",
  root: "/private/one",
};

function graphFor(label: string): SystemGraph {
  return {
    kind: "system",
    scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
    nodes: [{ id: `agent:${label}`, agentKey: label, label }],
    edges: [],
    warnings: [],
  };
}

function buildResult(
  label: string,
  cacheable = true,
): SystemGraphBuildResult {
  return { cacheable, graph: graphFor(label) };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SystemGraphStore", () => {
  it("coalesces cold reads and retains an unchanged ready snapshot", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const builder: SystemGraphBuilder = {
      build: vi.fn(() => pending.promise),
    };
    const store = new SystemGraphStore(builder);

    const first = store.get(scope);
    expect(store.get(scope)).toBe(first);
    pending.resolve(buildResult("first"));

    const ready = await first;
    expect(ready).toMatchObject({ state: "ready", graph: graphFor("first") });
    await expect(store.get(scope)).resolves.toBe(ready);
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("keeps the last-good graph visible while a refresh runs", async () => {
    const refresh = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("first"))
      .mockReturnValueOnce(refresh.promise);
    const changes: SystemGraphSnapshot[] = [];
    const store = new SystemGraphStore(
      { build },
      { onChange: (snapshot) => changes.push(snapshot) },
    );
    await store.get(scope);

    const stale = store.requestRefresh(scope);
    expect(stale).toMatchObject({ state: "stale", graph: graphFor("first") });
    await expect(store.get(scope)).resolves.toBe(stale);

    refresh.resolve(buildResult("second"));
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "ready",
        graph: graphFor("second"),
      });
    });
    expect(changes.map((change) => change.state)).toContain("stale");
  });

  it("discards an older refresh and commits the newest edit", async () => {
    const oldRefresh = deferred<SystemGraphBuildResult>();
    const newestRefresh = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockReturnValueOnce(newestRefresh.promise);
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    store.requestRefresh(scope);
    store.requestRefresh(scope);
    oldRefresh.resolve(buildResult("obsolete"));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(3));
    expect(store.peek(scope.workspaceKey)?.graph).toEqual(graphFor("initial"));

    newestRefresh.resolve(buildResult("newest"));
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "ready",
        graph: graphFor("newest"),
      });
    });
  });

  it("preserves last-good data after a hard refresh failure", async () => {
    const failed = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce(buildResult("recovered"));
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    const refreshing = store.requestRefresh(scope);
    failed.reject(new Error("scan failed"));

    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "stale",
        graph: graphFor("initial"),
      });
      expect(store.peek(scope.workspaceKey)!.revision).toBeGreaterThan(
        refreshing.revision,
      );
    });

    await store.get(scope);
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "ready",
        graph: graphFor("recovered"),
      });
    });
  });

  it("publishes the current partial graph instead of retaining failed edges", async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockResolvedValueOnce(buildResult("partial", false));
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    store.requestRefresh(scope);

    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "degraded",
        graph: graphFor("partial"),
      });
    });
  });

  it("keeps last-good data stale after a failed inventory refresh", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockReturnValueOnce(pending.promise);
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    store.requestRefresh(scope);
    const stale = store.reportRefreshFailure(scope);
    expect(stale).toMatchObject({
      state: "stale",
      graph: graphFor("initial"),
    });

    pending.resolve(buildResult("obsolete"));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(store.peek(scope.workspaceKey)).toBe(stale);
  });

  it("does not publish a new revision for repeated inventory failures", async () => {
    const onChange = vi.fn();
    const store = new SystemGraphStore(
      { build: vi.fn().mockResolvedValue(buildResult("initial")) },
      { onChange },
    );
    await store.get(scope);
    onChange.mockClear();

    const firstFailure = store.reportRefreshFailure(scope);
    const repeatedFailure = store.reportRefreshFailure(scope);

    expect(repeatedFailure).toBe(firstFailure);
    expect(firstFailure.state).toBe("stale");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit refresh after automatic recovery was exhausted", async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockResolvedValueOnce(buildResult("recovered"));
    const store = new SystemGraphStore({ build });
    await store.get(scope);
    store.reportRefreshFailure(scope);

    await expect(store.refresh(scope)).resolves.toMatchObject({
      state: "ready",
      graph: graphFor("recovered"),
    });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("returns an honest cold degraded snapshot when no graph can be built", async () => {
    const store = new SystemGraphStore({
      build: vi.fn().mockRejectedValue(new Error("unavailable")),
    });

    await expect(store.get(scope)).resolves.toMatchObject({
      state: "degraded",
      graph: null,
    });
  });

  it("allows one later-open retry for a partial projection", async () => {
    const retry = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("partial", false))
      .mockReturnValueOnce(retry.promise);
    const store = new SystemGraphStore({ build });

    const degraded = await store.get(scope);
    expect(degraded.state).toBe("degraded");
    const retrying = store.get(scope);
    expect(store.peek(scope.workspaceKey)).toMatchObject({
      state: "degraded",
      graph: graphFor("partial"),
    });
    await store.get(scope);
    expect(build).toHaveBeenCalledTimes(2);

    retry.resolve(buildResult("recovered"));
    await expect(retrying).resolves.toMatchObject({
      state: "degraded",
      graph: graphFor("partial"),
    });
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)?.state).toBe("ready");
    });
  });

  it("does not publish or retain an in-flight build after scope retirement", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const onChange = vi.fn();
    const store = new SystemGraphStore(
      { build: vi.fn(() => pending.promise) },
      { onChange },
    );
    const initial = store.get(scope);
    store.retire(scope.workspaceKey);
    pending.resolve(buildResult("retired"));
    await initial;

    expect(store.peek(scope.workspaceKey)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retires only projections outside the retained workspace set", async () => {
    const secondScope = {
      workspaceKey: "workspace-two",
      root: "/private/two",
    };
    const store = new SystemGraphStore({
      build: vi.fn().mockResolvedValue(buildResult("ready")),
    });
    await Promise.all([store.get(scope), store.get(secondScope)]);

    store.retain(new Set([scope.workspaceKey]));

    expect(store.peek(scope.workspaceKey)).not.toBeNull();
    expect(store.peek(secondScope.workspaceKey)).toBeNull();
  });

  it("keeps revisions monotonic when a retired workspace returns", async () => {
    const store = new SystemGraphStore({
      build: vi.fn().mockResolvedValue(buildResult("ready")),
    });
    const first = await store.get(scope);
    store.retire(scope.workspaceKey);

    const returned = await store.get(scope);

    expect(returned.revision).toBeGreaterThan(first.revision);
  });
});
