import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

import { MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH } from "./events.js";
import {
  createManagedAgentPolicyBoundary,
  resolveManagedAgentToolPath,
} from "./permissions.js";
import type { ManagedAgentPermissionEvidence } from "./types.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "managed-agent-permission-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await Promise.all([
    writeFile(join(workspace, "inside.txt"), "inside"),
    writeFile(join(outside, "secret.txt"), "outside"),
  ]);
  await symlink(join(outside, "secret.txt"), join(workspace, "escape.txt"));
  await symlink(outside, join(workspace, "escape-dir"));
  workspace = await realpath(workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("symlink-aware managed-agent containment", () => {
  it("allows existing and new in-root paths", async () => {
    expect(await resolveManagedAgentToolPath(workspace, "inside.txt")).toBe(
      join(workspace, "inside.txt"),
    );
    expect(await resolveManagedAgentToolPath(workspace, "nested/new.txt")).toBe(
      join(workspace, "nested/new.txt"),
    );
  });

  it("distinguishes lexical outside-root paths from symlink escapes", async () => {
    const outsidePath = join(outside, "secret.txt");
    for (const requested of [
      outsidePath,
      "../outside/secret.txt",
      `${workspace}-evil/file.txt`,
    ]) {
      await expect(
        resolveManagedAgentToolPath(workspace, requested),
      ).rejects.toMatchObject({ reason: "path_outside_workspace" });
    }
    for (const requested of [
      "escape.txt",
      "escape-dir/secret.txt",
      "escape-dir/new.txt",
    ]) {
      await expect(
        resolveManagedAgentToolPath(workspace, requested),
      ).rejects.toMatchObject({ reason: "path_symlink_escape" });
    }
  });
});

function preToolUseInput(
  toolName: string,
  toolInput: unknown,
  toolUseId: string,
): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "11111111-1111-4111-8111-111111111111",
    transcript_path: join(workspace, "transcript.jsonl"),
    cwd: workspace,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

describe("managed-agent universal policy boundary", () => {
  it("can enforce an L2 Bash-only boundary before evaluating model-authored inputs", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    const boundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBuiltinTools: ["Bash"],
      allowedBashCommands: ["node .managed-agent-probe/long-running.mjs"],
      allowedMcpTools: [],
      onDecision: (decision) => evidence.push(decision),
    });
    const signal = new AbortController().signal;
    const invoke = (toolName: string, input: unknown, toolUseId: string) =>
      boundary.preToolUseHook(
        preToolUseInput(toolName, input, toolUseId),
        toolUseId,
        { signal },
      );

    await expect(
      invoke(
        "Write",
        {
          file_path: ".managed-agent-probe/processes.json",
          content: JSON.stringify({
            parentPid: process.pid,
            childPid: 2_147_483_646,
          }),
        },
        "l2-write",
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(
      invoke(
        "mcp__sapiom-managed-agent-spike__echo_nonce",
        { nonce: "x" },
        "l2-mcp",
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(
      invoke(
        "Bash",
        { command: "node .managed-agent-probe/long-running.mjs" },
        "l2-bash",
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    expect(
      evidence.map(({ toolName, decision, reason }) => ({
        toolName,
        decision,
        reason,
      })),
    ).toEqual([
      { toolName: "Write", decision: "deny", reason: "tool_not_allowed" },
      {
        toolName: "mcp__sapiom-managed-agent-spike__echo_nonce",
        decision: "deny",
        reason: "tool_not_allowed",
      },
      {
        toolName: "Bash",
        decision: "allow",
        reason: "exact_bash_command",
      },
    ]);
  });

  it("uses exact Bash equality and emits content-free decisions", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    const boundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: ["git status --short"],
      allowedMcpTools: ["mcp__probe__echo_nonce"],
      onDecision: (decision) => evidence.push(decision),
    });
    const signal = new AbortController().signal;
    let sequence = 0;
    const invoke = (toolName: string, input: unknown) => {
      const toolUseId = `tool-${++sequence}`;
      return boundary.preToolUseHook(
        preToolUseInput(toolName, input, toolUseId),
        toolUseId,
        { signal },
      );
    };

    await expect(
      invoke("Bash", { command: "git status --short" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: { command: "git status --short" },
      },
    });
    await expect(
      invoke("Bash", { command: "git status --short " }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const readInput = { file_path: "inside.txt", preserve: "metadata" };
    await expect(invoke("Read", readInput)).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: {
          file_path: join(workspace, "inside.txt"),
          preserve: "metadata",
        },
      },
    });
    await expect(
      invoke("Write", { file_path: "nested/new.txt", content: "safe" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: {
          file_path: join(workspace, "nested/new.txt"),
          content: "safe",
        },
      },
    });
    await expect(
      invoke("Read", { file_path: join(outside, "secret.txt") }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(
      invoke("Read", { file_path: "escape.txt" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(
      invoke("mcp__probe__echo_nonce", { nonce: "secret" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(invoke("WebFetch", {})).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    expect(
      evidence.map(({ decision, reason, source }) => [
        decision,
        reason,
        source,
      ]),
    ).toEqual([
      ["allow", "exact_bash_command", "pre_tool_use"],
      ["deny", "bash_command_not_allowed", "pre_tool_use"],
      ["allow", "fixture_path", "pre_tool_use"],
      ["allow", "fixture_path", "pre_tool_use"],
      ["deny", "path_outside_workspace", "pre_tool_use"],
      ["deny", "path_symlink_escape", "pre_tool_use"],
      ["allow", "managed_mcp_tool", "pre_tool_use"],
      ["deny", "tool_not_allowed", "pre_tool_use"],
    ]);
    expect(JSON.stringify(evidence)).not.toContain(join(outside, "secret.txt"));
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(JSON.stringify(evidence)).not.toContain("tool-3");
    expect(vi.isMockFunction(boundary.preToolUseHook)).toBe(false);
    expect(readInput).toEqual({
      file_path: "inside.txt",
      preserve: "metadata",
    });
  });

  it("rejects malformed hook identifiers before policy evaluation", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    const guardDiagnostics: Array<{
      reason: string;
      toolName: string;
      normalizedToolUseId?: string;
    }> = [];
    const resolveToolPath = vi.fn(async () => join(workspace, "inside.txt"));
    const boundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: [],
      allowedMcpTools: [],
      onDecision: (decision) => evidence.push(decision),
      onGuardRejection: (diagnostic) => guardDiagnostics.push(diagnostic),
      resolveToolPath,
    });
    const signal = new AbortController().signal;
    const overlong = "x".repeat(MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH + 1);
    const invalidIdentifiers: ReadonlyArray<
      readonly [inputToolUseId: unknown, callbackToolUseId: unknown]
    > = [
      [undefined, undefined],
      ["", undefined],
      ["   ", undefined],
      [overlong, undefined],
      ["valid-input-id", ""],
      ["valid-input-id", "   "],
      ["valid-input-id", overlong],
      ["valid-input-id", "mismatched-callback-id"],
    ];

    for (const [inputToolUseId, callbackToolUseId] of invalidIdentifiers) {
      const malformedInput = {
        ...preToolUseInput("Read", { file_path: "inside.txt" }, "placeholder"),
        tool_use_id: inputToolUseId,
      } as unknown as PreToolUseHookInput;
      await expect(
        boundary.preToolUseHook(
          malformedInput,
          callbackToolUseId as string | undefined,
          { signal },
        ),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("invalid_input"),
        },
      });
    }

    await expect(
      boundary.canUseToolFallback(
        "Read",
        { file_path: "inside.txt" },
        { signal, toolUseID: "", requestId: "invalid-fallback" },
      ),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("invalid_input"),
    });
    expect(resolveToolPath).not.toHaveBeenCalled();
    expect(evidence).toEqual([]);
    expect(
      guardDiagnostics.map(({ reason, toolName, normalizedToolUseId }) => ({
        reason,
        toolName,
        correlated: normalizedToolUseId !== undefined,
      })),
    ).toEqual([
      {
        reason: "input_tool_use_id_missing",
        toolName: "Read",
        correlated: false,
      },
      {
        reason: "input_tool_use_id_invalid",
        toolName: "Read",
        correlated: false,
      },
      {
        reason: "input_tool_use_id_invalid",
        toolName: "Read",
        correlated: false,
      },
      {
        reason: "input_tool_use_id_too_long",
        toolName: "Read",
        correlated: false,
      },
      {
        reason: "callback_tool_use_id_invalid",
        toolName: "Read",
        correlated: true,
      },
      {
        reason: "callback_tool_use_id_invalid",
        toolName: "Read",
        correlated: true,
      },
      {
        reason: "callback_tool_use_id_too_long",
        toolName: "Read",
        correlated: true,
      },
      {
        reason: "callback_tool_use_id_mismatch",
        toolName: "Read",
        correlated: true,
      },
    ]);
    const serializedDiagnostics = JSON.stringify(guardDiagnostics);
    expect(serializedDiagnostics).not.toContain("valid-input-id");
    expect(serializedDiagnostics).not.toContain("mismatched-callback-id");
    expect(serializedDiagnostics).not.toContain(overlong);

    await expect(
      boundary.preToolUseHook(
        preToolUseInput("Read", { file_path: "inside.txt" }, "valid-input-id"),
        undefined,
        { signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(resolveToolPath).toHaveBeenCalledOnce();
    expect(evidence).toHaveLength(1);
  });

  it("denies a concurrent duplicate primary identifier without sharing its pending allow", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    let releasePathResolution: (() => void) | undefined;
    let reportPathResolutionStarted: (() => void) | undefined;
    const pathResolutionStarted = new Promise<void>((resolveStarted) => {
      reportPathResolutionStarted = resolveStarted;
    });
    const releasePath = new Promise<void>((resolvePath) => {
      releasePathResolution = resolvePath;
    });
    const resolveToolPath = vi.fn(async () => {
      reportPathResolutionStarted?.();
      await releasePath;
      return join(workspace, "inside.txt");
    });
    const boundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: [],
      allowedMcpTools: [],
      onDecision: (decision) => evidence.push(decision),
      resolveToolPath,
    });
    const signal = new AbortController().signal;
    const toolUseId = "concurrent-tool-use-id";
    const first = boundary.preToolUseHook(
      preToolUseInput("Read", { file_path: "inside.txt" }, toolUseId),
      toolUseId,
      { signal },
    );
    await pathResolutionStarted;
    const duplicate = boundary.preToolUseHook(
      preToolUseInput("Read", { file_path: "inside.txt" }, toolUseId),
      toolUseId,
      { signal },
    );
    releasePathResolution?.();

    await expect(first).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(duplicate).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("invalid_input"),
      },
    });
    expect(resolveToolPath).toHaveBeenCalledOnce();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      decision: "allow",
      reason: "fixture_path",
      source: "pre_tool_use",
    });
  });

  it("deduplicates the fallback and records when only the fallback executes", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    const boundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: ["git status --short"],
      allowedMcpTools: [],
      onDecision: (decision) => evidence.push(decision),
    });
    const signal = new AbortController().signal;
    const toolUseID = "tool-deduplicated";
    await boundary.preToolUseHook(
      preToolUseInput("Read", { file_path: "inside.txt" }, toolUseID),
      toolUseID,
      { signal },
    );
    await expect(
      boundary.canUseToolFallback(
        "Read",
        { file_path: join(workspace, "inside.txt") },
        { signal, toolUseID, requestId: "request-1" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source).toBe("pre_tool_use");

    await expect(
      boundary.preToolUseHook(
        preToolUseInput(
          "Bash",
          { command: "touch must-not-inherit-allow" },
          toolUseID,
        ),
        toolUseID,
        { signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("invalid_input"),
      },
    });
    expect(evidence).toHaveLength(1);

    await expect(
      boundary.canUseToolFallback(
        "Bash",
        { command: "git status --short" },
        { signal, toolUseID: "fallback-only", requestId: "request-2" },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(evidence).toHaveLength(2);
    expect(evidence[1]?.source).toBe("can_use_tool_fallback");
  });

  it("fails closed when aborted before or during asynchronous path validation", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    const before = new AbortController();
    before.abort();
    const beforeBoundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: ["git status --short"],
      allowedMcpTools: [],
      onDecision: (decision) => evidence.push(decision),
    });
    await expect(
      beforeBoundary.preToolUseHook(
        preToolUseInput("Bash", { command: "git status --short" }, "before"),
        "before",
        { signal: before.signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("policy_aborted"),
      },
    });

    const during = new AbortController();
    const duringBoundary = createManagedAgentPolicyBoundary({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: [],
      allowedMcpTools: [],
      onDecision: (decision) => evidence.push(decision),
      resolveToolPath: async () => {
        during.abort();
        return join(workspace, "inside.txt");
      },
    });
    await expect(
      duringBoundary.preToolUseHook(
        preToolUseInput("Read", { file_path: "inside.txt" }, "during"),
        "during",
        { signal: during.signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("policy_aborted"),
      },
    });
    expect(evidence.map(({ reason }) => reason)).toEqual([
      "policy_aborted",
      "policy_aborted",
    ]);
  });
});
