import { randomUUID } from "node:crypto";

import {
  createSdkMcpServer,
  query as agentSdkQuery,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { validateManagedAgentProbeConfig } from "./contract.js";
import { buildManagedAgentChildEnvironment } from "./environment.js";
import { ManagedAgentEventError, ManagedAgentEventRecorder } from "./events.js";
import {
  captureManagedAgentWorkspaceSnapshot,
  diffManagedAgentWorkspaceSnapshots,
  observeManagedAgentPreservation,
} from "./fixture.js";
import {
  MANAGED_AGENT_BUILTIN_TOOLS,
  MANAGED_AGENT_DISALLOWED_TOOLS,
  createManagedAgentPolicyBoundary,
} from "./permissions.js";
import { createLocalManagedAgentProcessObserver } from "./process-observer.js";
import {
  assertManagedAgentHooksEnabled,
  buildManagedAgentSettingsGuardEnvironment,
} from "./settings-guard.js";
import type {
  ManagedAgentProbeConfig,
  ManagedAgentProbeDependencies,
  ManagedAgentProbeResult,
  ManagedAgentQuery,
  ManagedAgentTeardownObservation,
  ManagedAgentTerminalClassification,
  ManagedAgentToolEvidence,
} from "./types.js";

export const MANAGED_AGENT_MCP_SERVER_NAME = "sapiom-managed-agent-spike";
export const MANAGED_AGENT_TEARDOWN_TIMEOUT_MS = 5_000;
export const MANAGED_AGENT_CORRELATION_MARKER_VERSION =
  "SAPIOM_CERTIFICATION_CORRELATION_V1";
const QUERY_CLOSE_TIMEOUT_MS = 2_000;

type McpToolName = "echo_nonce" | "fail_once";

export interface ManagedAgentMcpRuntime {
  readonly server: McpSdkServerConfigWithInstance;
  readonly qualifiedToolNames: readonly string[];
  readonly invocations: readonly ManagedAgentToolEvidence[];
  readonly handlers: {
    readonly echoNonce: (input: { readonly nonce: string }) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
    readonly failOnce: () => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  };
}

export function qualifiedManagedAgentMcpToolName(name: McpToolName): string {
  return `mcp__${MANAGED_AGENT_MCP_SERVER_NAME}__${name}`;
}

export function createManagedAgentMcpRuntime(
  expectedEchoNonce?: string,
): ManagedAgentMcpRuntime {
  const invocations: ManagedAgentToolEvidence[] = [];
  let failOnceCalls = 0;
  const nonceSchema = { nonce: z.string().min(1).max(256) };
  const handlers = {
    async echoNonce({ nonce }: { readonly nonce: string }) {
      const matched =
        expectedEchoNonce === undefined || nonce === expectedEchoNonce;
      invocations.push({
        toolName: qualifiedManagedAgentMcpToolName("echo_nonce"),
        status: matched ? ("success" as const) : ("error" as const),
      });
      return matched
        ? { content: [{ type: "text" as const, text: nonce }] }
        : {
            content: [
              {
                type: "text" as const,
                text: "nonce did not match the untracked-file sentinel",
              },
            ],
            isError: true,
          };
    },
    async failOnce() {
      failOnceCalls += 1;
      const failed = failOnceCalls === 1;
      invocations.push({
        toolName: qualifiedManagedAgentMcpToolName("fail_once"),
        status: failed ? ("error" as const) : ("success" as const),
      });
      return failed
        ? {
            content: [
              {
                type: "text" as const,
                text: "planned managed-agent probe failure; retry once",
              },
            ],
            isError: true,
          }
        : {
            content: [
              {
                type: "text" as const,
                text: "planned managed-agent probe recovery succeeded",
              },
            ],
          };
    },
  };
  const echoNonce = tool(
    "echo_nonce",
    "Return the supplied nonce exactly for the local managed-agent probe.",
    nonceSchema,
    handlers.echoNonce,
    { alwaysLoad: true },
  );
  const failOnce = tool(
    "fail_once",
    "Return a planned error once, then succeed on the next call.",
    nonceSchema,
    handlers.failOnce,
    { alwaysLoad: true },
  );
  return {
    server: createSdkMcpServer({
      name: MANAGED_AGENT_MCP_SERVER_NAME,
      version: "0.1.0",
      instructions:
        "These tools exist only for deterministic Sapiom local managed-agent feasibility probes.",
      tools: [echoNonce, failOnce],
      alwaysLoad: true,
    }),
    qualifiedToolNames: [
      qualifiedManagedAgentMcpToolName("echo_nonce"),
      qualifiedManagedAgentMcpToolName("fail_once"),
    ],
    invocations,
    handlers,
  };
}

function defaultQueryFactory(input: {
  readonly prompt: string;
  readonly options: Options;
}): ManagedAgentQuery {
  // The narrow return type intentionally withholds control-channel methods,
  // especially Query.mcpCall(), because those calls bypass permission checks.
  return agentSdkQuery(input);
}

function safeEvalSource(
  scenario: string,
  target: string,
  executionId: string,
): string {
  return `studio-managed-agent-e0-${scenario}-${target}-${executionId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildManagedAgentCorrelationPrompt(input: {
  readonly prompt: string;
  readonly evalSource: string;
  readonly executionId: string;
}): string {
  const marker = [
    MANAGED_AGENT_CORRELATION_MARKER_VERSION,
    `eval_source=${input.evalSource}`,
    `execution_id=${input.executionId}`,
  ].join(";");
  return [
    marker,
    "This is a non-secret certification marker. Do not repeat it.",
    input.prompt,
  ].join("\n");
}

function hasUniversalPolicyHookCoverage(
  toolEvidence: readonly ManagedAgentToolEvidence[],
  permissionEvidence: ManagedAgentProbeResult["permissionEvidence"],
): boolean {
  const requested = toolEvidence.filter(({ status }) => status === "requested");
  const requestedIds = requested.flatMap(({ toolUseId }) =>
    toolUseId ? [toolUseId] : [],
  );
  if (
    requestedIds.length !== requested.length ||
    new Set(requestedIds).size !== requestedIds.length
  ) {
    return false;
  }
  return requestedIds.every((toolUseId) => {
    return (
      permissionEvidence.filter(
        (evidence) =>
          evidence.toolUseId === toolUseId &&
          evidence.source === "pre_tool_use",
      ).length === 1
    );
  });
}

async function closeQueryBounded(query: ManagedAgentQuery): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        query.close();
        return true;
      }),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(
          () => resolveTimeout(false),
          QUERY_CLOSE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function classifyTerminal(input: {
  readonly teardown: ManagedAgentTeardownObservation;
  readonly queryCreated: boolean;
  readonly queryClosed: boolean;
  readonly cancellationRequested: boolean;
  readonly queryFailed: boolean;
  readonly sdkResult?: { readonly isError: boolean; readonly subtype?: string };
}): ManagedAgentTerminalClassification {
  if (!input.teardown.quiescent || !input.teardown.deadlineMet) {
    return "teardown_timeout";
  }
  if (input.queryCreated && !input.queryClosed) return "close_timeout";
  if (input.cancellationRequested) return "cancelled";
  if (input.queryFailed) return "query_error";
  if (input.sdkResult?.isError) return "sdk_result_error";
  if (input.sdkResult) return "success";
  return "incomplete";
}

export async function runManagedAgentProbe(
  config: ManagedAgentProbeConfig,
  dependencies: ManagedAgentProbeDependencies = {},
): Promise<ManagedAgentProbeResult> {
  if (dependencies.hermeticGatewayOrigin && !dependencies.queryFactory) {
    throw new Error("hermeticGatewayOrigin requires an injected queryFactory");
  }
  const validated = validateManagedAgentProbeConfig(config, {
    ...(dependencies.hermeticGatewayOrigin
      ? { hermeticGatewayOrigin: dependencies.hermeticGatewayOrigin }
      : {}),
  });
  if (config.scenario === "L2" && !dependencies.waitForCancellationSignal) {
    throw new Error("L2 requires an explicit cancellation signal dependency");
  }

  const createUuid = dependencies.uuid ?? randomUUID;
  const runId = createUuid();
  const executionId = createUuid();
  const evalSource = safeEvalSource(
    config.scenario,
    config.target,
    executionId,
  );
  const recorder = new ManagedAgentEventRecorder(runId);
  const mcpRuntime = createManagedAgentMcpRuntime(config.expectedMcpNonce);
  const abortController = new AbortController();
  const triggerController = new AbortController();
  const before = await captureManagedAgentWorkspaceSnapshot(
    validated.canonicalWorkspaceRoot,
  );
  let cancellationRequested = false;
  let cancellationRequestedAt: number | undefined;
  let query: ManagedAgentQuery | undefined;
  let queryFailed = false;
  let queryClosed = false;
  let cancellationTriggerFailed = false;
  let policyPreflightFailed = false;
  let promptEmbedded = false;
  let eventNormalizationFailed = false;

  const childEnvironment = buildManagedAgentChildEnvironment({
    ambient: process.env,
    configRoot: validated.canonicalConfigRoot,
    gatewayOrigin: validated.gatewayOrigin,
    gatewayCredential: config.gatewayCredential,
    modelAlias: validated.model.alias,
    evalSource,
    executionId,
  });
  const policyBoundary = createManagedAgentPolicyBoundary({
    canonicalWorkspaceRoot: validated.canonicalWorkspaceRoot,
    allowedBashCommands: config.allowedBashCommands,
    allowedMcpTools: mcpRuntime.qualifiedToolNames,
    onDecision: (evidence) => recorder.recordPermission(evidence),
  });
  const processObserver =
    dependencies.processObserver ?? createLocalManagedAgentProcessObserver();

  const options: Options = {
    abortController,
    // PreToolUse is the universal boundary. canUseTool only handles an
    // unresolved SDK permission as defense in depth; the shared evaluator
    // deduplicates its evidence by tool-use ID.
    canUseTool: policyBoundary.canUseToolFallback,
    cwd: validated.canonicalWorkspaceRoot,
    disallowedTools: [...MANAGED_AGENT_DISALLOWED_TOOLS],
    env: childEnvironment,
    includePartialMessages: false,
    hooks: {
      PreToolUse: [
        {
          hooks: [policyBoundary.preToolUseHook],
          timeout: 5,
        },
      ],
    },
    maxBudgetUsd: config.maxBudgetUsd,
    maxTurns: config.maxTurns,
    mcpServers: { [MANAGED_AGENT_MCP_SERVER_NAME]: mcpRuntime.server },
    model: validated.model.alias,
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    skills: [],
    spawnClaudeCodeProcess: (spawnOptions) =>
      processObserver.spawn(spawnOptions),
    stderr: () => {
      // Do not retain or print SDK stderr; probe artifacts are structural only.
    },
    strictMcpConfig: true,
    systemPrompt:
      "You are a deterministic local managed-agent feasibility probe. Follow the ordered instructions exactly, continue after expected permission denials and planned MCP errors, and use only the tools named in the prompt.",
    thinking: { type: "disabled" },
    tools: [...MANAGED_AGENT_BUILTIN_TOOLS],
  };

  let teardown!: ManagedAgentTeardownObservation;
  let terminal!: ManagedAgentTerminalClassification;
  let policyHookCoverage = false;
  try {
    recorder.recordLifecycle("starting");
    try {
      await (
        dependencies.policySettingsGuard ?? assertManagedAgentHooksEnabled
      )({
        cwd: validated.canonicalWorkspaceRoot,
        environment:
          buildManagedAgentSettingsGuardEnvironment(childEnvironment),
      });
    } catch {
      policyPreflightFailed = true;
      recorder.recordLifecycle("policy_preflight_failed");
      triggerController.abort();
      abortController.abort();
    }
    const cancellationTask =
      !policyPreflightFailed && dependencies.waitForCancellationSignal
        ? dependencies
            .waitForCancellationSignal(triggerController.signal)
            .then(() => {
              if (triggerController.signal.aborted) return;
              cancellationRequested = true;
              cancellationRequestedAt = (dependencies.now ?? Date.now)();
              recorder.recordLifecycle("cancellation_requested");
              abortController.abort();
            })
            .catch(() => {
              if (!triggerController.signal.aborted) {
                cancellationTriggerFailed = true;
                abortController.abort();
              }
            })
        : undefined;

    if (!policyPreflightFailed) {
      try {
        const prompt = buildManagedAgentCorrelationPrompt({
          prompt: config.prompt,
          evalSource,
          executionId,
        });
        query = (dependencies.queryFactory ?? defaultQueryFactory)({
          prompt,
          options,
        });
        promptEmbedded = true;
        for await (const event of query) {
          try {
            recorder.observeSdkEvent(event);
          } catch (error) {
            eventNormalizationFailed = error instanceof ManagedAgentEventError;
            throw error;
          }
        }
      } catch {
        if (!abortController.signal.aborted) queryFailed = true;
      } finally {
        triggerController.abort();
        if (cancellationTask) await cancellationTask;
        queryFailed ||= cancellationTriggerFailed;
        if (query) queryClosed = await closeQueryBounded(query);
        if ((query && !queryClosed) || queryFailed) abortController.abort();
      }
    }

    const now = dependencies.now ?? Date.now;
    const elapsedBeforeTeardown =
      cancellationRequestedAt === undefined
        ? 0
        : now() - cancellationRequestedAt;
    const remainingTeardownMs = Math.max(
      0,
      MANAGED_AGENT_TEARDOWN_TIMEOUT_MS - elapsedBeforeTeardown,
    );
    teardown = await processObserver.waitForQuiescence(remainingTeardownMs);
    if (cancellationRequestedAt !== undefined) {
      const totalElapsedMs = now() - cancellationRequestedAt;
      teardown = {
        ...teardown,
        elapsedMs: totalElapsedMs,
        deadlineMet:
          teardown.quiescent &&
          totalElapsedMs <= MANAGED_AGENT_TEARDOWN_TIMEOUT_MS,
      };
    }
    terminal = classifyTerminal({
      teardown,
      queryCreated: query !== undefined,
      queryClosed,
      cancellationRequested,
      queryFailed,
      sdkResult: recorder.result,
    });
    if (
      policyPreflightFailed &&
      terminal !== "teardown_timeout" &&
      terminal !== "close_timeout"
    ) {
      terminal = "policy_violation";
    }
    policyHookCoverage =
      !policyPreflightFailed &&
      !eventNormalizationFailed &&
      hasUniversalPolicyHookCoverage(
        recorder.toolEvidence,
        recorder.permissionEvidence,
      );
    if (
      !policyHookCoverage &&
      terminal !== "teardown_timeout" &&
      terminal !== "close_timeout"
    ) {
      terminal = "policy_violation";
    }
    recorder.recordTerminal(terminal);

    if (!teardown.quiescent) {
      await processObserver.emergencyCleanup(teardown.alivePidsAtDeadline);
      teardown = { ...teardown, emergencyCleanupAttempted: true };
      terminal = "teardown_timeout";
    }
  } finally {
    processObserver.dispose();
  }

  const after = await captureManagedAgentWorkspaceSnapshot(
    validated.canonicalWorkspaceRoot,
  );
  return {
    contractVersion: 1,
    runId,
    scenario: config.scenario,
    target: config.target,
    modelAlias: validated.model.alias,
    ...(recorder.sessionId ? { sdkSessionId: recorder.sessionId } : {}),
    inferenceTurns: recorder.inferenceTurns,
    ...(recorder.sdkNumTurns === undefined
      ? {}
      : { sdkNumTurns: recorder.sdkNumTurns }),
    policyHookCoverage,
    terminal,
    events: [...recorder.events],
    toolEvidence: [...recorder.toolEvidence, ...mcpRuntime.invocations],
    permissionEvidence: [...recorder.permissionEvidence],
    workspaceChanges: diffManagedAgentWorkspaceSnapshots(before, after),
    preservation: observeManagedAgentPreservation(
      before,
      after,
      config.preservePaths ?? [],
    ),
    cancellationRequested,
    queryClosed,
    teardown,
    correlation: { executionId, evalSource, promptEmbedded },
    ...(recorder.usage ? { sdkUsage: recorder.usage } : {}),
  };
}
