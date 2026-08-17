#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  verifyManagedAgentFixtureBytes,
  waitForManagedAgentFixturePids,
} from "./fixture.js";
import {
  MANAGED_AGENT_CONTRACT,
  assertManagedAgentDirectGatewayOrigin,
  resolveManagedAgentModelTarget,
} from "./contract.js";
import { createLocalManagedAgentProcessObserver } from "./process-observer.js";
import {
  qualifiedManagedAgentMcpToolName,
  runManagedAgentProbe,
} from "./runtime.js";
import type {
  ManagedAgentModelTargetId,
  ManagedAgentPermissionReason,
  ManagedAgentProbeResult,
  ManagedAgentProbeScenario,
} from "./types.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ManagedAgentProbeCliArgs {
  readonly help: boolean;
  readonly live: boolean;
  readonly target?: ManagedAgentModelTargetId;
  readonly scenario?: ManagedAgentProbeScenario;
}

export interface ManagedAgentProbeCheck {
  readonly id: string;
  readonly passed: boolean;
}

export interface ManagedAgentProbeReport {
  readonly outcome: "pass" | "fail";
  readonly checks: readonly ManagedAgentProbeCheck[];
  readonly result: ManagedAgentProbeResult;
}

export class ManagedAgentProbeCliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManagedAgentProbeCliError";
  }
}

interface ManagedAgentExpectedL1ToolStep {
  readonly toolName: string;
  readonly completion: "success" | "error";
  readonly decision: "allow" | "deny";
  readonly reason: ManagedAgentPermissionReason;
}

const MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE = [
  {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
  },
  {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
  },
  {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
  },
  {
    toolName: "Read",
    completion: "error",
    decision: "deny",
    reason: "path_outside_workspace",
  },
  {
    toolName: "Read",
    completion: "error",
    decision: "deny",
    reason: "path_symlink_escape",
  },
  {
    toolName: "Edit",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
  },
  {
    toolName: "Write",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
  },
  {
    toolName: qualifiedManagedAgentMcpToolName("echo_nonce"),
    completion: "success",
    decision: "allow",
    reason: "managed_mcp_tool",
  },
  {
    toolName: qualifiedManagedAgentMcpToolName("fail_once"),
    completion: "error",
    decision: "allow",
    reason: "managed_mcp_tool",
  },
  {
    toolName: qualifiedManagedAgentMcpToolName("fail_once"),
    completion: "success",
    decision: "allow",
    reason: "managed_mcp_tool",
  },
  {
    toolName: "Bash",
    completion: "success",
    decision: "allow",
    reason: "exact_bash_command",
  },
] as const satisfies readonly ManagedAgentExpectedL1ToolStep[];

function hasExactManagedAgentL1ToolTrace(
  result: ManagedAgentProbeResult,
): boolean {
  const requested = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const completed = result.toolEvidence.filter(
    ({ status }) => status !== "requested",
  );
  const primaryDecisions = result.permissionEvidence.filter(
    ({ source }) => source === "pre_tool_use",
  );
  if (
    requested.length !== MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE.length ||
    completed.length !== MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE.length ||
    primaryDecisions.length !== MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE.length ||
    result.permissionEvidence.length !== primaryDecisions.length
  ) {
    return false;
  }
  const requestedIds = requested.flatMap(({ toolUseId }) =>
    toolUseId ? [toolUseId] : [],
  );
  if (
    requestedIds.length !== requested.length ||
    new Set(requestedIds).size !== requestedIds.length
  ) {
    return false;
  }

  return MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE.every((expected, index) => {
    const request = requested[index];
    if (!request?.toolUseId || request.toolName !== expected.toolName) {
      return false;
    }
    const completions = completed.filter(
      ({ toolUseId }) => toolUseId === request.toolUseId,
    );
    const decisions = primaryDecisions.filter(
      ({ toolUseId }) => toolUseId === request.toolUseId,
    );
    return (
      completions.length === 1 &&
      completions[0]?.toolName === expected.toolName &&
      completions[0]?.status === expected.completion &&
      decisions.length === 1 &&
      decisions[0]?.toolName === expected.toolName &&
      decisions[0]?.decision === expected.decision &&
      decisions[0]?.reason === expected.reason
    );
  });
}

