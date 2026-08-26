import { createHash } from "node:crypto";

import type {
  GraphWarning,
  SystemGraph,
  SystemGraphEdge,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "../shared/system-graph.js";
import { detectWorkflowLaunches } from "./canvas-interconnections.js";
import {
  canonicalGraphPath,
  type AgentInventoryItem,
  type AgentInventoryProvider,
  type WorkspaceScope,
} from "./system-graph-inventory.js";

export { HarnessRegistryInventoryProvider } from "./system-graph-inventory.js";
export type {
  AgentInventoryItem,
  AgentInventoryProvider,
  AgentInventoryResult,
  AgentInventoryWarning,
  WorkspaceScope,
} from "./system-graph-inventory.js";

export interface WorkspaceScopeResolver {
  resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null>;
}

export interface WorkspaceScopeCatalog extends WorkspaceScopeResolver {
  list(): Promise<WorkspaceScopeSummary[]>;
}

export interface SystemGraphBuilder {
  build(scope: WorkspaceScope): Promise<SystemGraph>;
}

type LaunchDetector = typeof detectWorkflowLaunches;

function workspaceKeyForRoot(root: string): WorkspaceKey {
  return `workspace-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/**
 * Resolves only roots the running Studio already knows about. A caller cannot
 * manufacture a key and turn the graph endpoint into an arbitrary path scan.
 */
export class LocalWorkspaceScopeCatalog implements WorkspaceScopeCatalog {
  constructor(
    private readonly listRoots: () =>
      | readonly string[]
      | Promise<readonly string[]>,
  ) {}

  async list(): Promise<WorkspaceScopeSummary[]> {
    const byRoot = new Map<string, WorkspaceScopeSummary>();
    for (const root of await this.listRoots()) {
      const canonical = canonicalGraphPath(root);
      byRoot.set(canonical, {
        workspaceKey: workspaceKeyForRoot(canonical),
        cwd: root,
      });
    }
    return [...byRoot.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, summary]) => summary);
  }

  async resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null> {
    for (const root of await this.listRoots()) {
      const canonical = canonicalGraphPath(root);
      if (workspaceKeyForRoot(canonical) === workspaceKey) {
        return { workspaceKey, root: canonical };
      }
    }
    return null;
  }
}

function warningOrder(left: GraphWarning, right: GraphWarning): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.agentKey ?? "").localeCompare(right.agentKey ?? "") ||
    left.message.localeCompare(right.message)
  );
}

export class StaticSystemGraphBuilder implements SystemGraphBuilder {
  constructor(
    private readonly inventory: AgentInventoryProvider,
    private readonly detectLaunches: LaunchDetector = detectWorkflowLaunches,
  ) {}

  async build(scope: WorkspaceScope): Promise<SystemGraph> {
    const inventory = await this.inventory.listAgents(scope);
    const agents = [...inventory.agents].sort(
      (left, right) =>
        left.agentKey.localeCompare(right.agentKey) ||
        left.sourceRoot.localeCompare(right.sourceRoot),
    );
    const nodes = agents.map((agent) => ({
      id: `agent:${agent.agentKey}`,
      agentKey: agent.agentKey,
      label: agent.label,
    }));
    const byTarget = new Map<string, AgentInventoryItem[]>();
    const registerTarget = (key: string, agent: AgentInventoryItem): void => {
      const candidates = byTarget.get(key) ?? [];
      if (
        !candidates.some((candidate) => candidate.agentKey === agent.agentKey)
      ) {
        candidates.push(agent);
        byTarget.set(key, candidates);
      }
    };
    for (const agent of agents) {
      registerTarget(agent.agentKey, agent);
      for (const alias of agent.resolutionAliases) {
        registerTarget(alias, agent);
      }
    }

    const edges: SystemGraphEdge[] = [];
    const warnings: GraphWarning[] = [...inventory.warnings];
    const seenEdges = new Set<string>();

    // Source walks are independent. Run them together so first-open latency is
    // bounded by the slowest agent tree rather than the sum of every tree.
    const scans = await Promise.all(
      agents.map(async (caller) => {
        try {
          return {
            caller,
            launches: await this.detectLaunches(caller.sourceRoot, new Set()),
            failed: false as const,
          };
        } catch {
          return { caller, launches: [], failed: true as const };
        }
      }),
    );

    for (const { caller, launches, failed } of scans) {
      if (failed) {
        warnings.push({
          code: "projection-failed",
          agentKey: caller.agentKey,
          message: `Could not inspect ${caller.label}.`,
        });
        continue;
      }

      for (const launch of launches) {
        const candidates = byTarget.get(launch.slug) ?? [];
        if (candidates.length !== 1) {
          const target = /^[A-Za-z0-9@_.:-]+$/.test(launch.slug)
            ? launch.slug
            : null;
          warnings.push({
            code: "unresolved-target",
            agentKey: caller.agentKey,
            message:
              candidates.length === 0
                ? target
                  ? `${caller.label} invokes unknown agent ${target}.`
                  : `${caller.label} invokes an invalid agent target.`
                : `${caller.label} invokes ambiguous agent ${target ?? "target"}.`,
          });
          continue;
        }
        const target = candidates[0]!;
        if (target.agentKey === caller.agentKey) continue;
        const from = `agent:${caller.agentKey}`;
        const to = `agent:${target.agentKey}`;
        const edgeKey = `${from}\0${to}`;
        if (seenEdges.has(edgeKey)) {
          warnings.push({
            code: "duplicate-edge",
            agentKey: caller.agentKey,
            message: `${caller.label} invokes ${target.label} more than once.`,
          });
          continue;
        }
        seenEdges.add(edgeKey);
        edges.push({
          from,
          to,
          kind: "invokes",
          basis: "static",
          mode: "async",
        });
      }
    }

    edges.sort(
      (left, right) =>
        left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    );
    warnings.sort(warningOrder);

    return {
      kind: "system",
      scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
      nodes,
      edges,
      warnings,
    };
  }
}
