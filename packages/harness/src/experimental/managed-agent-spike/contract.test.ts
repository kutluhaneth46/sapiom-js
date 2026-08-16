import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_MODEL_TARGETS,
  ManagedAgentConfigurationError,
  assertManagedAgentDirectGatewayOrigin,
  normalizeManagedAgentGatewayOrigin,
  normalizeManagedAgentHermeticGatewayOrigin,
  resolveManagedAgentModelTarget,
  validateManagedAgentProbeConfig,
} from "./contract.js";
import type { ManagedAgentProbeConfig } from "./types.js";

const roots: string[] = [];

async function config(): Promise<ManagedAgentProbeConfig> {
  const root = await mkdtemp(join(tmpdir(), "managed-agent-contract-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const configRoot = join(root, "config");
  await Promise.all([mkdir(workspaceRoot), mkdir(configRoot)]);
  return {
    scenario: "L1",
    workspaceRoot,
    configRoot,
    target: "sonnet-5",
    gatewayOrigin: MANAGED_AGENT_CONTRACT.directGatewayOrigin,
    gatewayCredential: "dedicated-eval-key",
    prompt: "probe",
    maxTurns: 10,
    maxBudgetUsd: 0.25,
    allowedBashCommands: ["git status --short"],
    expectedMcpNonce: "probe-nonce",
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed-agent contract", () => {
  it("pins the certified SDK/runtime and exact two-model allowlist", () => {
    expect(MANAGED_AGENT_CONTRACT).toMatchObject({
      agentSdkVersion: "0.3.228",
      claudeCodeRuntimeVersion: "2.1.228",
      certificationNodeVersion: "22.23.2",
      directGatewayOrigin: "https://litellm.services.sapiom.ai",
    });
    expect(MANAGED_AGENT_MODEL_TARGETS).toEqual({
      "sonnet-5": expect.objectContaining({
        alias: "claude-sonnet-5-anthropic-anthropic-eval",
      }),
      "minimax-m3": expect.objectContaining({
        alias: "minimax-m3-fireworks-sapiom-fireworks_ai-eval",
      }),
    });
  });

  it("rejects arbitrary models instead of accepting a gateway label", () => {
    expect(() =>
      resolveManagedAgentModelTarget("claude-anything" as "sonnet-5"),
    ).toThrow(ManagedAgentConfigurationError);
  });

  it("accepts only a credential-free HTTP(S) origin", () => {
    expect(
      normalizeManagedAgentGatewayOrigin("https://gateway.example.test/"),
    ).toBe("https://gateway.example.test");
    for (const value of [
      "file:///tmp/gateway",
      "https://user:pass@gateway.example.test",
      "https://gateway.example.test/v1",
      "https://gateway.example.test?token=x",
    ]) {
      expect(() => normalizeManagedAgentGatewayOrigin(value)).toThrow(
        ManagedAgentConfigurationError,
      );
    }
  });

  it("pins live traffic to the certified direct gateway origin", () => {
    expect(
      assertManagedAgentDirectGatewayOrigin(
        "https://litellm.services.sapiom.ai/",
      ),
    ).toBe(MANAGED_AGENT_CONTRACT.directGatewayOrigin);
    expect(() =>
      assertManagedAgentDirectGatewayOrigin(
        "https://llm.services.proxy.sapiom.ai",
      ),
    ).toThrow("pinned direct Sapiom gateway origin");
  });

  it("limits the explicit hermetic origin seam to .test and loopback", () => {
    for (const value of [
      "https://gateway.example.test",
      "http://localhost:4312",
      "http://agent.localhost:4312",
      "http://127.0.0.1:4312",
      "http://[::1]:4312",
    ]) {
      expect(normalizeManagedAgentHermeticGatewayOrigin(value)).toBe(
        normalizeManagedAgentGatewayOrigin(value),
      );
    }
    for (const value of [
      MANAGED_AGENT_CONTRACT.directGatewayOrigin,
      "https://gateway.example.com",
    ]) {
      expect(() => normalizeManagedAgentHermeticGatewayOrigin(value)).toThrow(
        "reserved .test or loopback",
      );
    }
  });

  it("canonicalizes disjoint roots and bounds turns and budget", async () => {
    const valid = await config();
    const checked = validateManagedAgentProbeConfig(valid);
    expect(checked.canonicalWorkspaceRoot).toBe(
      await realpath(valid.workspaceRoot),
    );
    expect(checked.model.id).toBe("sonnet-5");
    expect(() =>
      validateManagedAgentProbeConfig({ ...valid, maxBudgetUsd: 1.01 }),
    ).toThrow("maxBudgetUsd");
    expect(() =>
      validateManagedAgentProbeConfig({ ...valid, maxTurns: 21 }),
    ).toThrow("maxTurns");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        configRoot: valid.workspaceRoot,
      }),
    ).toThrow("disjoint");
    expect(() =>
      validateManagedAgentProbeConfig({
        ...valid,
        expectedMcpNonce: undefined,
      }),
    ).toThrow("expectedMcpNonce");
  });

  it("requires exact agreement with an explicitly selected hermetic origin", async () => {
    const valid = await config();
    const gatewayOrigin = "https://gateway.example.test";
    expect(
      validateManagedAgentProbeConfig(
        { ...valid, gatewayOrigin },
        { hermeticGatewayOrigin: gatewayOrigin },
      ).gatewayOrigin,
    ).toBe(gatewayOrigin);
    expect(() =>
      validateManagedAgentProbeConfig(
        { ...valid, gatewayOrigin },
        { hermeticGatewayOrigin: "https://other.example.test" },
      ),
    ).toThrow("explicit hermetic gateway origin");
  });
});
