import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import type {
  ManagedAgentPreservationObservation,
  ManagedAgentProbeScenario,
  ManagedAgentWorkspaceChange,
} from "./types.js";

export const FIXTURE_PATHS = {
  cleanTarget: "clean-target.txt",
  dirtySentinel: "dirty-sentinel.txt",
  untrackedSentinel: "untracked-sentinel.txt",
  createdTarget: "managed-output.txt",
  escapeLink: "escape-link.txt",
  processDirectory: ".managed-agent-probe",
  processScript: ".managed-agent-probe/long-running.mjs",
  processPidFile: ".managed-agent-probe/processes.json",
} as const;

export interface ManagedAgentFixture {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly configRoot: string;
  readonly outsideSentinel: string;
  readonly nonce: string;
  readonly cleanTargetReplacement: string;
  readonly createdTargetContents: string;
  readonly l1BashCommand: string;
  readonly l2BashCommand: string;
  readonly preservedBytes: Readonly<Record<string, Buffer>>;
  prompt(scenario: ManagedAgentProbeScenario): string;
  cleanup(): Promise<void>;
}

export type ManagedAgentWorkspaceSnapshot = ReadonlyMap<string, string>;

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(workspaceRoot: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd: workspaceRoot,
    stdio: "ignore",
    windowsHide: true,
  });
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.split('"').join('\\"')}"`;
  }
  return `'${value.split("'").join(`'"'"'`)}'`;
}

const LONG_RUNNING_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pidFile = resolve(process.argv[2]);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
writeFileSync(pidFile, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));

