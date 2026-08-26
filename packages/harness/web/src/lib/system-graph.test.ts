import { describe, expect, it } from "vitest";

import { orderSystemGraphNodes, parseSystemGraph } from "./system-graph";

const valid = {
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
});

describe("orderSystemGraphNodes", () => {
  it("places a direct caller above its target regardless of response order", () => {
    expect(
      orderSystemGraphNodes(parseSystemGraph(valid)).map(
        (node) => node.agentKey,
      ),
    ).toEqual(["research", "growth"]);
  });
});
