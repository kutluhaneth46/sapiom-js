import { realpathSync } from "node:fs";
import * as path from "node:path";

import type {
  AgentKey,
  GraphWarning,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "../shared/system-graph.js";
import type { WorkflowInfo } from "../shared/types.js";

export interface WorkspaceScope {
  workspaceKey: WorkspaceKey;
  root: string;
}

export interface AgentInventoryItem {
  agentKey: AgentKey;
  definitionId: number | null;
  definitionSlug: string | null;
  label: string;
  resolutionAliases: string[];
  /** Internal filesystem evidence. Never serialize this into SystemGraph. */
  sourceRoot: string;
}

export interface AgentInventoryWarning {
  code: Extract<
    GraphWarning["code"],
    "duplicate-agent-key" | "inventory-extraction-failed"
  >;
  agentKey: AgentKey;
  message: string;
}

export interface AgentInventoryResult {
  agents: AgentInventoryItem[];
  warnings: AgentInventoryWarning[];
}

/** Read-only boundary between Studio's current registry and graph projection. */
export interface AgentInventoryProvider {
  listAgents(scope: WorkspaceScope): Promise<AgentInventoryResult>;
}

type ManifestNameResolver = (sourceRoot: string) => Promise<string | null>;

export interface HarnessRegistryInventoryProviderOptions {
  listWorkflows: () =>
    | readonly WorkflowInfo[]
    | Promise<readonly WorkflowInfo[]>;
  listWorkspaceScopes: () =>
    | readonly WorkspaceScopeSummary[]
    | Promise<readonly WorkspaceScopeSummary[]>;
  resolveManifestName?: ManifestNameResolver;
}

function isWindowsAbsolute(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input);
}

function pathApi(input: string): typeof path.posix {
  return isWindowsAbsolute(input) ? path.win32 : path.posix;
}

/**
 * Resolve with the input path's own flavor so mixed Windows separators remain
 * comparable even when the test process (or a future remote host) is POSIX.
 */
