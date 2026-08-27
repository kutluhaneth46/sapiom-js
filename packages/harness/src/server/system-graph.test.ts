import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SystemGraphStore } from "../core/system-graph-store.js";
import type {
  SystemGraphBuilder,
  WorkspaceScopeResolver,
} from "../core/system-graph.js";
import type { SystemGraph } from "../shared/system-graph.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createSystemGraphRouter } from "./system-graph.js";

const workspaceKey = "workspace-known";
const graph: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey },
  nodes: [
    { id: "agent:research", agentKey: "research", label: "Research" },
    { id: "agent:growth", agentKey: "growth", label: "Growth" },
  ],
  edges: [
    {
      from: "agent:research",
      to: "agent:growth",
      kind: "invokes",
      basis: "static",
      mode: "async",
    },
  ],
  warnings: [],
};

describe("createSystemGraphRouter", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  function start() {
    const scopeResolver: WorkspaceScopeResolver = {
      resolve: vi.fn(async (key: string) =>
        key === workspaceKey
          ? { workspaceKey: key, root: "/private/workspace" }
          : null,
      ),
    };
    const builder: SystemGraphBuilder = {
      build: vi.fn(async () => ({ cacheable: true, graph })),
    };
    const app = express();
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use(
      "/api",
      createSystemGraphRouter({
        scopeResolver,
        store: new SystemGraphStore(builder),
      }),
    );
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      scopeResolver,
      builder,
    };
  }

  it("is boot-token protected and returns the cached public graph", async () => {
    const { baseUrl, builder } = start();
    const route = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;

    expect((await fetch(route)).status).toBe(401);
    const first = await fetch(route, {
      headers: { "X-Harness-Token": "test-token" },
    });
    const second = await fetch(route, {
      headers: { "X-Harness-Token": "test-token" },
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(graph);
    expect(second.status).toBe(200);
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown opaque workspace key without scanning", async () => {
    const { baseUrl, builder } = start();
    const response = await fetch(
      `${baseUrl}/api/workspaces/unknown/system-graph`,
      {
        headers: { "X-Harness-Token": "test-token" },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found" });
    expect(builder.build).not.toHaveBeenCalled();
  });
});