function hasExactManagedAgentL2BashTrace(
  result: ManagedAgentProbeResult,
): boolean {
  const requested = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const completed = result.toolEvidence.filter(
    ({ status }) => status !== "requested",
  );
  const primaryDecisions = result.permissionEvidence.filter(
    ({ source }) => source === "pre_tool_use",
  );
  const request = requested[0];
  return Boolean(
    requested.length === 1 &&
    request?.toolUseId &&
    request.toolName === "Bash" &&
    completed.length <= 1 &&
    completed.every(
      (evidence) =>
        evidence.toolUseId === request.toolUseId &&
        evidence.toolName === "Bash" &&
        evidence.status === "error",
    ) &&
    primaryDecisions.length === 1 &&
    result.permissionEvidence.length === 1 &&
    primaryDecisions[0]?.toolUseId === request.toolUseId &&
    primaryDecisions[0]?.toolName === "Bash" &&
    primaryDecisions[0]?.decision === "allow" &&
    primaryDecisions[0]?.reason === "exact_bash_command",
  );
}

export function managedAgentProbeUsage(): string {
  return [
    "Usage:",
    "  pnpm --filter @sapiom/harness probe:managed-agent -- --live --scenario <L1|L2> --target <sonnet-5|minimax-m3>",
    "",
    "Required environment (dedicated eval access only):",
    "  LLM_GATEWAY_BASE_URL",
    "  LLM_GATEWAY_EVAL_API_KEY",
    "",
    "Credentials are intentionally not accepted as command-line arguments.",
  ].join("\n");
}

export function parseManagedAgentProbeCliArgs(
  argv: readonly string[],
): ManagedAgentProbeCliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, live: false };
  }
  let live = false;
  let target: ManagedAgentModelTargetId | undefined;
  let scenario: ManagedAgentProbeScenario | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live") {
      live = true;
      continue;
    }
    if (argument === "--target") {
      const value = argv[++index];
      if (value !== "sonnet-5" && value !== "minimax-m3") {
        throw new ManagedAgentProbeCliError(
          "--target must be sonnet-5 or minimax-m3",
        );
      }
      target = value;
      continue;
    }
    if (argument === "--scenario") {
      const value = argv[++index];
      if (value !== "L1" && value !== "L2") {
        throw new ManagedAgentProbeCliError("--scenario must be L1 or L2");
      }
      scenario = value;
      continue;
    }
    throw new ManagedAgentProbeCliError(
      `Unknown argument: ${String(argument)}`,
    );
  }
  if (!live) {
    throw new ManagedAgentProbeCliError(
      "Refusing to run without --live; hermetic tests never contact the gateway",
    );
  }
  if (!target || !scenario) {
    throw new ManagedAgentProbeCliError("--target and --scenario are required");
  }
  return { help: false, live, target, scenario };
}

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new ManagedAgentProbeCliError(`${name} is required`);
  return value;
}

export function assertManagedAgentCertificationNodeVersion(
  runtimeVersion: string,
): void {
  if (runtimeVersion !== MANAGED_AGENT_CONTRACT.certificationNodeVersion) {
    throw new ManagedAgentProbeCliError(
      `Live probes require Node ${MANAGED_AGENT_CONTRACT.certificationNodeVersion}; current runtime is ${runtimeVersion}`,
    );
  }
}

export function assertManagedAgentCancellationHostPlatform(
  platform: NodeJS.Platform,
): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ManagedAgentProbeCliError(
      "L2 certification supports only the reviewed detached POSIX fixture containment model",
    );
  }
}

