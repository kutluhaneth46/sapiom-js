import { describe, expect, it, vi } from "vitest";

import type { SystemGraph } from "../shared/system-graph.js";
import type { SystemGraphBuilder, WorkspaceScope } from "./system-graph.js";
import { SystemGraphStore } from "./system-graph-store.js";

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

describe("SystemGraphStore", () => {
  it("coalesces concurrent and sequential reads for an unchanged workspace", async () => {
    let resolveBuild!: (value: SystemGraph) => void;
    const pending = new Promise<SystemGraph>((resolve) => {
      resolveBuild = resolve;
    });
    const builder: SystemGraphBuilder = { build: vi.fn(() => pending) };
    const store = new SystemGraphStore(builder);

    const first = store.get(scope);
    const concurrent = store.get(scope);
    expect(first).toBe(concurrent);
    resolveBuild(graph);
    await expect(first).resolves.toBe(graph);
    await expect(store.get(scope)).resolves.toBe(graph);
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("evicts failed builds so the next open retries", async () => {
    const builder: SystemGraphBuilder = {
      build: vi
        .fn()
        .mockRejectedValueOnce(new Error("scan failed"))
        .mockResolvedValueOnce(graph),
    };
    const store = new SystemGraphStore(builder);

    await expect(store.get(scope)).rejects.toThrow("scan failed");
    await expect(store.get(scope)).resolves.toBe(graph);
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it("supports explicit invalidation without coupling it to UI opens", async () => {
    const builder: SystemGraphBuilder = { build: vi.fn(async () => graph) };
    const store = new SystemGraphStore(builder);
    await store.get(scope);
    store.invalidate(scope.workspaceKey);
    await store.get(scope);
    expect(builder.build).toHaveBeenCalledTimes(2);
  });
});
