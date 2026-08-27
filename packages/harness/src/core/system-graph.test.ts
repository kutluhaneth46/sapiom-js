import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import {
  HarnessRegistryInventoryProvider,
  LocalWorkspaceScopeCatalog,
  StaticSystemGraphBuilder,
  type AgentInventoryProvider,
  type WorkspaceScope,
} from "./system-graph.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "system-graph-workspace",
);

function workflow(
  name: string,
  relativePath: string,
  definitionSlug: string | null,
): WorkflowInfo {
  return {
    name,
    path: path.join(FIXTURE, relativePath),
    definitionId: definitionSlug ? 1 : null,
    definitionSlug,
    source: "scan",
  };
}

async function buildGraph(
  builder: StaticSystemGraphBuilder,
  scope: WorkspaceScope,
) {
  return (await builder.build(scope)).graph;
}

describe("LocalWorkspaceScopeCatalog", () => {
  it("gives a canonical root a stable opaque key and rejects unknown keys", async () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      FIXTURE,
      path.join(FIXTURE, "."),
    ]);
    const scopes = await catalog.list();

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.workspaceKey).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(scopes[0]!.workspaceKey).not.toContain(FIXTURE);
    expect((await catalog.resolve(scopes[0]!.workspaceKey))?.root).toBe(
      FIXTURE,
    );
    await expect(catalog.resolve("workspace-not-known")).resolves.toBeNull();
  });

  it("does not collide when two roots share a basename", async () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      "/tmp/one/project",
      "/tmp/two/project",
    ]);
    expect(
      new Set((await catalog.list()).map((scope) => scope.workspaceKey)).size,
    ).toBe(2);
  });

  it("can resolve persisted workspace roots without a live session", async () => {
    const listRoots = vi.fn(async () => [FIXTURE]);
    const catalog = new LocalWorkspaceScopeCatalog(listRoots);
    const [scope] = await catalog.list();

    await expect(catalog.resolve(scope!.workspaceKey)).resolves.toEqual({
      workspaceKey: scope!.workspaceKey,
      root: FIXTURE,
    });
  });
});

