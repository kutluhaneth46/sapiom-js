import { describe, expect, it } from "vitest";

import {
  ManagedAgentProbeCliError,
  assertManagedAgentCancellationHostPlatform,
  assertManagedAgentCertificationNodeVersion,
  evaluateManagedAgentProbe,
  executeManagedAgentProbeCli,
  managedAgentProbeUsage,
  parseManagedAgentProbeCliArgs,
} from "./probe-cli.js";
import { FIXTURE_PATHS } from "./fixture.js";
import { qualifiedManagedAgentMcpToolName } from "./runtime.js";
import type { ManagedAgentProbeResult } from "./types.js";

function passingL1Result(): ManagedAgentProbeResult {
  const echoTool = qualifiedManagedAgentMcpToolName("echo_nonce");
  const failOnceTool = qualifiedManagedAgentMcpToolName("fail_once");
  const steps = [
    ["Read", "success", "allow", "fixture_path"],
    ["Read", "success", "allow", "fixture_path"],
    ["Read", "success", "allow", "fixture_path"],
    ["Read", "error", "deny", "path_outside_workspace"],
    ["Read", "error", "deny", "path_symlink_escape"],
    ["Edit", "success", "allow", "fixture_path"],
    ["Write", "success", "allow", "fixture_path"],
    [echoTool, "success", "allow", "managed_mcp_tool"],
    [failOnceTool, "error", "allow", "managed_mcp_tool"],
    [failOnceTool, "success", "allow", "managed_mcp_tool"],
    ["Bash", "success", "allow", "exact_bash_command"],
  ] as const;
  const ids = steps.map(
    (_, index) => `tool_${(index + 1).toString(16).padStart(64, "0")}`,
  );
  return {
    contractVersion: 1,
    runId: "run-1",
    scenario: "L1",
    target: "sonnet-5",
    modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
    sdkSessionId: "11111111-1111-4111-8111-111111111111",
    inferenceTurns: 8,
    sdkNumTurns: 8,
    policyHookCoverage: true,
    terminal: "success",
    terminationEvidence: {
      beforePolicyOverride: "success",
      queryExecution: "iteration_completed",
      sdkResult: "success",
    },
    events: [],
    toolEvidence: steps.flatMap(([toolName, completion], index) => [
      {
        toolUseId: ids[index],
        toolName,
        status: "requested" as const,
      },
      {
        toolUseId: ids[index],
        toolName,
        status: completion,
      },
    ]),
    permissionEvidence: steps.map(([toolName, , decision, reason], index) => ({
      toolUseId: ids[index]!,
      toolName,
      decision,
      reason,
      source: "pre_tool_use" as const,
    })),
    policyDiagnostics: [],
    workspaceChanges: [
      { path: FIXTURE_PATHS.cleanTarget, change: "modified" },
      { path: FIXTURE_PATHS.createdTarget, change: "created" },
    ],
    preservation: [
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ],
    cancellationRequested: false,
    queryClosed: true,
    teardown: {
      quiescent: true,
      deadlineMet: true,
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: false,
      forceKillIssued: false,
      elapsedMs: 5,
      observedPids: [],
      alivePidsAtDeadline: [],
      emergencyCleanupAttempted: false,
    },
    correlation: {
      executionId: "execution-1",
      evalSource: "eval-1",
      promptEmbedded: true,
    },
  };
}

function passingL2Result(): ManagedAgentProbeResult {
  const base = passingL1Result();
  const toolUseId = `tool_${"c".repeat(64)}`;
  return {
    ...base,
    scenario: "L2",
    inferenceTurns: 1,
    sdkNumTurns: 1,
    terminal: "cancelled",
    toolEvidence: [{ toolUseId, toolName: "Bash", status: "requested" }],
    permissionEvidence: [
      {
        toolUseId,
        toolName: "Bash",
        decision: "allow",
        reason: "exact_bash_command",
        source: "pre_tool_use",
      },
    ],
    workspaceChanges: [],
    cancellationRequested: true,
    teardown: {
      ...base.teardown,
      ownershipProven: true,
      forceKillIssued: true,
      observedPids: [12_345, 12_346],
    },
  };
}

function evidenceForToolId(
  result: ManagedAgentProbeResult,
  toolUseId: string,
): ManagedAgentProbeResult["toolEvidence"] {
  return result.toolEvidence.filter(
    (evidence) => evidence.toolUseId === toolUseId,
  );
}

