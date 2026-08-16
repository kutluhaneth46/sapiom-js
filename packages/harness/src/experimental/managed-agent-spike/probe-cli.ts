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
  const pathDenials = result.permissionEvidence.filter(
    ({ decision, reason }) =>
      decision === "deny" && reason === "path_outside_workspace",
  ).length;
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
        id: "builtin_tools_observed",
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
      { id: "outside_and_symlink_denied", passed: pathDenials >= 2 },
    );
  } else {
    checks.push(
      { id: "terminal_cancelled", passed: result.terminal === "cancelled" },
      { id: "cancellation_requested", passed: result.cancellationRequested },
      {
        id: "teardown_within_five_seconds",
        passed: result.teardown.quiescent && result.teardown.deadlineMet,
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
): Promise<
  ManagedAgentProbeReport | { readonly help: true; readonly usage: string }
> {
  const args = parseManagedAgentProbeCliArgs(argv);
  if (args.help) return { help: true, usage: managedAgentProbeUsage() };

  // Validate the immutable runtime before reading the dedicated credential.
  assertManagedAgentCertificationNodeVersion(runtimeNodeVersion);
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
                observer.trackPids(fixturePids);
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
