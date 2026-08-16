import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CanUseTool,
  HookCallback,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ManagedAgentPermissionEvidence,
  ManagedAgentPermissionReason,
  ManagedAgentPermissionSource,
} from "./types.js";
import {
  normalizeManagedAgentToolUseId,
  sanitizeManagedAgentToolName,
} from "./events.js";

export const MANAGED_AGENT_BUILTIN_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
] as const;

export const MANAGED_AGENT_DISALLOWED_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "NotebookEdit",
  "SendMessage",
  "Skill",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
] as const;

export class ManagedAgentPathError extends Error {
  public constructor(
    public readonly reason:
      | "invalid_input"
      | "path_outside_workspace"
      | "path_symlink_escape",
  ) {
    super(reason);
    this.name = "ManagedAgentPathError";
  }
}

function comparisonPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const pathRelative = relative(
    comparisonPath(root),
    comparisonPath(candidate),
  );
  if (pathRelative === "") return true;
  return (
    !isAbsolute(pathRelative) &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`)
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
      ? Promise.reject(error)
      : false;
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let cursor = path;
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new ManagedAgentPathError("path_outside_workspace");
    }
    cursor = parent;
  }
  return cursor;
}

/**
 * Resolve an SDK tool target through the filesystem before authorizing it.
 * Existing symlinks are followed with realpath; new targets are authorized
 * only when their nearest existing parent resolves inside the canonical root.
 */
export async function resolveManagedAgentToolPath(
  canonicalWorkspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new ManagedAgentPathError("invalid_input");
  }
  const candidate = resolve(canonicalWorkspaceRoot, requestedPath);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, candidate)) {
    throw new ManagedAgentPathError("path_outside_workspace");
  }
  const existing = await nearestExistingParent(candidate);
  const canonicalExisting = await realpath(existing);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, canonicalExisting)) {
    throw new ManagedAgentPathError("path_symlink_escape");
  }
  if (existing === candidate) return canonicalExisting;

  const unresolvedTail = relative(existing, candidate);
  const resolvedCandidate = resolve(canonicalExisting, unresolvedTail);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, resolvedCandidate)) {
    throw new ManagedAgentPathError("path_outside_workspace");
  }
  return resolvedCandidate;
}

export interface ManagedAgentPolicyBoundaryOptions {
  readonly canonicalWorkspaceRoot: string;
  readonly allowedBashCommands: readonly string[];
  readonly allowedMcpTools: readonly string[];
  readonly onDecision: (evidence: ManagedAgentPermissionEvidence) => void;
  /** Test seam for proving cancellation after asynchronous path validation. */
  readonly resolveToolPath?: typeof resolveManagedAgentToolPath;
}

export interface ManagedAgentPolicyBoundary {
  /** Primary boundary: the SDK runs this before its own permission evaluation. */
  readonly preToolUseHook: HookCallback;
  /** Defense in depth when the SDK still surfaces an unresolved permission. */
  readonly canUseToolFallback: CanUseTool;
}

interface ManagedAgentPolicyDecision {
  readonly decision: "allow" | "deny";
  readonly reason: ManagedAgentPermissionReason;
  readonly updatedInput?: Record<string, unknown>;
}

interface ManagedAgentRecordedPolicyDecision extends ManagedAgentPolicyDecision {
  readonly source: ManagedAgentPermissionSource;
}

function permissionResult(
  policy: ManagedAgentPolicyDecision,
  toolUseID: string,
): PermissionResult {
  return policy.decision === "allow"
    ? {
        behavior: "allow",
        toolUseID,
        ...(policy.updatedInput
          ? { updatedInput: { ...policy.updatedInput } }
          : {}),
      }
    : {
        behavior: "deny",
        message: `Managed-agent permission denied: ${policy.reason}`,
        interrupt: false,
        toolUseID,
      };
}

function filePathFromInput(input: Record<string, unknown>): string | undefined {
  return typeof input.file_path === "string" && input.file_path.length > 0
    ? input.file_path
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function denied(
  reason: ManagedAgentPermissionReason,
): ManagedAgentPolicyDecision {
  return { decision: "deny", reason };
}

async function evaluateManagedAgentPolicy(
  options: ManagedAgentPolicyBoundaryOptions,
  allowedCommands: ReadonlySet<string>,
  allowedMcpTools: ReadonlySet<string>,
  toolName: string,
  rawInput: unknown,
  signal: AbortSignal,
): Promise<ManagedAgentPolicyDecision> {
  if (signal.aborted) return denied("policy_aborted");
  const input = asRecord(rawInput);
  if (!input) return denied("invalid_input");

  if (allowedMcpTools.has(toolName)) {
    return signal.aborted
      ? denied("policy_aborted")
      : {
          decision: "allow",
          reason: "managed_mcp_tool",
          updatedInput: { ...input },
        };
  }
  if (toolName === "Bash") {
    const command =
      typeof input.command === "string" ? input.command : undefined;
    if (!command) return denied("invalid_input");
    if (!allowedCommands.has(command)) {
      return denied("bash_command_not_allowed");
    }
    return signal.aborted
      ? denied("policy_aborted")
      : {
          decision: "allow",
          reason: "exact_bash_command",
          updatedInput: { ...input },
        };
  }
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
    const requestedPath = filePathFromInput(input);
    if (!requestedPath) return denied("invalid_input");
    try {
      const canonicalPath = await (
        options.resolveToolPath ?? resolveManagedAgentToolPath
      )(options.canonicalWorkspaceRoot, requestedPath);
      if (signal.aborted) return denied("policy_aborted");
      return {
        decision: "allow",
        reason: "fixture_path",
        updatedInput: { ...input, file_path: canonicalPath },
      };
    } catch (error) {
      if (signal.aborted) return denied("policy_aborted");
      return denied(
        error instanceof ManagedAgentPathError ? error.reason : "invalid_input",
      );
    }
  }
  return denied("tool_not_allowed");
}

/**
 * Build one universal host policy shared by the primary PreToolUse hook and a
 * canUseTool fallback. Decisions are deduplicated by raw tool-use ID so one
 * attempted tool produces exactly one normalized evidence record.
 */
export function createManagedAgentPolicyBoundary(
  options: ManagedAgentPolicyBoundaryOptions,
): ManagedAgentPolicyBoundary {
  const allowedCommands = new Set(options.allowedBashCommands);
  const allowedMcpTools = new Set(options.allowedMcpTools);
  const decisions = new Map<
    string,
    {
      readonly source: ManagedAgentPermissionSource;
      readonly pending: Promise<ManagedAgentRecordedPolicyDecision>;
    }
  >();

  const decide = async (
    toolUseID: string,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
    source: ManagedAgentPermissionSource,
  ): Promise<ManagedAgentRecordedPolicyDecision> => {
    const existing = decisions.get(toolUseID);
    if (existing) {
      if (signal.aborted) {
        return { ...denied("policy_aborted"), source };
      }
      // The only valid duplicate is the SDK consulting canUseTool after the
      // primary hook. A repeated primary ID or fallback-first sequence is
      // ambiguous and must never inherit an earlier allow decision.
      return source === "can_use_tool_fallback" &&
        existing.source === "pre_tool_use"
        ? existing.pending
        : { ...denied("invalid_input"), source };
    }
    const pending = evaluateManagedAgentPolicy(
      options,
      allowedCommands,
      allowedMcpTools,
      toolName,
      input,
      signal,
    ).then((policy) => {
      const recorded = { ...policy, source };
      options.onDecision({
        toolUseId: normalizeManagedAgentToolUseId(toolUseID),
        toolName: sanitizeManagedAgentToolName(toolName),
        decision: recorded.decision,
        reason: recorded.reason,
        source,
      });
      return recorded;
    });
    decisions.set(toolUseID, { source, pending });
    return pending;
  };

  const preToolUseHook: HookCallback = async (
    input,
    callbackToolUseID,
    { signal },
  ) => {
    const isPreToolUse = input.hook_event_name === "PreToolUse";
    const inputToolUseID = isPreToolUse ? input.tool_use_id : undefined;
    const identifiersMatch =
      !callbackToolUseID || callbackToolUseID === inputToolUseID;
    const toolUseID =
      callbackToolUseID ?? inputToolUseID ?? "invalid-tool-use-id";
    const policy = await decide(
      toolUseID,
      isPreToolUse ? input.tool_name : "unknown",
      isPreToolUse && identifiersMatch ? input.tool_input : undefined,
      signal,
      "pre_tool_use",
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: policy.decision,
        permissionDecisionReason: `Managed-agent policy: ${policy.reason}`,
        ...(policy.decision === "allow" && policy.updatedInput
          ? { updatedInput: { ...policy.updatedInput } }
          : {}),
      },
    };
  };

  const canUseToolFallback: CanUseTool = async (toolName, input, permission) =>
    permissionResult(
      await decide(
        permission.toolUseID,
        toolName,
        input,
        permission.signal,
        "can_use_tool_fallback",
      ),
      permission.toolUseID,
    );

  return { preToolUseHook, canUseToolFallback };
}
