import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ManagedAgentPermissionEvidence,
  ManagedAgentPermissionReason,
} from "./types.js";

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
    public readonly reason: "invalid_input" | "path_outside_workspace",
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
    throw new ManagedAgentPathError("path_outside_workspace");
  }
  if (existing === candidate) return canonicalExisting;

  const unresolvedTail = relative(existing, candidate);
  const resolvedCandidate = resolve(canonicalExisting, unresolvedTail);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, resolvedCandidate)) {
    throw new ManagedAgentPathError("path_outside_workspace");
  }
  return resolvedCandidate;
}

export interface ManagedAgentPermissionHandlerOptions {
  readonly canonicalWorkspaceRoot: string;
  readonly allowedBashCommands: readonly string[];
  readonly allowedMcpTools: readonly string[];
  readonly onDecision: (evidence: ManagedAgentPermissionEvidence) => void;
}

function permissionResult(
  decision: "allow" | "deny",
  toolUseID: string,
  reason: ManagedAgentPermissionReason,
): PermissionResult {
  return decision === "allow"
    ? { behavior: "allow", toolUseID }
    : {
        behavior: "deny",
        message: `Managed-agent permission denied: ${reason}`,
        interrupt: false,
        toolUseID,
      };
}

function filePathFromInput(input: Record<string, unknown>): string | undefined {
  return typeof input.file_path === "string" && input.file_path.length > 0
    ? input.file_path
    : undefined;
}

export function createManagedAgentPermissionHandler(
  options: ManagedAgentPermissionHandlerOptions,
): CanUseTool {
  const allowedCommands = new Set(options.allowedBashCommands);
  const allowedMcpTools = new Set(options.allowedMcpTools);

  return async (toolName, input, permission): Promise<PermissionResult> => {
    let decision: "allow" | "deny" = "deny";
    let reason: ManagedAgentPermissionReason = "tool_not_allowed";

    if (allowedMcpTools.has(toolName)) {
      decision = "allow";
      reason = "managed_mcp_tool";
    } else if (toolName === "Bash") {
      const command =
        typeof input.command === "string" ? input.command : undefined;
      if (!command) {
        reason = "invalid_input";
      } else if (allowedCommands.has(command)) {
        decision = "allow";
        reason = "exact_bash_command";
      } else {
        reason = "bash_command_not_allowed";
      }
    } else if (
      toolName === "Read" ||
      toolName === "Edit" ||
      toolName === "Write"
    ) {
      const requestedPath = filePathFromInput(input);
      if (!requestedPath) {
        reason = "invalid_input";
      } else {
        try {
          await resolveManagedAgentToolPath(
            options.canonicalWorkspaceRoot,
            requestedPath,
          );
          decision = "allow";
          reason = "fixture_path";
        } catch (error) {
          reason =
            error instanceof ManagedAgentPathError
              ? error.reason
              : "invalid_input";
        }
      }
    }

    options.onDecision({
      toolUseId: permission.toolUseID,
      toolName,
      decision,
      reason,
    });
    return permissionResult(decision, permission.toolUseID, reason);
  };
}
