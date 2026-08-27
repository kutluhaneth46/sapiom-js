import {
  detectAgentInvocations,
  type AgentInvocationDetectionWarning,
  type AgentInvocationMode,
  type SourceEvidence,
} from "./canvas-interconnections.js";
import type { AgentInventoryItem } from "./system-graph-inventory.js";

export interface AgentRelationshipCandidate {
  /** Inventory key or definition slug to resolve after extraction. */
  target: string;
  mode: AgentInvocationMode;
  /** Internal-only evidence retained across callsite deduplication. */
  evidence: SourceEvidence[];
}

export type AgentRelationshipWarning = AgentInvocationDetectionWarning;

export interface AgentRelationshipProviderResult {
  relationships: AgentRelationshipCandidate[];
  warnings: AgentRelationshipWarning[];
}

/** Replaceable per-caller boundary consumed by the workspace graph projector. */
export interface AgentRelationshipProvider {
  listRelationships(
    caller: AgentInventoryItem,
  ): Promise<AgentRelationshipProviderResult>;
}

function evidenceOrder(left: SourceEvidence, right: SourceEvidence): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
}

const MODE_ORDER: Record<AgentInvocationMode, number> = {
  blocking: 0,
  async: 1,
};

/** V0 filesystem adapter. It remains syntax-only and has no inventory target
 * resolution, renderer, transport, deployment, or session dependencies. */
export class SourceAgentRelationshipProvider implements AgentRelationshipProvider {
  async listRelationships(
    caller: AgentInventoryItem,
  ): Promise<AgentRelationshipProviderResult> {
    const scan = await detectAgentInvocations(caller.sourceRoot, new Set());
    const grouped = new Map<string, AgentRelationshipCandidate>();

    for (const invocation of scan.invocations) {
      const key = `${invocation.slug}\0${invocation.mode}`;
      const relationship = grouped.get(key);
      if (relationship) {
        relationship.evidence.push(invocation.evidence);
      } else {
        grouped.set(key, {
          target: invocation.slug,
          mode: invocation.mode,
          evidence: [invocation.evidence],
        });
      }
    }

    const relationships = [...grouped.values()];
    for (const relationship of relationships) {
      relationship.evidence.sort(evidenceOrder);
    }
    relationships.sort(
      (left, right) =>
        left.evidence[0]!.file.localeCompare(right.evidence[0]!.file) ||
        left.evidence[0]!.line - right.evidence[0]!.line ||
        left.evidence[0]!.column - right.evidence[0]!.column ||
        MODE_ORDER[left.mode] - MODE_ORDER[right.mode] ||
        left.target.localeCompare(right.target),
    );

    return { relationships, warnings: scan.warnings };
  }
}
