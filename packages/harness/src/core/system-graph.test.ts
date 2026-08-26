import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import {
  LocalWorkspaceScopeCatalog,
  StaticSystemGraphBuilder,
  WorkflowRegistryInventoryReader,
  type LocalAgentInventoryReader,
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
  it("gives a canonical root a stable opaque key and rejects unknown keys", () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      FIXTURE,
      path.join(FIXTURE, "."),
    ]);
    const scopes = catalog.list();

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.workspaceKey).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(scopes[0]!.workspaceKey).not.toContain(FIXTURE);
    expect(catalog.resolve(scopes[0]!.workspaceKey)?.root).toBe(FIXTURE);
    expect(catalog.resolve("workspace-not-known")).toBeNull();
  });

  it("does not collide when two roots share a basename", () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      "/tmp/one/project",
      "/tmp/two/project",
    ]);
    expect(
      new Set(catalog.list().map((scope) => scope.workspaceKey)).size,
    ).toBe(2);
  });
});

describe("WorkflowRegistryInventoryReader", () => {
  it("filters to the workspace boundary and uses a package-relative fallback key", async () => {
    const workflows = [
      workflow("Research", "research", "research"),
      workflow("Growth local", "growth", null),
      {
        ...workflow("Outside", "outside", "outside"),
        path: `${FIXTURE}-elsewhere/outside`,
      },
    ];
    const reader = new WorkflowRegistryInventoryReader(() => workflows);

    await expect(
      reader.list({ workspaceKey: "workspace-test", root: FIXTURE }),
    ).resolves.toEqual([
      {
        agentKey: "local:growth",
        definitionSlug: null,
        label: "Growth local",
        sourceRoot: path.join(FIXTURE, "growth"),
      },
      {
        agentKey: "research",
        definitionSlug: "research",
        label: "Research",
        sourceRoot: path.join(FIXTURE, "research"),
      },
    ]);
  });
});

describe("StaticSystemGraphBuilder", () => {
  const scope: WorkspaceScope = {
    workspaceKey: "workspace-fixture",
    root: FIXTURE,
  };

  it("projects the literal Research -> Growth launch into the public contract", async () => {
    const reader = new WorkflowRegistryInventoryReader(() => [
      workflow("Research", "research", "research"),
      workflow("Growth", "growth", "growth"),
    ]);

    const graph = await new StaticSystemGraphBuilder(reader).build(scope);

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
    const inventory: LocalAgentInventoryReader = {
      list: vi.fn(async () => [
        {
          agentKey: "research",
          definitionSlug: "research",
          label: "Research",
          sourceRoot: "/private/research",
        },
        {
          agentKey: "growth",
          definitionSlug: "growth",
          label: "Growth",
          sourceRoot: "/private/growth",
        },
      ]),
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

  it("degrades a scanner failure into a path-free warning", async () => {
    const inventory: LocalAgentInventoryReader = {
      list: vi.fn(async () => [
        {
          agentKey: "research",
          definitionSlug: "research",
          label: "Research",
          sourceRoot: "/private/research",
        },
      ]),
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
});
