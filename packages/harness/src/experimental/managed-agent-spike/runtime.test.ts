import { lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import {
  MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES,
  resolveManagedAgentModelTarget,
} from "./contract.js";
import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  type ManagedAgentFixture,
} from "./fixture.js";
import {
  MANAGED_AGENT_BUILTIN_TOOLS,
  MANAGED_AGENT_DISALLOWED_TOOLS,
} from "./permissions.js";
import {
  createManagedAgentMcpRuntime,
  runManagedAgentProbe,
} from "./runtime.js";
import type {
  ManagedAgentProcessObserver,
  ManagedAgentQuery,
  ManagedAgentTeardownObservation,
} from "./types.js";

const fixtures: ManagedAgentFixture[] = [];
const SUCCESS_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CANCEL_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TIMEOUT_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CLOSE_SESSION_ID = "44444444-4444-4444-8444-444444444444";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function quiescentTeardown(): ManagedAgentTeardownObservation {
  return {
    quiescent: true,
    deadlineMet: true,
    elapsedMs: 12,
    observedPids: [],
    alivePidsAtDeadline: [],
    emergencyCleanupAttempted: false,
  };
}

function fakeObserver(
  teardown: ManagedAgentTeardownObservation = quiescentTeardown(),
): ManagedAgentProcessObserver & {
  waitForQuiescence: ReturnType<typeof vi.fn>;
  emergencyCleanup: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    spawn: vi.fn(() => {
      throw new Error("fake query must not spawn");
    }),
    trackPids: vi.fn(),
    waitForQuiescence: vi.fn(async () => teardown),
    emergencyCleanup: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

function queryFromEvents(
  events: readonly unknown[],
  close = vi.fn(),
): ManagedAgentQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    close,
  };
}

async function probeConfig(scenario: "L1" | "L2" = "L1") {
  const fixture = await createManagedAgentFixture(() => "runtime-test-secret");
  fixtures.push(fixture);
  return {
    fixture,
    config: {
      scenario,
      workspaceRoot: fixture.workspaceRoot,
      configRoot: fixture.configRoot,
      target: "sonnet-5" as const,
      gatewayOrigin: "https://gateway.example.test",
      gatewayCredential: "dedicated-eval-secret",
      prompt: fixture.prompt(scenario),
      maxTurns: 10,
      maxBudgetUsd: 0.25,
      allowedBashCommands: [
        scenario === "L1" ? fixture.l1BashCommand : fixture.l2BashCommand,
      ],
      ...(scenario === "L1" ? { expectedMcpNonce: fixture.nonce } : {}),
      preservePaths: [
        FIXTURE_PATHS.dirtySentinel,
        FIXTURE_PATHS.untrackedSentinel,
      ],
    },
  };
}

