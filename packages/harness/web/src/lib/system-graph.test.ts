import { describe, expect, it } from "vitest";
import type { SystemGraph } from "@shared/system-graph";

import {
  groupSystemGraphEdges,
  parseSystemGraph,
  parseSystemGraphSnapshot,
} from "./system-graph";

const valid: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey: "workspace-test" },
  nodes: [
    { id: "agent:growth", agentKey: "growth", label: "Growth" },
    { id: "agent:research", agentKey: "research", label: "Research" },
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

describe("parseSystemGraph", () => {
  it("accepts the system graph contract", () => {
    expect(parseSystemGraph(valid)).toEqual(valid);
  });

  it("accepts blocking edges and dynamic-target warnings", () => {
    const graph = {
      ...valid,
      edges: [{ ...valid.edges[0], mode: "blocking" }],
      warnings: [
        {
          code: "dynamic-target",
          agentKey: "research",
          message: "Research has a dynamic target.",
        },
      ],
    };

    expect(parseSystemGraph(graph)).toEqual(graph);
  });

  it("accepts typed duplicate and partial-inventory warnings", () => {
    const warnings = [
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared.",
      },
      {
        code: "inventory-extraction-failed",
        agentKey: "local:reporting",
        message: "Could not inspect Reporting; using its local identity.",
      },
    ];

    expect(parseSystemGraph({ ...valid, warnings }).warnings).toEqual(warnings);
  });

  it("rejects an edge whose endpoint is absent", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        edges: [{ ...valid.edges[0], to: "agent:missing" }],
      }),
    ).toThrow("Invalid system graph response");
  });

  it("rejects unexpected path-bearing fields and wrong graph kinds", () => {
    expect(() =>
      parseSystemGraph({ ...valid, root: "/private/workspace" }),
    ).toThrow();
    expect(() => parseSystemGraph({ ...valid, kind: "canvas" })).toThrow();
  });

  it("rejects unknown warning codes", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        warnings: [{ code: "inventory-broken", message: "Nope" }],
      }),
    ).toThrow("Invalid system graph response");
  });

  it("rejects unsupported invocation modes", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        edges: [{ ...valid.edges[0], mode: "unknown" }],
      }),
    ).toThrow("Invalid system graph response");
  });
});

describe("parseSystemGraphSnapshot", () => {
  it("accepts every honest lifecycle shape", () => {
    expect(
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "building",
        graph: null,
      }),
    ).toEqual({
      workspaceKey: "workspace-test",
      revision: 1,
      state: "building",
      graph: null,
    });
    for (const state of ["ready", "stale", "degraded"] as const) {
      expect(
        parseSystemGraphSnapshot({
          workspaceKey: "workspace-test",
          revision: 2,
          state,
          graph: valid,
        }).state,
      ).toBe(state);
    }
    expect(
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 3,
        state: "degraded",
        graph: null,
      }).graph,
    ).toBeNull();
  });

  it("rejects cross-workspace, path-bearing, and impossible snapshots", () => {
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-other",
        revision: 1,
        state: "ready",
        graph: valid,
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "stale",
        graph: null,
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "ready",
        graph: valid,
        root: "/private/workspace",
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "building",
        graph: valid,
      }),
    ).toThrow("Invalid system graph response");
  });
});

describe("groupSystemGraphEdges", () => {
  it("groups mode-specific records into one stable visible connector", () => {
    expect(
      groupSystemGraphEdges([
        { ...valid.edges[0], mode: "async" },
        { ...valid.edges[0], mode: "blocking" },
        { ...valid.edges[0], mode: "async" },
      ]),
    ).toEqual([
      {
        from: "agent:research",
        to: "agent:growth",
        modes: ["blocking", "async"],
      },
    ]);
  });
});