describe("managed-agent probe CLI", () => {
  it("is opt-in and never accepts credentials through arguments", () => {
    expect(() =>
      parseManagedAgentProbeCliArgs([
        "--scenario",
        "L1",
        "--target",
        "sonnet-5",
      ]),
    ).toThrow("--live");
    expect(() =>
      parseManagedAgentProbeCliArgs([
        "--live",
        "--scenario",
        "L1",
        "--target",
        "sonnet-5",
        "--api-key",
        "secret",
      ]),
    ).toThrow("Unknown argument");
    expect(managedAgentProbeUsage()).toContain("LLM_GATEWAY_EVAL_API_KEY");
    expect(managedAgentProbeUsage()).not.toContain("--api-key");
  });

  it("refuses any model outside the two-value target allowlist", () => {
    expect(() =>
      parseManagedAgentProbeCliArgs([
        "--live",
        "--scenario",
        "L1",
        "--target",
        "arbitrary-model",
      ]),
    ).toThrow("sonnet-5 or minimax-m3");
  });

  it("checks exact Node before reading a dedicated credential", async () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get() {
          throw new Error("environment was read");
        },
      },
    );
    await expect(
      executeManagedAgentProbeCli(
        ["--live", "--scenario", "L1", "--target", "sonnet-5"],
        environment,
        "25.0.0",
      ),
    ).rejects.toThrow("Live probes require Node 22.23.2");
  });

  it("rejects an unexpected gateway origin before reading the eval key", async () => {
    const reads: string[] = [];
    const secret = "eval-secret-must-not-be-read";
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        LLM_GATEWAY_BASE_URL: "https://llm.services.proxy.sapiom.ai",
        LLM_GATEWAY_EVAL_API_KEY: secret,
      },
      {
        get(target, property: string) {
          reads.push(property);
          return target[property];
        },
      },
    );
    let failure: unknown;
    try {
      await executeManagedAgentProbeCli(
        ["--live", "--scenario", "L1", "--target", "sonnet-5"],
        environment,
        "22.23.2",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "pinned direct Sapiom gateway origin",
    );
    expect((failure as Error).message).not.toContain(secret);
    expect(reads).toEqual(["LLM_GATEWAY_BASE_URL"]);
  });

  it("reads eval auth only after accepting the pinned direct gateway", async () => {
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        LLM_GATEWAY_BASE_URL: "https://litellm.services.sapiom.ai/",
      },
      {
        get(target, property: string) {
          reads.push(property);
          return target[property];
        },
      },
    );
    await expect(
      executeManagedAgentProbeCli(
        ["--live", "--scenario", "L1", "--target", "sonnet-5"],
        environment,
        "22.23.2",
      ),
    ).rejects.toThrow("LLM_GATEWAY_EVAL_API_KEY is required");
    expect(reads).toEqual(["LLM_GATEWAY_BASE_URL", "LLM_GATEWAY_EVAL_API_KEY"]);
  });

  it("prints help without reading auth or opening a query", async () => {
    await expect(
      executeManagedAgentProbeCli(["--help"], {}, "0.0.0"),
    ).resolves.toEqual({ help: true, usage: managedAgentProbeUsage() });
  });

  it("exposes an explicit version assertion for automation", () => {
    expect(() =>
      assertManagedAgentCertificationNodeVersion("22.23.2"),
    ).not.toThrow();
    expect(() => assertManagedAgentCertificationNodeVersion("22.23.1")).toThrow(
      ManagedAgentProbeCliError,
    );
  });

  it("limits live L2 certification to the reviewed POSIX host model", () => {
    expect(() =>
      assertManagedAgentCancellationHostPlatform("darwin"),
    ).not.toThrow();
    expect(() =>
      assertManagedAgentCancellationHostPlatform("linux"),
    ).not.toThrow();
    expect(() => assertManagedAgentCancellationHostPlatform("win32")).toThrow(
      "detached POSIX fixture containment model",
    );
  });

  it("rejects Windows L2 before reading gateway or credential environment", async () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get() {
          throw new Error("environment was read");
        },
      },
    );

    await expect(
      executeManagedAgentProbeCli(
        ["--live", "--scenario", "L2", "--target", "sonnet-5"],
        environment,
        "22.23.2",
        "win32",
      ),
    ).rejects.toThrow("detached POSIX fixture containment model");
  });

  it("requires successful results from every built-in tool for L1", () => {
    const passing = passingL1Result();
    const result: ManagedAgentProbeResult = {
      ...passing,
      toolEvidence: passing.toolEvidence.map((evidence) =>
        evidence.toolName === "Bash" && evidence.status === "success"
          ? { ...evidence, status: "error" }
          : evidence,
      ),
    };

    expect(
      evaluateManagedAgentProbe(result).checks.find(
        ({ id }) => id === "builtin_tools_succeeded",
      ),
    ).toEqual({ id: "builtin_tools_succeeded", passed: false });
  });

  it("accepts exactly one permitted Bash request for L2 and rejects any extra tool call", () => {
    const passing = passingL2Result();
    expect(evaluateManagedAgentProbe(passing, [12_345, 12_346])).toMatchObject({
      outcome: "pass",
      checks: expect.arrayContaining([
        { id: "exact_l2_bash_only_trace", passed: true },
        { id: "l2_containment_prepared", passed: true },
      ]),
    });

    const writeId = `tool_${"d".repeat(64)}`;
    const invalid: ManagedAgentProbeResult = {
      ...passing,
      toolEvidence: [
        ...passing.toolEvidence,
        { toolUseId: writeId, toolName: "Write", status: "requested" },
        { toolUseId: writeId, toolName: "Write", status: "success" },
      ],
      permissionEvidence: [
        ...passing.permissionEvidence,
        {
          toolUseId: writeId,
          toolName: "Write",
          decision: "allow",
          reason: "fixture_path",
          source: "pre_tool_use",
        },
      ],
    };

    expect(
      evaluateManagedAgentProbe(invalid, [12_345, 12_346]).checks,
    ).toContainEqual({
      id: "exact_l2_bash_only_trace",
      passed: false,
    });
  });

  it.each([
    [
      "omitted",
      (passing: ManagedAgentProbeResult) => {
        const omittedId = passing.toolEvidence.find(
          (evidence) =>
            evidence.status === "requested" && evidence.toolName === "Read",
        )!.toolUseId!;
        return {
          ...passing,
          toolEvidence: passing.toolEvidence.filter(
            (evidence) => evidence.toolUseId !== omittedId,
          ),
          permissionEvidence: passing.permissionEvidence.filter(
            (evidence) => evidence.toolUseId !== omittedId,
          ),
        };
      },
    ],
    [
      "reordered",
      (passing: ManagedAgentProbeResult) => {
        const requested = passing.toolEvidence.filter(
          ({ status }) => status === "requested",
        );
        const editId = requested[5]!.toolUseId!;
        const writeId = requested[6]!.toolUseId!;
        const editEvidence = evidenceForToolId(passing, editId);
        const writeEvidence = evidenceForToolId(passing, writeId);
        const reordered = passing.toolEvidence.filter(
          ({ toolUseId }) => toolUseId !== editId && toolUseId !== writeId,
        );
        reordered.splice(10, 0, ...writeEvidence, ...editEvidence);
        return { ...passing, toolEvidence: reordered };
      },
    ],
    [
      "extra",
      (passing: ManagedAgentProbeResult) => {
        const toolUseId = `tool_${"a".repeat(64)}`;
        return {
          ...passing,
          toolEvidence: [
            ...passing.toolEvidence,
            { toolUseId, toolName: "Read", status: "requested" as const },
            { toolUseId, toolName: "Read", status: "success" as const },
          ],
          permissionEvidence: [
            ...passing.permissionEvidence,
            {
              toolUseId,
              toolName: "Read",
              decision: "allow" as const,
              reason: "fixture_path" as const,
              source: "pre_tool_use" as const,
            },
          ],
        };
      },
    ],
    [
      "duplicate retry",
      (passing: ManagedAgentProbeResult) => {
        const toolUseId = `tool_${"b".repeat(64)}`;
        return {
          ...passing,
          toolEvidence: [
            ...passing.toolEvidence,
            { toolUseId, toolName: "Bash", status: "requested" as const },
            { toolUseId, toolName: "Bash", status: "success" as const },
          ],
          permissionEvidence: [
            ...passing.permissionEvidence,
            {
              toolUseId,
              toolName: "Bash",
              decision: "allow" as const,
              reason: "exact_bash_command" as const,
              source: "pre_tool_use" as const,
            },
          ],
        };
      },
    ],
  ])("rejects an %s L1 tool trace", (_name, mutate) => {
    const report = evaluateManagedAgentProbe(mutate(passingL1Result()));

    expect(report.outcome).toBe("fail");
    expect(report.checks).toContainEqual({
      id: "exact_l1_tool_trace",
      passed: false,
    });
  });

  it("requires one completion and primary decision per L1 request, including fail_once error then success", () => {
    const passing = passingL1Result();
    const failOnceRequests = passing.toolEvidence.filter(
      ({ status, toolName }) =>
        status === "requested" &&
        toolName === qualifiedManagedAgentMcpToolName("fail_once"),
    );
    const firstFailOnceId = failOnceRequests[0]!.toolUseId!;
    const invalid: ManagedAgentProbeResult = {
      ...passing,
      toolEvidence: passing.toolEvidence.map((evidence) =>
        evidence.toolUseId === firstFailOnceId && evidence.status === "error"
          ? { ...evidence, status: "success" }
          : evidence,
      ),
    };

    expect(evaluateManagedAgentProbe(invalid).checks).toContainEqual({
      id: "exact_l1_tool_trace",
      passed: false,
    });
  });

  it("requires positive permission evidence and distinct lexical and symlink denials", () => {
    const passing = passingL1Result();
    expect(evaluateManagedAgentProbe(passing).outcome).toBe("pass");

    const falsePass: ManagedAgentProbeResult = {
      ...passing,
      permissionEvidence: [
        {
          toolUseId: `tool_${"a".repeat(64)}`,
          toolName: "Read",
          decision: "deny",
          reason: "path_outside_workspace",
          source: "pre_tool_use",
        },
        {
          toolUseId: `tool_${"b".repeat(64)}`,
          toolName: "Read",
          decision: "deny",
          reason: "path_outside_workspace",
          source: "pre_tool_use",
        },
      ],
    };
    const checks = evaluateManagedAgentProbe(falsePass);

    expect(checks.outcome).toBe("fail");
    expect(
      checks.checks.find(({ id }) => id === "expected_permissions_allowed"),
    ).toEqual({ id: "expected_permissions_allowed", passed: false });
    expect(
      checks.checks.find(({ id }) => id === "outside_and_symlink_denied"),
    ).toEqual({ id: "outside_and_symlink_denied", passed: false });
  });
});