export function evaluateManagedAgentProbe(
  result: ManagedAgentProbeResult,
  fixturePids: readonly number[] = [],
): ManagedAgentProbeReport {
  const requestedTools = new Set(
    result.toolEvidence
      .filter(({ status }) => status === "requested")
      .map(({ toolName }) => toolName),
  );
  const invocation = (toolName: string, status: "success" | "error"): boolean =>
    result.toolEvidence.some(
      (evidence) =>
        evidence.toolName === toolName && evidence.status === status,
    );
  const permission = (
    toolName: string,
    decision: "allow" | "deny",
    reason: ManagedAgentPermissionReason,
  ): boolean =>
    result.permissionEvidence.some(
      (evidence) =>
        evidence.toolName === toolName &&
        evidence.decision === decision &&
        evidence.reason === reason &&
        evidence.source === "pre_tool_use",
    );
  const requestedToolIds = result.toolEvidence.flatMap((evidence) =>
    evidence.status === "requested" && evidence.toolUseId
      ? [evidence.toolUseId]
      : [],
  );
  const universalHookCoverage =
    requestedToolIds.length > 0 &&
    new Set(requestedToolIds).size === requestedToolIds.length &&
    requestedToolIds.every(
      (toolUseId) =>
        result.permissionEvidence.filter(
          (evidence) =>
            evidence.toolUseId === toolUseId &&
            evidence.source === "pre_tool_use",
        ).length === 1,
    );
  const checks: ManagedAgentProbeCheck[] = [
    {
      id: "exact_model_alias",
      passed:
        result.modelAlias ===
        resolveManagedAgentModelTarget(result.target).alias,
    },
    { id: "sdk_session_observed", passed: Boolean(result.sdkSessionId) },
    { id: "query_closed", passed: result.queryClosed },
    { id: "process_tree_quiescent", passed: result.teardown.quiescent },
    {
      id: "universal_policy_hook_coverage",
      passed: result.policyHookCoverage && universalHookCoverage,
    },
    {
      id: "bounded_inference_turn_evidence",
      passed:
        Number.isInteger(result.inferenceTurns) &&
        result.inferenceTurns > 0 &&
        result.inferenceTurns <= MANAGED_AGENT_CONTRACT.maxTurns &&
        (result.sdkNumTurns === undefined ||
          (Number.isInteger(result.sdkNumTurns) &&
            result.sdkNumTurns >= 0 &&
            result.sdkNumTurns <= MANAGED_AGENT_CONTRACT.maxTurns)),
    },
    {
      id: "dirty_and_untracked_preserved",
      passed:
        result.preservation.length === 2 &&
        result.preservation.every(({ preserved }) => preserved),
    },
  ];

  if (result.scenario === "L1") {
    checks.push(
      { id: "terminal_success", passed: result.terminal === "success" },
      {
        id: "exact_l1_tool_trace",
        passed: hasExactManagedAgentL1ToolTrace(result),
      },
      {
        id: "clean_target_modified",
        passed: result.workspaceChanges.some(
          ({ path, change }) =>
            path === FIXTURE_PATHS.cleanTarget && change === "modified",
        ),
      },
      {
        id: "managed_output_created",
        passed: result.workspaceChanges.some(
          ({ path, change }) =>
            path === FIXTURE_PATHS.createdTarget && change === "created",
        ),
      },
      {
        id: "builtin_tools_succeeded",
        passed: ["Read", "Edit", "Write", "Bash"].every(
          (name) => requestedTools.has(name) && invocation(name, "success"),
        ),
      },
      {
        id: "mcp_echo_succeeded",
        passed: invocation(
          qualifiedManagedAgentMcpToolName("echo_nonce"),
          "success",
        ),
      },
      {
        id: "mcp_failure_recovered",
        passed:
          invocation(qualifiedManagedAgentMcpToolName("fail_once"), "error") &&
          invocation(qualifiedManagedAgentMcpToolName("fail_once"), "success"),
      },
      {
        id: "expected_permissions_allowed",
        passed:
          ["Read", "Edit", "Write"].every((toolName) =>
            permission(toolName, "allow", "fixture_path"),
          ) &&
          permission("Bash", "allow", "exact_bash_command") &&
          permission(
            qualifiedManagedAgentMcpToolName("echo_nonce"),
            "allow",
            "managed_mcp_tool",
          ) &&
          permission(
            qualifiedManagedAgentMcpToolName("fail_once"),
            "allow",
            "managed_mcp_tool",
          ),
      },
      {
        id: "outside_and_symlink_denied",
        passed:
          permission("Read", "deny", "path_outside_workspace") &&
          permission("Read", "deny", "path_symlink_escape"),
      },
    );
  } else {
    checks.push(
      { id: "terminal_cancelled", passed: result.terminal === "cancelled" },
      {
        id: "exact_l2_bash_only_trace",
        passed: hasExactManagedAgentL2BashTrace(result),
      },
      { id: "cancellation_requested", passed: result.cancellationRequested },
      {
        id: "teardown_within_five_seconds",
        passed: result.teardown.quiescent && result.teardown.deadlineMet,
      },
      {
        id: "l2_containment_prepared",
        passed:
          result.teardown.processTableAvailable &&
          result.teardown.containmentSupported &&
          result.teardown.ownershipProven &&
          result.teardown.forceKillIssued,
      },
      {
        id: "fixture_processes_observed",
        passed:
          fixturePids.length === 2 &&
          fixturePids.every((pid) =>
            result.teardown.observedPids.includes(pid),
          ),
      },
      {
        id: "no_fixture_process_alive",
        passed: fixturePids.every(
          (pid) => !result.teardown.alivePidsAtDeadline.includes(pid),
        ),
      },
    );
  }

  return {
    outcome: checks.every(({ passed }) => passed) ? "pass" : "fail",
    checks,
    result,
  };
}

