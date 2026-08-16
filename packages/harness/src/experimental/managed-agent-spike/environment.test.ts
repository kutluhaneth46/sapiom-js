import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_FORBIDDEN_AMBIENT_CREDENTIALS,
  MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES,
} from "./contract.js";
import { buildManagedAgentChildEnvironment } from "./environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed-agent child environment", () => {
  it("starts empty, passes only positive-listed ambient values, and pins every model variable", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "managed-agent-env-"));
    roots.push(configRoot);
    const child = buildManagedAgentChildEnvironment({
      ambient: {
        PATH: "/safe/bin",
        LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "ambient-anthropic-key",
        CLAUDE_CODE_OAUTH_TOKEN: "ambient-user-login",
        SAPIOM_API_KEY: "ambient-sapiom-key",
        HOST_ESBUILD_PIN: "/must/not/leak",
        FUTURE_CREDENTIAL_SOURCE: "future-secret",
      },
      configRoot,
      gatewayOrigin: "https://gateway.example.test",
      gatewayCredential: "dedicated-eval-key",
      modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
      evalSource: "eval-source",
      executionId: "execution-id",
    });

    expect(child.PATH).toBe("/safe/bin");
    expect(child.ANTHROPIC_API_KEY).toBe("dedicated-eval-key");
    expect(child.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test");
    expect(child.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK).toBe("1");
    expect(child.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    for (const variable of MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES) {
      expect(child[variable]).toBe("claude-sonnet-5-anthropic-anthropic-eval");
    }
    for (const variable of MANAGED_AGENT_FORBIDDEN_AMBIENT_CREDENTIALS) {
      if (variable !== "ANTHROPIC_API_KEY")
        expect(child).not.toHaveProperty(variable);
    }
    expect(child).not.toHaveProperty("HOST_ESBUILD_PIN");
    expect(child).not.toHaveProperty("FUTURE_CREDENTIAL_SOURCE");
    expect(child.HOME).not.toBe(process.env.HOME);
    expect(child.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(child.CLAUDE_SECURESTORAGE_CONFIG_DIR).not.toBe(
      child.CLAUDE_CONFIG_DIR,
    );
    for (const directory of [
      child.HOME,
      child.XDG_CONFIG_HOME,
      child.CLAUDE_CONFIG_DIR,
      child.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      child.TMPDIR,
    ]) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
  });

  it("rejects newline injection in correlation headers", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "managed-agent-env-"));
    roots.push(configRoot);
    expect(() =>
      buildManagedAgentChildEnvironment({
        ambient: {},
        configRoot,
        gatewayOrigin: "https://gateway.example.test",
        gatewayCredential: "dedicated-eval-key",
        modelAlias: "model",
        evalSource: "bad\nheader",
        executionId: "execution-id",
      }),
    ).toThrow("safe header");
  });
});
