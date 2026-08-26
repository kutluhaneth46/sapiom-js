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

    const graph = await new StaticSystemGraphBuilder(inventory).build(scope);

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

    const graph = await new StaticSystemGraphBuilder(inventory, detect).build(
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

    const graph = await new StaticSystemGraphBuilder(inventory, detect).build(
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
        warnings: [],
      })),
    };
    const graph = await new StaticSystemGraphBuilder(
      inventory,
      vi.fn(async () => {
        throw new Error("boom at /private/research");
      }),
    ).build(scope);

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
      resolveManifestName: vi.fn(async () => FIXTURE),
    });

    const graph = await new StaticSystemGraphBuilder(
      inventory,
      vi.fn(async () => []),
    ).build(scope);

    expect(graph.nodes).toEqual([
      {
        id: "agent:local:reporting",
        agentKey: "local:reporting",
        label: "Local agent",
      },
    ]);
    expect(graph.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:reporting",
        message: "Could not inspect Local agent; using its local identity.",
      },
    ]);
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
        warnings: [
          {
            code: "inventory-extraction-failed" as const,
            agentKey: "local:reporting",
            message: "Could not inspect Reporting; using its local identity.",
          },
        ],
      })),
    };

    const graph = await new StaticSystemGraphBuilder(
      inventory,
      vi.fn(async () => []),
    ).build(scope);

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
});
