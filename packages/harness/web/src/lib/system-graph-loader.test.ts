import { describe, expect, it, vi } from "vitest";

import type { SystemGraph, WorkspaceKey } from "@shared/system-graph";

import {
  createSystemGraphLoader,
  type SystemGraphSource,
} from "./system-graph-loader";

const workspaceKey: WorkspaceKey = "workspace-test";
const graph: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey },
  nodes: [],
  edges: [],
  warnings: [],
};

describe("createSystemGraphLoader", () => {
  it("coalesces requests and retains a complete graph", async () => {
    const getSystemGraph = vi.fn(async () => ({ graph, degraded: false }));
    const load = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const first = load(source, workspaceKey);
    expect(load(source, workspaceKey)).toBe(first);
    await expect(first).resolves.toBe(graph);
    expect(load(source, workspaceKey)).toBe(first);
    expect(getSystemGraph).toHaveBeenCalledTimes(1);
  });

  it("allows one later-open retry and retains a second degraded graph", async () => {
    const getSystemGraph = vi.fn(async () => ({ graph, degraded: true }));
    const load = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const first = load(source, workspaceKey);
    expect(load(source, workspaceKey)).toBe(first);
    await expect(first).resolves.toBe(graph);

    const second = load(source, workspaceKey);
    await expect(second).resolves.toBe(graph);
    expect(load(source, workspaceKey)).toBe(second);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected request without consuming the degraded retry", async () => {
    const getSystemGraph = vi
      .fn()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce({ graph, degraded: false });
    const load = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    await expect(load(source, workspaceKey)).rejects.toThrow("scan failed");
    await expect(load(source, workspaceKey)).resolves.toBe(graph);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });
});