describe("runManagedAgentProbe", () => {
  it("provides deterministic MCP success and fail-once recovery", async () => {
    const runtime = createManagedAgentMcpRuntime("nonce-1");
    await expect(
      runtime.handlers.echoNonce({ nonce: "nonce-1" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "nonce-1" }],
    });
    await expect(runtime.handlers.failOnce()).resolves.toMatchObject({
      isError: true,
    });
    await expect(runtime.handlers.failOnce()).resolves.not.toHaveProperty(
      "isError",
    );
    expect(
      runtime.invocations.map(({ toolName, status }) => [toolName, status]),
    ).toEqual([
      ["mcp__sapiom-managed-agent-spike__echo_nonce", "success"],
      ["mcp__sapiom-managed-agent-spike__fail_once", "error"],
      ["mcp__sapiom-managed-agent-spike__fail_once", "success"],
    ]);

    const mismatch = createManagedAgentMcpRuntime("expected-nonce");
    await expect(
      mismatch.handlers.echoNonce({ nonce: "wrong-nonce" }),
    ).resolves.toMatchObject({ isError: true });
    expect(mismatch.invocations).toEqual([
      {
        toolName: "mcp__sapiom-managed-agent-spike__echo_nonce",
        status: "error",
      },
    ]);
  });

  it("passes the strict isolated SDK contract and emits only normalized evidence", async () => {
    const { config, fixture } = await probeConfig();
    const observer = fakeObserver();
    const close = vi.fn();
    let capturedOptions: Options | undefined;
    const previousOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-user-login";
    try {
      const result = await runManagedAgentProbe(config, {
        hermeticGatewayOrigin: config.gatewayOrigin,
        processObserver: observer,
        uuid: (() => {
          let counter = 0;
          return () =>
            `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
        })(),
        queryFactory: ({ options }) => {
          capturedOptions = options;
          return queryFromEvents(
            [
              {
                type: "system",
                subtype: "init",
                session_id: SUCCESS_SESSION_ID,
                model: resolveManagedAgentModelTarget("sonnet-5").alias,
              },
              {
                type: "assistant",
                session_id: SUCCESS_SESSION_ID,
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "tool-1",
                      name: "Read",
                      input: {
                        file_path: fixture.outsideSentinel,
                        secret: fixture.nonce,
                      },
                    },
                  ],
                },
              },
              {
                type: "user",
                session_id: SUCCESS_SESSION_ID,
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "tool-1",
                      content: `secret:${fixture.nonce}`,
                    },
                  ],
                },
              },
              {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: SUCCESS_SESSION_ID,
                result: `secret:${fixture.nonce}`,
                usage: { input_tokens: 9, output_tokens: 4 },
              },
            ],
            close,
          );
        },
      });

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions?.model).toBe(
        resolveManagedAgentModelTarget("sonnet-5").alias,
      );
      expect(capturedOptions?.tools).toEqual(MANAGED_AGENT_BUILTIN_TOOLS);
      expect(capturedOptions?.disallowedTools).toEqual(
        MANAGED_AGENT_DISALLOWED_TOOLS,
      );
      expect(capturedOptions?.permissionMode).toBe("default");
      expect(capturedOptions?.settingSources).toEqual([]);
      expect(capturedOptions?.strictMcpConfig).toBe(true);
      expect(capturedOptions?.canUseTool).toBeTypeOf("function");
      expect(capturedOptions?.spawnClaudeCodeProcess).toBeTypeOf("function");
      expect(
        Object.prototype.hasOwnProperty.call(capturedOptions, "allowedTools"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(capturedOptions, "fallbackModel"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(
          capturedOptions,
          "allowDangerouslySkipPermissions",
        ),
      ).toBe(false);
      for (const variable of MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES) {
        expect(capturedOptions?.env?.[variable]).toBe(capturedOptions?.model);
      }
      expect(capturedOptions?.env).not.toHaveProperty(
        "CLAUDE_CODE_OAUTH_TOKEN",
      );
      expect(capturedOptions?.env).not.toHaveProperty("SAPIOM_API_KEY");
      expect(result.terminal).toBe("success");
      expect(result.sdkSessionId).toBe(SUCCESS_SESSION_ID);
      expect(result.queryClosed).toBe(true);
      expect(result.preservation.every(({ preserved }) => preserved)).toBe(
        true,
      );
      expect(close).toHaveBeenCalledOnce();
      expect(observer.dispose).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("dedicated-eval-secret");
      expect(serialized).not.toContain(fixture.nonce);
      expect(serialized).not.toContain(fixture.outsideSentinel);
    } finally {
      if (previousOAuth === undefined)
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOAuth;
    }
  });

  it("does not follow pre-existing config child symlinks and fails invalid roots before query construction", async () => {
    const { config, fixture } = await probeConfig();
    const externalConfig = join(fixture.root, "external-config");
    await mkdir(externalConfig);
    await symlink(externalConfig, join(fixture.configRoot, "claude-config"));
    let claudeConfigDirectory: string | undefined;
    const safeQueryFactory = vi.fn(({ options }: { options: Options }) => {
      claudeConfigDirectory = options.env?.CLAUDE_CONFIG_DIR;
      return queryFromEvents([
        {
          type: "system",
          subtype: "init",
          session_id: SUCCESS_SESSION_ID,
        },
        { type: "result", subtype: "success", is_error: false },
      ]);
    });

    await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory: safeQueryFactory,
    });

    expect(safeQueryFactory).toHaveBeenCalledOnce();
    expect(claudeConfigDirectory).toBeDefined();
    expect(await realpath(claudeConfigDirectory!)).not.toBe(
      await realpath(externalConfig),
    );
    expect(dirname(dirname(claudeConfigDirectory!))).toBe(fixture.configRoot);
    expect((await lstat(claudeConfigDirectory!)).isSymbolicLink()).toBe(false);

    const invalidConfigRoot = join(fixture.root, "config-file");
    await writeFile(invalidConfigRoot, "not a directory");
    const rejectedQueryFactory = vi.fn(() => queryFromEvents([]));
    await expect(
      runManagedAgentProbe(
        { ...config, configRoot: invalidConfigRoot },
        {
          hermeticGatewayOrigin: config.gatewayOrigin,
          processObserver: fakeObserver(),
          queryFactory: rejectedQueryFactory,
        },
      ),
    ).rejects.toThrow("configRoot must be a directory");
    expect(rejectedQueryFactory).not.toHaveBeenCalled();
  });

  it("redacts malicious SDK and permission identifiers from the complete result", async () => {
    const { config } = await probeConfig();
    const sessionSecret = "session-secret-injected-by-sdk";
    const toolIdSecret = "tool-id-secret-injected-by-sdk";
    const toolNameSecret = "ReadSecretInjectedBySdk";
    const permissionIdSecret = "permission-id-secret-injected-by-sdk";
    const permissionNameSecret = "PermissionSecretInjectedBySdk";
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          await options.canUseTool?.(
            permissionNameSecret,
            {},
            {
              signal: new AbortController().signal,
              toolUseID: permissionIdSecret,
              requestId: "request-id-not-persisted",
            },
          );
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionSecret,
          };
          yield {
            type: "assistant",
            session_id: sessionSecret,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: toolIdSecret,
                  name: toolNameSecret,
                  input: { secret: "tool-input-secret" },
                },
              ],
            },
          };
          yield {
            type: "user",
            session_id: sessionSecret,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolIdSecret,
                  content: "tool-result-secret",
                },
              ],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sessionSecret,
          };
        },
        close: vi.fn(),
      }),
    });

    expect(result.sdkSessionId).toBeUndefined();
    expect(result.toolEvidence.slice(0, 2)).toMatchObject([
      { toolName: "unknown", status: "requested" },
      { toolName: "unknown", status: "success" },
    ]);
    expect(result.toolEvidence[0]?.toolUseId).toBe(
      result.toolEvidence[1]?.toolUseId,
    );
    expect(result.permissionEvidence).toMatchObject([
      { toolName: "unknown", decision: "deny", reason: "tool_not_allowed" },
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of [
      sessionSecret,
      toolIdSecret,
      toolNameSecret,
      permissionIdSecret,
      permissionNameSecret,
      "request-id-not-persisted",
      "tool-input-secret",
      "tool-result-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("classifies an explicit active-run abort as cancellation", async () => {
    const { config } = await probeConfig("L2");
    const observer = fakeObserver();
    const close = vi.fn();
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      waitForCancellationSignal: async () => undefined,
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: CANCEL_SESSION_ID,
          };
          if (!options.abortController?.signal.aborted) {
            await new Promise<void>((resolveAbort) =>
              options.abortController?.signal.addEventListener(
                "abort",
                () => resolveAbort(),
                { once: true },
              ),
            );
          }
          throw new Error("synthetic abort");
        },
        close,
      }),
    });

    expect(result.terminal).toBe("cancelled");
    expect(result.cancellationRequested).toBe(true);
    expect(result.queryClosed).toBe(true);
    expect(
      result.events.filter(({ type }) => type === "terminal"),
    ).toHaveLength(1);
  });

  it("records teardown failure before attempting emergency cleanup", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver({
      quiescent: false,
      deadlineMet: false,
      elapsedMs: 5_001,
      observedPids: [9001],
      alivePidsAtDeadline: [9001],
      emergencyCleanupAttempted: false,
    });
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      queryFactory: () =>
        queryFromEvents([
          {
            type: "system",
            subtype: "init",
            session_id: TIMEOUT_SESSION_ID,
          },
          { type: "result", subtype: "success", is_error: false },
        ]),
    });

    expect(result.terminal).toBe("teardown_timeout");
    expect(result.teardown.emergencyCleanupAttempted).toBe(true);
    expect(observer.emergencyCleanup).toHaveBeenCalledWith([9001]);
    expect(result.events.at(-1)).toMatchObject({
      type: "terminal",
      terminal: "teardown_timeout",
    });
  });

  it("classifies a throwing query close without skipping abort or observer disposal", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver();
    let abortSignal: AbortSignal | undefined;
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      queryFactory: ({ options }) => {
        abortSignal = options.abortController?.signal;
        return queryFromEvents(
          [
            {
              type: "system",
              subtype: "init",
              session_id: CLOSE_SESSION_ID,
            },
            { type: "result", subtype: "success", is_error: false },
          ],
          vi.fn(() => {
            throw new Error("synthetic close failure");
          }),
        );
      },
    });

    expect(result.terminal).toBe("close_timeout");
    expect(result.queryClosed).toBe(false);
    expect(abortSignal?.aborted).toBe(true);
    expect(observer.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a test gateway unless the explicit hermetic seam is present", async () => {
    const { config } = await probeConfig();
    const queryFactory = vi.fn(() => queryFromEvents([]));
    await expect(
      runManagedAgentProbe(config, {
        processObserver: fakeObserver(),
        queryFactory,
      }),
    ).rejects.toThrow("pinned direct Sapiom gateway origin");
    expect(queryFactory).not.toHaveBeenCalled();
  });

  it("rejects the hermetic origin seam without an injected query factory", async () => {
    const { config } = await probeConfig();
    await expect(
      runManagedAgentProbe(config, {
        hermeticGatewayOrigin: config.gatewayOrigin,
        processObserver: fakeObserver(),
      }),
    ).rejects.toThrow("requires an injected queryFactory");
  });
});
