import { describe, expect, it, vi } from "vitest";

import type { SystemGraph } from "../shared/system-graph.js";
import type {
  SystemGraphBuilder,
  SystemGraphBuildResult,
  WorkspaceScope,
} from "./system-graph.js";
import {
  SystemGraphStore,
  type StoredSystemGraph,
} from "./system-graph-store.js";

const scope: WorkspaceScope = {
  workspaceKey: "workspace-one",
  root: "/private/one",
};
const graph: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
  nodes: [],
  edges: [],
  warnings: [],
};

function buildResult(cacheable = true): SystemGraphBuildResult {
  return { cacheable, graph };
}

function storedResult(degraded = false): StoredSystemGraph {
  return { graph, degraded };
}

describe("SystemGraphStore", () => {
  it("coalesces concurrent and sequential reads for an unchanged workspace", async () => {
    let resolveBuild!: (value: SystemGraphBuildResult) => void;
    const pending = new Promise<SystemGraphBuildResult>((resolve) => {
      resolveBuild = resolve;
    });
    const builder: SystemGraphBuilder = { build: vi.fn(() => pending) };
    const store = new SystemGraphStore(builder);

    const first = store.get(scope);
    const concurrent = store.get(scope);
    expect(first).toBe(concurrent);
    resolveBuild(buildResult());
    await expect(first).resolves.toEqual(storedResult());
    await expect(store.get(scope)).resolves.toEqual(storedResult());
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("evicts failed builds so the next open retries", async () => {
    const builder: SystemGraphBuilder = {
      build: vi
        .fn()
        .mockRejectedValueOnce(new Error("scan failed"))
        .mockResolvedValueOnce(buildResult()),
    };
    const store = new SystemGraphStore(builder);

    await expect(store.get(scope)).rejects.toThrow("scan failed");
    await expect(store.get(scope)).resolves.toEqual(storedResult());
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it("supports explicit invalidation without coupling it to UI opens", async () => {
    const builder: SystemGraphBuilder = {
      build: vi.fn(async () => buildResult()),
    };
    const store = new SystemGraphStore(builder);
    await store.get(scope);
    store.invalidate(scope.workspaceKey);
    await store.get(scope);
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it("coalesces a degraded graph and allows one later re-enrichment", async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult(false))
      .mockResolvedValueOnce(buildResult());
    const store = new SystemGraphStore({ build });

    const first = store.get(scope);
    const concurrent = store.get(scope);
    expect(first).toBe(concurrent);
    await expect(first).resolves.toEqual(storedResult(true));
    await expect(store.get(scope)).resolves.toEqual(storedResult());
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("retains the second degraded graph until explicit invalidation", async () => {
    const build = vi.fn(async () => buildResult(false));
    const store = new SystemGraphStore({ build });

    await expect(store.get(scope)).resolves.toEqual(storedResult(true));
    const second = store.get(scope);
    await expect(second).resolves.toEqual(storedResult(true));
    expect(store.get(scope)).toBe(second);
    expect(build).toHaveBeenCalledTimes(2);

    store.invalidate(scope.workspaceKey);
    await expect(store.get(scope)).resolves.toEqual(storedResult(true));
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("does not let an invalidated in-flight build consume the retry", async () => {
    let resolveFirst!: (value: SystemGraphBuildResult) => void;
    let resolveSecond!: (value: SystemGraphBuildResult) => void;
    const firstBuild = new Promise<SystemGraphBuildResult>((resolve) => {
      resolveFirst = resolve;
    });
    const secondBuild = new Promise<SystemGraphBuildResult>((resolve) => {
      resolveSecond = resolve;
    });
    const build = vi
      .fn()
      .mockReturnValueOnce(firstBuild)
      .mockReturnValueOnce(secondBuild)
      .mockResolvedValueOnce(buildResult());
    const store = new SystemGraphStore({ build });

    const stale = store.get(scope);
    store.invalidate(scope.workspaceKey);
    const current = store.get(scope);
    resolveFirst(buildResult(false));
    await stale;
    resolveSecond(buildResult(false));
    await current;

    await expect(store.get(scope)).resolves.toEqual(storedResult());
    expect(build).toHaveBeenCalledTimes(3);
  });
});
