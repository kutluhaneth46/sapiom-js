import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES,
} from "./contract.js";

export type ManagedAgentAmbientEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ManagedAgentIsolatedDirectories {
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly xdgConfig: string;
  readonly xdgCache: string;
  readonly xdgData: string;
  readonly claudeConfig: string;
  readonly secureStorage: string;
  readonly temporary: string;
}

export interface ManagedAgentChildEnvironmentInput {
  readonly ambient: ManagedAgentAmbientEnvironment;
  readonly configRoot: string;
  readonly gatewayOrigin: string;
  readonly gatewayCredential: string;
  readonly modelAlias: string;
  readonly evalSource: string;
  readonly executionId: string;
}

const SAFE_AMBIENT_PASSTHROUGH = [
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "CLAUDE_CODE_GIT_BASH_PATH",
] as const;

function validateHeaderValue(value: string, label: string): void {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${label} is not a safe header value`);
  }
}

export function prepareManagedAgentDirectories(
  configRoot: string,
): ManagedAgentIsolatedDirectories {
  const home = join(configRoot, "home");
  const directories = {
    home,
    appData: join(home, "appdata"),
    localAppData: join(home, "local-appdata"),
    xdgConfig: join(home, "xdg-config"),
    xdgCache: join(home, "xdg-cache"),
    xdgData: join(home, "xdg-data"),
    claudeConfig: join(configRoot, "claude-config"),
    secureStorage: join(configRoot, "secure-storage"),
    temporary: join(configRoot, "tmp"),
  } satisfies ManagedAgentIsolatedDirectories;
  for (const directory of Object.values(directories)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return directories;
}

/**
 * Build from an empty object so future ambient credential variables remain
 * denied by default. The supplied credential must be a dedicated eval key.
 */
export function buildManagedAgentChildEnvironment(
  input: ManagedAgentChildEnvironmentInput,
): Record<string, string> {
  validateHeaderValue(input.evalSource, "evalSource");
  validateHeaderValue(input.executionId, "executionId");
  const directories = prepareManagedAgentDirectories(input.configRoot);
  const child: Record<string, string> = {};
  for (const name of SAFE_AMBIENT_PASSTHROUGH) {
    const value = input.ambient[name];
    if (value !== undefined) child[name] = value;
  }

  Object.assign(child, {
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    XDG_CONFIG_HOME: directories.xdgConfig,
    XDG_CACHE_HOME: directories.xdgCache,
    XDG_DATA_HOME: directories.xdgData,
    TMPDIR: directories.temporary,
    TMP: directories.temporary,
    TEMP: directories.temporary,
    CLAUDE_CONFIG_DIR: directories.claudeConfig,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: directories.secureStorage,
    ANTHROPIC_BASE_URL: input.gatewayOrigin,
    ANTHROPIC_API_KEY: input.gatewayCredential,
    ANTHROPIC_CUSTOM_HEADERS: [
      `x-sapiom-eval-source: ${input.evalSource}`,
      `x-sapiom-execution-id: ${input.executionId}`,
    ].join("\n"),
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
    CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: `sapiom-managed-agent-spike/${MANAGED_AGENT_CONTRACT.suiteVersion}`,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  });

  for (const name of MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES) {
    child[name] = input.modelAlias;
  }

  return child;
}
