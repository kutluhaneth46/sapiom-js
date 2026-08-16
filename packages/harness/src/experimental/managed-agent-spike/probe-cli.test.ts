import { describe, expect, it } from "vitest";

import {
  ManagedAgentProbeCliError,
  assertManagedAgentCertificationNodeVersion,
  evaluateManagedAgentProbe,
  executeManagedAgentProbeCli,
  managedAgentProbeUsage,
  parseManagedAgentProbeCliArgs,
} from "./probe-cli.js";
import { FIXTURE_PATHS } from "./fixture.js";
import { qualifiedManagedAgentMcpToolName } from "./runtime.js";
import type { ManagedAgentProbeResult } from "./types.js";

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

  it("requires successful results from every built-in tool for L1", () => {
    const builtins = ["Read", "Edit", "Write", "Bash"];
    const result: ManagedAgentProbeResult = {
      contractVersion: 1,
      runId: "run-1",
      scenario: "L1",
      target: "sonnet-5",
      modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
      sdkSessionId: "session-1",
      terminal: "success",
      events: [],
      toolEvidence: [
        ...builtins.flatMap((toolName) => [
          { toolName, status: "requested" as const },
          {
            toolName,
            status:
              toolName === "Bash" ? ("error" as const) : ("success" as const),
          },
        ]),
        {
          toolName: qualifiedManagedAgentMcpToolName("echo_nonce"),
          status: "success",
        },
        {
          toolName: qualifiedManagedAgentMcpToolName("fail_once"),
          status: "error",
        },
        {
          toolName: qualifiedManagedAgentMcpToolName("fail_once"),
          status: "success",
        },
      ],
      permissionEvidence: [
        {
          toolUseId: "deny-1",
          toolName: "Read",
          decision: "deny",
          reason: "path_outside_workspace",
        },
        {
          toolUseId: "deny-2",
          toolName: "Read",
          decision: "deny",
          reason: "path_outside_workspace",
        },
      ],
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
        elapsedMs: 5,
        observedPids: [],
        alivePidsAtDeadline: [],
        emergencyCleanupAttempted: false,
      },
      correlation: { executionId: "execution-1", evalSource: "eval-1" },
    };

    expect(
      evaluateManagedAgentProbe(result).checks.find(
        ({ id }) => id === "builtin_tools_succeeded",
      ),
    ).toEqual({ id: "builtin_tools_succeeded", passed: false });
  });
});
