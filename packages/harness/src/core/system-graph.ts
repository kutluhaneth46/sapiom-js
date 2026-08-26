import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";

import type {
  AgentKey,
  GraphWarning,
  SystemGraph,
  SystemGraphEdge,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "../shared/system-graph.js";
import type { WorkflowInfo } from "../shared/types.js";
import { detectWorkflowLaunches } from "./canvas-interconnections.js";

export interface WorkspaceScope {
  workspaceKey: WorkspaceKey;
  root: string;
}

export interface LocalAgentInventoryItem {
  agentKey: AgentKey;
  definitionSlug: string | null;
  label: string;
  sourceRoot: string;
}

export interface WorkspaceScopeResolver {
  resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null>;
}

export interface WorkspaceScopeCatalog extends WorkspaceScopeResolver {
  list(): Promise<WorkspaceScopeSummary[]>;
}

export interface LocalAgentInventoryReader {
  list(scope: WorkspaceScope): Promise<LocalAgentInventoryItem[]>;
}

export interface SystemGraphBuilder {
  build(scope: WorkspaceScope): Promise<SystemGraph>;
}

type LaunchDetector = typeof detectWorkflowLaunches;

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function workspaceKeyForRoot(root: string): WorkspaceKey {
  return `workspace-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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
      const canonical = canonicalRoot(root);
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
      const canonical = canonicalRoot(root);
      if (workspaceKeyForRoot(canonical) === workspaceKey) {
        return { workspaceKey, root: canonical };
      }
    }
    return null;
  }
}

export class WorkflowRegistryInventoryReader implements LocalAgentInventoryReader {
  constructor(private readonly listWorkflows: () => readonly WorkflowInfo[]) {}

  async list(scope: WorkspaceScope): Promise<LocalAgentInventoryItem[]> {
    const items = this.listWorkflows()
      .map((workflow): LocalAgentInventoryItem | null => {
        const sourceRoot = canonicalRoot(workflow.path);
        if (!isWithin(scope.root, sourceRoot)) return null;
        const relative = path
          .relative(scope.root, sourceRoot)
          .split(path.sep)
          .join("/");
        const localKey = relative || path.basename(sourceRoot) || "root";
        return {
          agentKey: workflow.definitionSlug ?? `local:${localKey}`,
          definitionSlug: workflow.definitionSlug,
          label: workflow.name,
          sourceRoot,
        };
      })
      .filter((item): item is LocalAgentInventoryItem => item !== null);

    return items.sort(
      (left, right) =>
        left.agentKey.localeCompare(right.agentKey) ||
        left.sourceRoot.localeCompare(right.sourceRoot),
    );
  }
}

function warningOrder(left: GraphWarning, right: GraphWarning): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.agentKey ?? "").localeCompare(right.agentKey ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function fallbackAgentKey(scope: WorkspaceScope, sourceRoot: string): AgentKey {
  const relative = path.relative(scope.root, sourceRoot);
  if (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return `local:${relative.split(path.sep).join("/")}`;
  }
  // Injected inventory adapters may supply a root outside the selected scope.
  // Keep the fallback path-free while still making its identity deterministic.
  return `local:${createHash("sha256")
    .update(sourceRoot)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * A copied agent can retain another folder's definition slug. Keep both nodes
 * visible with stable local identities instead of emitting a wire payload the
 * browser must reject for duplicate node ids.
 */
function disambiguateAgentKeys(
  scope: WorkspaceScope,
  inventory: readonly LocalAgentInventoryItem[],
): LocalAgentInventoryItem[] {
  const counts = new Map<AgentKey, number>();
  for (const agent of inventory) {
    counts.set(agent.agentKey, (counts.get(agent.agentKey) ?? 0) + 1);
  }

  const used = new Set<AgentKey>();
  return [...inventory]
    .sort(
      (left, right) =>
        left.agentKey.localeCompare(right.agentKey) ||
        left.sourceRoot.localeCompare(right.sourceRoot),
    )
    .map((agent) => {
      const localKey = fallbackAgentKey(scope, agent.sourceRoot);
      const preferred = (counts.get(agent.agentKey) ?? 0) > 1
        ? localKey
        : agent.agentKey;
      let agentKey = preferred;
      let suffix = 2;
      while (used.has(agentKey)) {
        agentKey = `${localKey}~${suffix}`;
        suffix += 1;
      }
      used.add(agentKey);
      return agentKey === agent.agentKey ? agent : { ...agent, agentKey };
    });
}

export class StaticSystemGraphBuilder implements SystemGraphBuilder {
  constructor(
    private readonly inventory: LocalAgentInventoryReader,
    private readonly detectLaunches: LaunchDetector = detectWorkflowLaunches,
  ) {}

  async build(scope: WorkspaceScope): Promise<SystemGraph> {
    const agents = disambiguateAgentKeys(
      scope,
      await this.inventory.list(scope),
    );
    const nodes = agents.map((agent) => ({
      id: `agent:${agent.agentKey}`,
      agentKey: agent.agentKey,
      label: agent.label,
    }));
    const byTarget = new Map<string, LocalAgentInventoryItem[]>();
    const registerTarget = (
      key: string,
      agent: LocalAgentInventoryItem,
    ): void => {
      const candidates = byTarget.get(key) ?? [];
      if (!candidates.some((candidate) => candidate.agentKey === agent.agentKey)) {
        candidates.push(agent);
        byTarget.set(key, candidates);
      }
    };
    for (const agent of agents) {
      registerTarget(agent.agentKey, agent);
      if (agent.definitionSlug) registerTarget(agent.definitionSlug, agent);
    }

    const edges: SystemGraphEdge[] = [];
    const warnings: GraphWarning[] = [];
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
          warnings.push({
            code: "unresolved-target",
            agentKey: caller.agentKey,
            message:
              candidates.length === 0
                ? `${caller.label} invokes unknown agent ${launch.slug}.`
                : `${caller.label} invokes ambiguous agent ${launch.slug}.`,
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