export async function executeManagedAgentProbeCli(
  argv: readonly string[],
  environment: Environment = process.env,
  runtimeNodeVersion = process.versions.node,
  runtimePlatform: NodeJS.Platform = process.platform,
): Promise<
  ManagedAgentProbeReport | { readonly help: true; readonly usage: string }
> {
  const args = parseManagedAgentProbeCliArgs(argv);
  if (args.help) return { help: true, usage: managedAgentProbeUsage() };

  // Validate the immutable runtime before reading the dedicated credential.
  assertManagedAgentCertificationNodeVersion(runtimeNodeVersion);
  if (args.scenario === "L2") {
    assertManagedAgentCancellationHostPlatform(runtimePlatform);
  }
  const gatewayOrigin = assertManagedAgentDirectGatewayOrigin(
    requiredEnvironmentValue(environment, "LLM_GATEWAY_BASE_URL"),
  );
  const gatewayCredential = requiredEnvironmentValue(
    environment,
    "LLM_GATEWAY_EVAL_API_KEY",
  );
  const fixture = await createManagedAgentFixture();
  const observer = createLocalManagedAgentProcessObserver();
  let fixturePids: readonly number[] = [];
  try {
    const scenario = args.scenario!;
    const result = await runManagedAgentProbe(
      {
        scenario,
        workspaceRoot: fixture.workspaceRoot,
        configRoot: fixture.configRoot,
        target: args.target!,
        gatewayOrigin,
        gatewayCredential,
        prompt: fixture.prompt(scenario),
        maxTurns: scenario === "L1" ? 18 : 4,
        maxBudgetUsd: 0.5,
        allowedBashCommands: [
          scenario === "L1" ? fixture.l1BashCommand : fixture.l2BashCommand,
        ],
        ...(scenario === "L1" ? { expectedMcpNonce: fixture.nonce } : {}),
        preservePaths: [
          FIXTURE_PATHS.dirtySentinel,
          FIXTURE_PATHS.untrackedSentinel,
        ],
      },
      {
        processObserver: observer,
        ...(scenario === "L2"
          ? {
              waitForCancellationSignal: async (signal: AbortSignal) => {
                fixturePids = await waitForManagedAgentFixturePids(
                  fixture,
                  15_000,
                  signal,
                );
                // The model-writable PID file is evidence only. Readiness is
                // derived first from the trusted root handle and bounded host
                // process table. These IDs are compared outside the observer
                // and never become signal targets.
                const readiness = await observer.prepareCancellation();
                if (!readiness.supported) {
                  throw new ManagedAgentProbeCliError(
                    `L2 containment preparation failed: ${readiness.reason}`,
                  );
                }
                if (
                  !fixturePids.every((pid) =>
                    readiness.observedPids.includes(pid),
                  )
                ) {
                  throw new ManagedAgentProbeCliError(
                    "L2 fixture PIDs were not both present in the host-observed owned process group",
                  );
                }
              },
            }
          : {}),
      },
    );
    const bytePreservation = await verifyManagedAgentFixtureBytes(fixture);
    const resultWithByteEvidence: ManagedAgentProbeResult = {
      ...result,
      preservation: bytePreservation,
    };
    return evaluateManagedAgentProbe(resultWithByteEvidence, fixturePids);
  } finally {
    observer.dispose();
    await fixture.cleanup();
  }
}

async function main(): Promise<void> {
  try {
    const report = await executeManagedAgentProbeCli(process.argv.slice(2));
    if ("help" in report) {
      process.stdout.write(`${report.usage}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome !== "pass") process.exitCode = 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown probe failure";
    process.stderr.write(`managed-agent probe: ${message}\n`);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryUrl === import.meta.url) void main();