describe("StaticSystemGraphBuilder", () => {
  const scope: WorkspaceScope = {
    workspaceKey: "workspace-fixture",
    root: FIXTURE,
  };

  it("projects the literal Research -> Growth launch into the public contract", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [
        workflow("Research", "research", "research"),
        workflow("Growth", "growth", "growth"),
      ],
      listWorkspaceScopes: () => [
        { workspaceKey: scope.workspaceKey, cwd: scope.root },
      ],
    });

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(inventory),
      scope,
    );

    expect(graph).toEqual({
      kind: "system",
      scope: { kind: "working-tree", workspaceKey: "workspace-fixture" },
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
    });
    expect(JSON.stringify(graph)).not.toContain(FIXTURE);
  });

  it("deduplicates edges, skips self-links, and reports unresolved targets deterministically", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () => ({
        agents: [
          {
            agentKey: "research",
            definitionId: 1,
            definitionSlug: "research",
            label: "Research",
            resolutionAliases: ["research"],
            sourceRoot: "/private/research",
          },
          {
            agentKey: "growth",
            definitionId: 2,
            definitionSlug: "growth",
            label: "Growth",
            resolutionAliases: ["growth"],
            sourceRoot: "/private/growth",
          },
        ],
        cacheable: true,
        warnings: [],
      })),
    };
    const detect = vi.fn(async (root: string) =>
      root.endsWith("research")
        ? [
            { slug: "growth", fromStepId: null },
            { slug: "growth", fromStepId: null },
            { slug: "research", fromStepId: null },
            { slug: "missing", fromStepId: null },
          ]
        : [],
    );

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(inventory, detect),
      scope,
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.warnings.map((warning) => warning.code)).toEqual([
      "duplicate-edge",
      "unresolved-target",
    ]);
    expect(JSON.stringify(graph)).not.toContain("/private/");
  });

  it("keeps duplicate definition slugs as unique nodes and reports ambiguous launches", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [
        workflow("Caller", "caller", "caller"),
        workflow("First copy", "growth", "shared"),
        workflow("Second copy", "research", "shared"),
      ],
      listWorkspaceScopes: () => [
        { workspaceKey: scope.workspaceKey, cwd: scope.root },
      ],
    });
    const detect = vi.fn(async (root: string) =>
      root.endsWith("caller") ? [{ slug: "shared", fromStepId: null }] : [],
    );

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(inventory, detect),
      scope,
    );

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "agent:caller",
      "agent:local:growth",
      "agent:local:research",
    ]);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(3);
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
      {
        code: "unresolved-target",
        agentKey: "caller",
        message: "Caller invokes ambiguous agent shared.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain(FIXTURE);
  });

  it("reasserts safe unique node identities for an arbitrary inventory provider", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () => ({
        agents: [
          {
            agentKey: "alpha",
            definitionId: null,
            definitionSlug: "alpha",
            label: "/private/first",
            resolutionAliases: ["alpha"],
            sourceRoot: path.join(FIXTURE, "growth"),
          },
          {
            agentKey: "alpha",
            definitionId: null,
            definitionSlug: "alpha",
            label: "C:\\Users\\Demo\\second",
            resolutionAliases: ["alpha"],
            sourceRoot: path.join(FIXTURE, "research"),
          },
          {
            agentKey: "local:growth",
            definitionId: null,
            definitionSlug: null,
            label: "Caller",
            resolutionAliases: ["local:growth"],
            sourceRoot: path.join(FIXTURE, "caller"),
          },
          {
            agentKey: "/private/leaked-key",
            definitionId: null,
            definitionSlug: null,
            label: "/private/leaked-label",
            resolutionAliases: ["/private/leaked-alias"],
            sourceRoot: "/outside/private-agent",
          },
        ],
        cacheable: true,
        warnings: [],
      })),
    };

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        inventory,
        vi.fn(async () => []),
      ),
      scope,
    );

    expect(graph.nodes).toHaveLength(4);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(4);
    const byKey = new Map(graph.nodes.map((node) => [node.agentKey, node]));
    expect([...byKey.keys()]).toEqual(
      expect.arrayContaining([
        "local:caller",
        "local:growth",
        "local:research",
      ]),
    );
    const hashedKey = [...byKey.keys()].find((key) =>
      /^local:[a-f0-9]{16}$/.test(key),
    );
    expect(hashedKey).toBeDefined();
    expect(byKey.get(hashedKey!)?.label).toBe(
      hashedKey!.slice("local:".length),
    );
    expect(byKey.get("local:caller")?.label).toBe("Caller");
    expect(byKey.get("local:growth")?.label).toBe("growth");
    expect(byKey.get("local:research")?.label).toBe("research");
    expect(graph.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "alpha",
        message: "Multiple agents use alpha; kept each with a local identity.",
      },
      {
        code: "duplicate-agent-key",
        agentKey: "local:growth",
        message:
          "Multiple agents use local:growth; kept each with a local identity.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain("/private/");
    expect(JSON.stringify(graph)).not.toContain("C:\\Users");
  });

  it("degrades a scanner failure into a path-free warning", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () => ({
        agents: [
          {
            agentKey: "research",
            definitionId: 1,
            definitionSlug: "research",
            label: "Research",
            resolutionAliases: ["research"],
            sourceRoot: "/private/research",
          },
        ],
        cacheable: true,
        warnings: [],
      })),
    };
    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        inventory,
        vi.fn(async () => {
          throw new Error("boom at /private/research");
        }),
      ),
      scope,
    );

    expect(graph.warnings).toEqual([
      {
        code: "projection-failed",
        agentKey: "research",
        message: "Could not inspect Research.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain("/private/");
  });

  it("keeps path-shaped registry and extraction values out of the public graph", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [
        {
          ...workflow(FIXTURE, "reporting", FIXTURE),
          definitionId: null,
        },
      ],
      listWorkspaceScopes: () => [
        { workspaceKey: scope.workspaceKey, cwd: scope.root },
      ],
      inspectManifestName: vi.fn(async () => ({
        status: "found" as const,
        name: FIXTURE,
      })),
    });

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        inventory,
        vi.fn(async () => []),
      ),
      scope,
    );

    expect(graph.nodes).toEqual([
      {
        id: "agent:local:reporting",
        agentKey: "local:reporting",
        label: "reporting",
      },
    ]);
    expect(graph.warnings).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain(FIXTURE);
  });

  it("projects disconnected inventory nodes and merges inventory warnings", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () => ({
        agents: [
          {
            agentKey: "research",
            definitionId: 1,
            definitionSlug: "research",
            label: "Research",
            resolutionAliases: ["research"],
            sourceRoot: "/private/research",
          },
          {
            agentKey: "local:reporting",
            definitionId: null,
            definitionSlug: null,
            label: "Reporting",
            resolutionAliases: [],
            sourceRoot: "/private/reporting",
          },
        ],
        cacheable: true,
        warnings: [
          {
            code: "inventory-extraction-failed" as const,
            agentKey: "local:reporting",
            message: "Could not inspect Reporting; using its local identity.",
          },
        ],
      })),
    };

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        inventory,
        vi.fn(async () => []),
      ),
      scope,
    );

    expect(graph.nodes.map((node) => node.agentKey)).toEqual([
      "local:reporting",
      "research",
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:reporting",
        message: "Could not inspect Reporting; using its local identity.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain("/private/");
  });

  it("keeps degraded cache policy outside the public graph contract", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () => ({
        agents: [],
        cacheable: false,
        warnings: [],
      })),
    };

    const built = await new StaticSystemGraphBuilder(
      inventory,
      vi.fn(async () => []),
    ).build(scope);

    expect(built.cacheable).toBe(false);
    expect(built.graph).toEqual({
      kind: "system",
      scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
      nodes: [],
      edges: [],
      warnings: [],
    });
    expect(built.graph).not.toHaveProperty("cacheable");
  });
});