function stop() {
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(0), 25).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
setInterval(() => {}, 1000);
`.trimStart();

async function walkWorkspace(
  root: string,
  directory: string,
  snapshot: Map<string, string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (directory === root && entry.name === ".git") continue;
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath).split("\\").join("/");
    if (entry.isDirectory()) {
      await walkWorkspace(root, absolutePath, snapshot);
    } else if (entry.isSymbolicLink()) {
      snapshot.set(
        relativePath,
        hash(`symlink:${await readlink(absolutePath)}`),
      );
    } else if (entry.isFile()) {
      snapshot.set(relativePath, hash(await readFile(absolutePath)));
    }
  }
}

export async function captureManagedAgentWorkspaceSnapshot(
  workspaceRoot: string,
): Promise<ManagedAgentWorkspaceSnapshot> {
  const canonicalRoot = await realpath(workspaceRoot);
  const snapshot = new Map<string, string>();
  await walkWorkspace(canonicalRoot, canonicalRoot, snapshot);
  return snapshot;
}

export function diffManagedAgentWorkspaceSnapshots(
  before: ManagedAgentWorkspaceSnapshot,
  after: ManagedAgentWorkspaceSnapshot,
): ManagedAgentWorkspaceChange[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((path): ManagedAgentWorkspaceChange[] => {
    const previous = before.get(path);
    const current = after.get(path);
    if (previous === current) return [];
    if (previous === undefined) return [{ path, change: "created" }];
    if (current === undefined) return [{ path, change: "deleted" }];
    return [{ path, change: "modified" }];
  });
}

export function observeManagedAgentPreservation(
  before: ManagedAgentWorkspaceSnapshot,
  after: ManagedAgentWorkspaceSnapshot,
  paths: readonly string[],
): ManagedAgentPreservationObservation[] {
  return paths.map((path) => ({
    path,
    preserved: before.has(path) && before.get(path) === after.get(path),
  }));
}

export async function readManagedAgentFixturePids(
  fixture: ManagedAgentFixture,
): Promise<number[]> {
  const parsed = JSON.parse(
    await readFile(
      resolve(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
      "utf8",
    ),
  ) as { parentPid?: unknown; childPid?: unknown };
  const pids = [parsed.parentPid, parsed.childPid].filter(
    (value): value is number => Number.isInteger(value) && Number(value) > 0,
  );
  if (pids.length !== 2)
    throw new Error("Long-running fixture did not record two PIDs");
  return pids;
}

export async function waitForManagedAgentFixturePids(
  fixture: ManagedAgentFixture,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<number[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error("PID wait cancelled");
    try {
      return await readManagedAgentFixturePids(fixture);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("did not record")) throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("Timed out waiting for the long-running fixture process");
}

export async function createManagedAgentFixture(
  createNonce: () => string = randomUUID,
): Promise<ManagedAgentFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sapiom-managed-agent-")),
  );
  const workspaceRoot = join(root, "workspace");
  const configRoot = join(root, "config");
  const outsideRoot = join(root, "outside");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
    mkdir(configRoot, { recursive: true, mode: 0o700 }),
    mkdir(outsideRoot, { recursive: true, mode: 0o700 }),
    mkdir(join(workspaceRoot, FIXTURE_PATHS.processDirectory), {
      recursive: true,
      mode: 0o700,
    }),
  ]);

  const nonce = createNonce().split("-").join("");
  const dirtyBase = "tracked dirty sentinel base\n";
  const dirtyContents = "tracked dirty sentinel user change\n";
  const untrackedContents = `${nonce}\n`;
  const outsideContents = "outside sentinel must remain unread\n";
  const cleanTargetReplacement = "managed target updated\n";
  const createdTargetContents = "managed output created\n";
  const outsideSentinel = join(outsideRoot, "outside-sentinel.txt");

  await Promise.all([
    writeFile(
      join(workspaceRoot, FIXTURE_PATHS.cleanTarget),
      "clean target base\n",
    ),
    writeFile(join(workspaceRoot, FIXTURE_PATHS.dirtySentinel), dirtyBase),
    writeFile(
      join(workspaceRoot, FIXTURE_PATHS.processScript),
      LONG_RUNNING_SCRIPT,
      { mode: 0o600 },
    ),
    writeFile(outsideSentinel, outsideContents),
  ]);
  await symlink(outsideSentinel, join(workspaceRoot, FIXTURE_PATHS.escapeLink));

  runGit(workspaceRoot, ["init", "--quiet"]);
  runGit(workspaceRoot, [
    "config",
    "user.email",
    "managed-agent-probe@sapiom.invalid",
  ]);
  runGit(workspaceRoot, ["config", "user.name", "Sapiom Managed Agent Probe"]);
  runGit(workspaceRoot, ["add", "."]);
  runGit(workspaceRoot, ["commit", "--quiet", "-m", "fixture baseline"]);

  await Promise.all([
    writeFile(join(workspaceRoot, FIXTURE_PATHS.dirtySentinel), dirtyContents),
    writeFile(
      join(workspaceRoot, FIXTURE_PATHS.untrackedSentinel),
      untrackedContents,
    ),
  ]);

  const l1BashCommand = "git status --short";
  const l2BashCommand = [
    shellQuote(process.execPath),
    shellQuote(FIXTURE_PATHS.processScript),
    shellQuote(FIXTURE_PATHS.processPidFile),
  ].join(" ");

  return {
    root,
    workspaceRoot,
    configRoot,
    outsideSentinel,
    nonce,
    cleanTargetReplacement,
    createdTargetContents,
    l1BashCommand,
    l2BashCommand,
    preservedBytes: {
      [FIXTURE_PATHS.dirtySentinel]: Buffer.from(dirtyContents),
      [FIXTURE_PATHS.untrackedSentinel]: Buffer.from(untrackedContents),
    },
    prompt(scenario) {
      if (scenario === "L2") {
        return [
          "Use Bash exactly once with the command below, verbatim.",
          "Do not add whitespace, prefixes, suffixes, redirection, or backgrounding.",
          "Wait for the command; do not run any other tool.",
          l2BashCommand,
        ].join("\n");
      }
      return [
        "Complete this deterministic local-tool probe in order.",
        `1. Read ${FIXTURE_PATHS.cleanTarget}, ${FIXTURE_PATHS.dirtySentinel}, and ${FIXTURE_PATHS.untrackedSentinel}.`,
        `2. Attempt to Read the absolute outside path ${outsideSentinel}; after denial, continue.`,
        `3. Attempt to Read ${FIXTURE_PATHS.escapeLink}; after denial, continue.`,
        `4. Edit ${FIXTURE_PATHS.cleanTarget}, replacing its complete current contents with exactly ${JSON.stringify(cleanTargetReplacement)}.`,
        `5. Write ${FIXTURE_PATHS.createdTarget} with exactly ${JSON.stringify(createdTargetContents)}.`,
        `6. Call echo_nonce with the exact sole line you read from ${FIXTURE_PATHS.untrackedSentinel}, without surrounding whitespace.`,
        `7. Call fail_once with that same value; after its planned error, call fail_once once more with the same value.`,
        `8. Use Bash with exactly this command: ${l1BashCommand}`,
        `Never modify ${FIXTURE_PATHS.dirtySentinel} or ${FIXTURE_PATHS.untrackedSentinel}.`,
        "Finish with a short confirmation after all steps.",
      ].join("\n");
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function verifyManagedAgentFixtureBytes(
  fixture: ManagedAgentFixture,
): Promise<ManagedAgentPreservationObservation[]> {
  return Promise.all(
    Object.entries(fixture.preservedBytes).map(async ([path, expected]) => {
      let preserved = false;
      try {
        const current = await readFile(join(fixture.workspaceRoot, path));
        preserved = current.equals(expected);
      } catch {
        preserved = false;
      }
      return { path, preserved };
    }),
  );
}

export async function fixtureGitStatus(
  fixture: ManagedAgentFixture,
): Promise<string> {
  return execFileSync("git", ["status", "--short"], {
    cwd: fixture.workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

export async function fixturePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function fixtureName(fixture: ManagedAgentFixture): string {
  return basename(fixture.root);
}
