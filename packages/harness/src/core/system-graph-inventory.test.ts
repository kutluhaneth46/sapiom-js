import { describe, expect, it, vi } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import {
  HarnessRegistryInventoryProvider,
  type WorkspaceScope,
} from "./system-graph-inventory.js";
import type { ManifestNameInspection } from "./definition-name.js";

const WORKSPACE = "/private/workspaces/acme";
const SCOPE: WorkspaceScope = {
  workspaceKey: "workspace-acme",
  root: WORKSPACE,
};

function workflow(
  name: string,
  relativePath: string,
  definitionSlug: string | null,
  overrides: Partial<WorkflowInfo> = {},
): WorkflowInfo {
  return {
    name,
    path: `${WORKSPACE}/${relativePath}`,
    definitionId: definitionSlug ? 1 : null,
    definitionSlug,
    source: "scan",
    ...overrides,
  };
}

function provider(
  workflows: readonly WorkflowInfo[],
  options: {
    scopes?: { workspaceKey: string; cwd: string }[];
    inspectManifestName?: (
      sourceRoot: string,
    ) => Promise<ManifestNameInspection>;
  } = {},
): HarnessRegistryInventoryProvider {
  return new HarnessRegistryInventoryProvider({
    listWorkflows: () => workflows,
    listWorkspaceScopes: () =>
      options.scopes ?? [{ workspaceKey: SCOPE.workspaceKey, cwd: SCOPE.root }],
    ...(options.inspectManifestName
      ? { inspectManifestName: options.inspectManifestName }
      : {}),
  });
}