export function canonicalGraphPath(input: string): string {
  const windows = isWindowsAbsolute(input);
  const api = pathApi(input);
  const normalizedInput = windows ? input.replace(/\//g, "\\") : input;
  const resolved = api.resolve(normalizedInput);
  const matchesHost = windows === (process.platform === "win32");
  if (!matchesHost) return resolved;
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isWithinGraphPath(root: string, candidate: string): boolean {
  if (isWindowsAbsolute(root) !== isWindowsAbsolute(candidate)) return false;
  const api = pathApi(root);
  const relative = api.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${api.sep}`) &&
      !api.isAbsolute(relative))
  );
}

function graphPathIdentity(input: string): string {
  const canonical = canonicalGraphPath(input).replace(/\\/g, "/");
  return isWindowsAbsolute(input) ? canonical.toLowerCase() : canonical;
}

function pathDepth(input: string): number {
  return input.split(/[\\/]/).filter(Boolean).length;
}

function workspaceRelativeLocalKey(
  scopeRoot: string,
  sourceRoot: string,
): AgentKey {
  const api = pathApi(scopeRoot);
  const relative = api.relative(scopeRoot, sourceRoot);
  const local =
    relative === ""
      ? api.basename(sourceRoot) || "root"
      : relative.split(api.sep).join("/");
  return `local:${local}`;
}

function normalizedAlias(value: string | null): string | null {
  const alias = value?.trim() ?? "";
  if (
    alias === "" ||
    /[\0\r\n]/.test(alias) ||
    alias.includes("/") ||
    alias.includes("\\") ||
    path.posix.isAbsolute(alias) ||
    path.win32.isAbsolute(alias)
  ) {
    return null;
  }
  return alias;
}

function safeLabel(value: string, fallback: string): string {
  const label = value.trim();
  if (
    label === "" ||
    /[\0\r\n]/.test(label) ||
    path.posix.isAbsolute(label) ||
    path.win32.isAbsolute(label)
  ) {
    return fallback;
  }
  return label;
}

function uniqueAliases(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
}

interface KnownScope {
  depth: number;
  workspaceKey: WorkspaceKey;
  root: string;
}

interface PreparedAgent {
  candidateKey: AgentKey;
  fallbackKey: AgentKey;
  definitionId: number | null;
  definitionSlug: string | null;
  extractionFailed: boolean;
  label: string;
  resolutionAliases: string[];
  sourceRoot: string;
}

function preparedOrder(left: PreparedAgent, right: PreparedAgent): number {
  return (
    left.candidateKey.localeCompare(right.candidateKey) ||
    left.sourceRoot.localeCompare(right.sourceRoot) ||
    left.label.localeCompare(right.label)
  );
}

function warningOrder(
  left: AgentInventoryWarning,
  right: AgentInventoryWarning,
): number {
  return (
    left.code.localeCompare(right.code) ||
    left.agentKey.localeCompare(right.agentKey) ||
    left.message.localeCompare(right.message)
  );
}

/**
 * V0 inventory adapter. WorkflowRegistry's scan/connect flows remain the only
 * writers; this provider receives snapshots and performs no discovery or I/O
 * beyond the injected, cached manifest-name lookup.
 */
export class HarnessRegistryInventoryProvider implements AgentInventoryProvider {
  constructor(
    private readonly options: HarnessRegistryInventoryProviderOptions,
  ) {}

  async listAgents(scope: WorkspaceScope): Promise<AgentInventoryResult> {
    // A registry read is the one operation whose failure makes inventory
    // unavailable. Scope-catalog and per-agent enrichment failures degrade.
    const workflows = await this.options.listWorkflows();
    const selectedScope: WorkspaceScope = {
      workspaceKey: scope.workspaceKey,
      root: canonicalGraphPath(scope.root),
    };
    const knownScopes = await this.knownScopes(selectedScope);

    const owned = workflows
      .map((workflow) => ({
        workflow,
        sourceRoot: canonicalGraphPath(workflow.path),
      }))
      .filter(({ sourceRoot }) => {
        const owner = this.ownerOf(sourceRoot, knownScopes);
        return owner?.workspaceKey === selectedScope.workspaceKey;
      });

    const prepared = (
      await Promise.all(
        owned.map(({ workflow, sourceRoot }) =>
          this.prepareAgent(selectedScope, workflow, sourceRoot),
        ),
      )
    ).sort(preparedOrder);

    const candidateCounts = new Map<AgentKey, number>();
    for (const agent of prepared) {
      candidateCounts.set(
        agent.candidateKey,
        (candidateCounts.get(agent.candidateKey) ?? 0) + 1,
      );
    }

    const used = new Set<AgentKey>();
    const assigned = prepared.map((agent) => {
      const duplicate = (candidateCounts.get(agent.candidateKey) ?? 0) > 1;
      let agentKey = duplicate ? agent.fallbackKey : agent.candidateKey;
      if (used.has(agentKey)) agentKey = agent.fallbackKey;
      let suffix = 2;
      const base = agentKey;
      while (used.has(agentKey)) {
        agentKey = `${base}~${suffix}`;
        suffix += 1;
      }
      used.add(agentKey);
      return { agent, agentKey };
    });

    const warnings: AgentInventoryWarning[] = [];
    for (const candidateKey of [...candidateCounts.keys()].sort()) {
      if ((candidateCounts.get(candidateKey) ?? 0) < 2) continue;
      warnings.push({
        code: "duplicate-agent-key",
        agentKey: candidateKey,
        message: `Multiple agents use ${candidateKey}; kept each with a local identity.`,
      });
    }
    for (const { agent, agentKey } of assigned) {
      if (!agent.extractionFailed) continue;
      warnings.push({
        code: "inventory-extraction-failed",
        agentKey,
        message: `Could not inspect ${agent.label}; using its local identity.`,
      });
    }

    const agents = assigned
      .map(
        ({ agent, agentKey }): AgentInventoryItem => ({
          agentKey,
          definitionId: agent.definitionId,
          definitionSlug: agent.definitionSlug,
          label: agent.label,
          resolutionAliases: agent.resolutionAliases,
          sourceRoot: agent.sourceRoot,
        }),
      )
      .sort(
        (left, right) =>
          left.agentKey.localeCompare(right.agentKey) ||
          left.sourceRoot.localeCompare(right.sourceRoot),
      );

    warnings.sort(warningOrder);
    return { agents, warnings };
  }

  private async knownScopes(scope: WorkspaceScope): Promise<KnownScope[]> {
    let summaries: readonly WorkspaceScopeSummary[] = [];
    try {
      summaries = await this.options.listWorkspaceScopes();
    } catch {
      // The selected scope is sufficient for a usable partial inventory. A
      // later uncached graph request can recover once settings are readable.
    }

    const byRoot = new Map<string, KnownScope>();
    for (const summary of summaries) {
      const root = canonicalGraphPath(summary.cwd);
      byRoot.set(graphPathIdentity(root), {
        depth: pathDepth(root),
        workspaceKey: summary.workspaceKey,
        root,
      });
    }
    // The resolved endpoint scope is authoritative when a catalog snapshot
    // happens to contain an equivalent raw path with a stale key.
    byRoot.set(graphPathIdentity(scope.root), {
      ...scope,
      depth: pathDepth(scope.root),
    });
    return [...byRoot.values()];
  }

  private ownerOf(
    sourceRoot: string,
    scopes: readonly KnownScope[],
  ): KnownScope | null {
    return (
      scopes
        .filter((scope) => isWithinGraphPath(scope.root, sourceRoot))
        .sort(
          (left, right) =>
            right.depth - left.depth ||
            right.root.length - left.root.length ||
            left.workspaceKey.localeCompare(right.workspaceKey),
        )[0] ?? null
    );
  }

  private async prepareAgent(
    scope: WorkspaceScope,
    workflow: WorkflowInfo,
    sourceRoot: string,
  ): Promise<PreparedAgent> {
    const definitionSlug = normalizedAlias(workflow.definitionSlug);
    let manifestName: string | null = null;
    let extractionFailed = false;
    if (!definitionSlug && this.options.resolveManifestName) {
      try {
        manifestName = normalizedAlias(
          await this.options.resolveManifestName(sourceRoot),
        );
        extractionFailed = manifestName === null;
      } catch {
        extractionFailed = true;
      }
    }

    const fallbackKey = workspaceRelativeLocalKey(scope.root, sourceRoot);
    const candidateKey = definitionSlug ?? manifestName ?? fallbackKey;
    // Keep the pre-disambiguation candidate as an alias for every copy. When
    // duplicate local fallbacks exist, a caller targeting that candidate must
    // see ambiguity rather than silently resolving to the unsuffixed copy.
    const resolutionAliases = uniqueAliases([
      definitionSlug,
      manifestName,
      candidateKey,
    ]);
    return {
      candidateKey,
      fallbackKey,
      definitionId: workflow.definitionId,
      definitionSlug,
      extractionFailed,
      label: safeLabel(
        workflow.name,
        definitionSlug ?? manifestName ?? "Local agent",
      ),
      resolutionAliases,
      sourceRoot,
    };
  }
}