describe("HarnessRegistryInventoryProvider", () => {
  it("returns every registry-known agent regardless of deployment, source, or relationships", async () => {
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      if (sourceRoot.endsWith("/growth")) {
        return { status: "found" as const, name: "growth-manifest" };
      }
      return { status: "absent" as const };
    });
    const inventory = provider(
      [
        workflow("Research package", "research", "research", {
          definitionId: 101,
        }),
        workflow("Growth package", "growth", null, { source: "connect" }),
        workflow("Reporting package", "reporting", null),
        {
          ...workflow("Outside", "outside", "outside"),
          path: `${WORKSPACE}-archive/outside`,
        },
      ],
      { inspectManifestName },
    );

    await expect(inventory.listAgents(SCOPE)).resolves.toEqual({
      agents: [
        {
          agentKey: "growth-manifest",
          definitionId: null,
          definitionSlug: null,
          label: "Growth package",
          resolutionAliases: ["growth-manifest"],
          sourceRoot: `${WORKSPACE}/growth`,
        },
        {
          agentKey: "local:reporting",
          definitionId: null,
          definitionSlug: null,
          label: "Reporting package",
          resolutionAliases: ["local:reporting"],
          sourceRoot: `${WORKSPACE}/reporting`,
        },
        {
          agentKey: "research",
          definitionId: 101,
          definitionSlug: "research",
          label: "Research package",
          resolutionAliases: ["research"],
          sourceRoot: `${WORKSPACE}/research`,
        },
      ],
      warnings: [],
    });
    expect(inspectManifestName).toHaveBeenCalledTimes(2);
    expect(inspectManifestName).not.toHaveBeenCalledWith(
      `${WORKSPACE}/research`,
    );
  });

  it("bounds manifest inspection concurrency and keeps partial results", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      started.push(sourceRoot);
      await gate;
      if (sourceRoot.endsWith("/broken")) {
        return { status: "failed" as const };
      }
      if (sourceRoot.endsWith("/thrown")) {
        throw new Error(`unreadable ${sourceRoot}`);
      }
      return sourceRoot.endsWith("/named")
        ? { status: "found" as const, name: "declared-name" }
        : { status: "absent" as const };
    });
    const inventoryPromise = provider(
      [
        workflow("Named", "named", null),
        workflow("Broken", "broken", null),
        workflow("Thrown", "thrown", null),
        workflow("Fallback", "fallback", null),
        workflow("Extra A", "extra-a", null),
        workflow("Extra B", "extra-b", null),
      ],
      { inspectManifestName },
    ).listAgents(SCOPE);

    await vi.waitFor(() => expect(started).toHaveLength(4));
    await Promise.resolve();
    expect(started).toHaveLength(4);
    release();
    const result = await inventoryPromise;

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "declared-name",
      "local:broken",
      "local:extra-a",
      "local:extra-b",
      "local:fallback",
      "local:thrown",
    ]);
    expect(result.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:broken",
        message: "Could not inspect Broken; using its local identity.",
      },
      {
        code: "inventory-extraction-failed",
        agentKey: "local:thrown",
        message: "Could not inspect Thrown; using its local identity.",
      },
    ]);
    expect(inspectManifestName).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(result.warnings)).not.toContain(WORKSPACE);
  });

  it("assigns each agent to its deepest known workspace", async () => {
    const nestedRoot = `${WORKSPACE}/experiments`;
    const scopes = [
      { workspaceKey: SCOPE.workspaceKey, cwd: SCOPE.root },
      { workspaceKey: "workspace-experiments", cwd: nestedRoot },
    ];
    const workflows = [
      workflow("Root agent", "", "root-agent"),
      workflow("Parent agent", "research", "research"),
      workflow("Nested agent", "experiments/evaluator", "evaluator"),
      {
        ...workflow("Prefix sibling", "sibling", "sibling"),
        path: `${WORKSPACE}-archive/sibling`,
      },
    ];

    const parent = await provider(workflows, { scopes }).listAgents(SCOPE);
    const nested = await provider(workflows, { scopes }).listAgents({
      workspaceKey: "workspace-experiments",
      root: nestedRoot,
    });

    expect(parent.agents.map((agent) => agent.agentKey)).toEqual([
      "research",
      "root-agent",
    ]);
    expect(nested.agents.map((agent) => agent.agentKey)).toEqual(["evaluator"]);
  });

  it("does not confuse same-basename roots or mixed Windows separators", async () => {
    const windowsScope: WorkspaceScope = {
      workspaceKey: "workspace-windows",
      root: "C:\\Users\\Demo\\project",
    };
    const scopes = [
      { workspaceKey: windowsScope.workspaceKey, cwd: windowsScope.root },
      {
        workspaceKey: "workspace-nested",
        cwd: "C:/Users/Demo/project/experiments",
      },
      { workspaceKey: "workspace-other", cwd: "D:\\Other\\project" },
    ];
    const workflows: WorkflowInfo[] = [
      {
        ...workflow("Windows parent", "unused", "windows-parent"),
        path: "c:/users/demo/project/main-agent",
      },
      {
        ...workflow("Windows nested", "unused", "windows-nested"),
        path: "C:\\Users\\Demo\\project\\experiments\\evaluator",
      },
      {
        ...workflow("Prefix sibling", "unused", "prefix-sibling"),
        path: "C:\\Users\\Demo\\project-old\\agent",
      },
      {
        ...workflow("Other basename", "unused", "other"),
        path: "D:\\Other\\project\\agent",
      },
    ];
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => workflows,
      listWorkspaceScopes: () => scopes,
    });

    const result = await inventory.listAgents(windowsScope);

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "windows-parent",
    ]);
  });

  it("preserves duplicate slugs with deterministic local identities and a warning", async () => {
    const result = await provider([
      workflow("First copy", "first", "shared"),
      workflow("Second copy", "second", "shared", { source: "connect" }),
    ]).listAgents(SCOPE);

    expect(result.agents).toMatchObject([
      {
        agentKey: "local:first",
        definitionSlug: "shared",
        resolutionAliases: ["shared"],
      },
      {
        agentKey: "local:second",
        definitionSlug: "shared",
        resolutionAliases: ["shared"],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain(WORKSPACE);
  });

  it("keeps a duplicated local candidate ambiguous after suffixing its node ids", async () => {
    const duplicate = workflow("Connected copy", "connected", null, {
      source: "connect",
    });

    const result = await provider([duplicate, { ...duplicate }]).listAgents(
      SCOPE,
    );

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "local:connected",
      "local:connected~2",
    ]);
    expect(result.agents.map((agent) => agent.resolutionAliases)).toEqual([
      ["local:connected"],
      ["local:connected"],
    ]);
    expect(result.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "local:connected",
        message:
          "Multiple agents use local:connected; kept each with a local identity.",
      },
    ]);
  });

  it("falls back to the selected scope if the read-only scope catalog is unavailable", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [workflow("Research", "research", "research")],
      listWorkspaceScopes: async () => {
        throw new Error("settings unavailable");
      },
    });

    await expect(inventory.listAgents(SCOPE)).resolves.toMatchObject({
      agents: [{ agentKey: "research" }],
      warnings: [],
    });
  });

  it("fails the provider call when the registry snapshot cannot be read", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: async () => {
        throw new Error("registry unavailable");
      },
      listWorkspaceScopes: () => [],
    });

    await expect(inventory.listAgents(SCOPE)).rejects.toThrow(
      "registry unavailable",
    );
  });
});
