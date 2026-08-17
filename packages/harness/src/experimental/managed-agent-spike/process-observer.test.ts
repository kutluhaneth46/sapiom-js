import { once } from "node:events";
import {
  execFile,
  spawn as spawnChild,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection, type Socket as NetSocket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  waitForManagedAgentFixturePids,
  type ManagedAgentFixture,
} from "./fixture.js";
import {
  LocalManagedAgentProcessObserver,
  MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV,
  MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV,
  type ManagedAgentKernelProcessRecord,
  type ManagedAgentProcessTableObservation,
} from "./process-observer.js";

const fixtures: ManagedAgentFixture[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function available(
  entries: readonly (readonly [number, ManagedAgentKernelProcessRecord])[],
): ManagedAgentProcessTableObservation {
  return { available: true, processes: new Map(entries) };
}

async function readRealPosixProcessTable(): Promise<ManagedAgentProcessTableObservation> {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 1_000 },
    );
    const entries: Array<readonly [number, ManagedAgentKernelProcessRecord]> =
      [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      entries.push([
        Number(match[1]),
        {
          parentPid: Number(match[2]),
          processGroupId: Number(match[3]),
          state: match[4]!,
          startedAt: match[5]!,
        },
      ]);
    }
    return available(entries);
  } catch {
    return { available: false };
  }
}

async function prepareCancellationAfterTransientReadFailure(
  observer: LocalManagedAgentProcessObserver,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const readiness = await observer.prepareCancellation();
    if (
      readiness.reason !== "process_table_unavailable" ||
      Date.now() >= deadline
    ) {
      return readiness;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function activeNodeCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  };
}

const FAST_EXIT_ROOT_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pidFile = resolve(process.argv[1]);
const exitTiming = process.argv[2];
const exitMarker = resolve(process.argv[3]);
const childProgram = [
  'process.on("SIGTERM", () => {});',
  'if (process.send) process.send("ready");',
  'setInterval(() => {}, 1000);',
].join("");
const child = spawn(process.execPath, ["-e", childProgram], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  windowsHide: true,
});
child.once("message", () => {
  writeFileSync(pidFile, JSON.stringify({
    parentPid: process.pid,
    childPid: child.pid,
  }));
  if (exitTiming === "before-readiness") process.exit(0);
  const exitPoll = setInterval(() => {
    if (!existsSync(exitMarker)) return;
    clearInterval(exitPoll);
    process.exit(0);
  }, 10);
});
`;

const DESCENDANT_TOOL_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [toolScript, pidFile, credentialFile] = process.argv.slice(1);
writeFileSync(credentialFile, JSON.stringify({
  socketPath: process.env.SAPIOM_MANAGED_AGENT_TOOL_CONTROL_SOCKET,
  capability: process.env.SAPIOM_MANAGED_AGENT_TOOL_CONTROL_CAPABILITY,
}));
const tool = spawn(
  "/bin/bash",
  [
    "--noprofile",
    "--norc",
    "-c",
    'exec "$1" "$2" "$3"',
    "managed-agent-tool",
    process.execPath,
    toolScript,
    pidFile,
  ],
  {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  },
);
tool.unref();
setInterval(() => {}, 1000);
`;

const REGISTERED_DESCENDANT_TOOL_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [toolScript, pidFile, launchFile] = process.argv.slice(1);
const tool = spawn(
  "/bin/bash",
  [
    "--noprofile",
    "--norc",
    "-c",
    'exec "$1" "$2" "$3" --register-control',
    "managed-agent-tool",
    process.execPath,
    toolScript,
    pidFile,
  ],
  {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  },
);
if (typeof tool.pid !== "number") throw new Error("fixture tool failed to spawn");
// Direct launcher tests predate setup-failure cleanup evidence and deliberately
// omit this path; the shared launcher must remain valid for those callers.
if (launchFile) {
  writeFileSync(launchFile, JSON.stringify({ processGroupId: tool.pid }));
}
tool.unref();
setInterval(() => {}, 1000);
`;

const EXPORT_TOOL_CONTROL_SCRIPT = String.raw`
import { writeFileSync } from "node:fs";

const outputPath = process.argv[1];
const socketPath = process.env[${JSON.stringify(MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV)}];
const capability = process.env[${JSON.stringify(MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV)}];
if (!socketPath || !capability) process.exit(41);
writeFileSync(outputPath, JSON.stringify({ socketPath, capability }));
setInterval(() => {}, 1000);
`;

interface ToolControlCredentials {
  readonly socketPath: string;
  readonly capability: string;
}

async function waitForToolControlCredentials(
  path: string,
  timeoutMs = 3_000,
): Promise<ToolControlCredentials> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const payload = JSON.parse(await readFile(path, "utf8")) as {
        socketPath?: unknown;
        capability?: unknown;
      };
      if (
        typeof payload.socketPath === "string" &&
        typeof payload.capability === "string"
      ) {
        return {
          socketPath: payload.socketPath,
          capability: payload.capability,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for tool-control credentials");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function openToolRegistration(
  credentials: ToolControlCredentials,
  role: "parent" | "child",
  pid: number,
): Promise<NetSocket> {
  const socket = await startToolRegistration(credentials, role, pid);
  let timeout: NodeJS.Timeout | undefined;
  const [response] = (await Promise.race([
    once(socket, "data"),
    once(socket, "close").then(() => {
      throw new Error(`tool registration ${role} closed before acceptance`);
    }),
    new Promise<never>((_, rejectTimeout) => {
      timeout = setTimeout(
        () => rejectTimeout(new Error(`tool registration ${role} timed out`)),
        1_000,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  })) as [Buffer | string];
  expect(String(response)).toContain('"registered":true');
  return socket;
}

async function startToolRegistration(
  credentials: ToolControlCredentials,
  role: "parent" | "child",
  pid: number,
): Promise<NetSocket> {
  const socket = createConnection(credentials.socketPath);
  socket.setEncoding("utf8");
  await once(socket, "connect");
  socket.write(
    `${JSON.stringify({ capability: credentials.capability, role, pid })}\n`,
  );
  return socket;
}

async function sendClosedToolRegistration(
  credentials: ToolControlCredentials,
  role: "parent" | "child",
  pid: number,
): Promise<void> {
  const socket = createConnection(credentials.socketPath);
  await once(socket, "connect");
  socket.end(
    `${JSON.stringify({ capability: credentials.capability, role, pid })}\n`,
  );
  await once(socket, "close");
}

function asChildProcess(
  spawned: SpawnedProcess,
): ChildProcessWithoutNullStreams {
  return spawned as ChildProcessWithoutNullStreams;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalRealProcessGroup(
  processGroupId: number,
  signal: "SIGSTOP" | "SIGKILL",
): "sent" | "gone" | "failure" {
  try {
    process.kill(-processGroupId, signal);
    return "sent";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "gone"
      : "failure";
  }
}

function realProcessGroupLiveness(
  processGroupId: number,
): "alive" | "gone" | "unknown" {
  try {
    process.kill(-processGroupId, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function waitForTestProcessDeath(
  isAlive: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive() && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  if (isAlive()) throw new Error(`${description} survived test cleanup`);
}

async function waitForLaunchedGroupId(
  path: string,
  timeoutMs = 3_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const payload = JSON.parse(await readFile(path, "utf8")) as {
        processGroupId?: unknown;
      };
      if (
        typeof payload.processGroupId === "number" &&
        Number.isSafeInteger(payload.processGroupId) &&
        payload.processGroupId > 1
      ) {
        return payload.processGroupId;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for detached tool launch evidence");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function forceKillExactTestGroup(
  processGroupId: number,
  root: ChildProcess,
): Promise<void> {
  try {
    process.kill(-processGroupId, "SIGCONT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForTestProcessDeath(
    () => processGroupExists(processGroupId),
    `Owned process group ${processGroupId}`,
  );
  if (root.exitCode === null && root.signalCode === null) {
    await Promise.race([
      once(root, "exit"),
      new Promise<never>((_, rejectTimeout) =>
        setTimeout(
          () => rejectTimeout(new Error("Owned root did not report exit")),
          1_000,
        ),
      ),
    ]);
  }
}

async function forceKillExactTestGroupId(
  processGroupId: number,
): Promise<void> {
  try {
    process.kill(-processGroupId, "SIGCONT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForTestProcessDeath(
    () => processGroupExists(processGroupId),
    `Owned process group ${processGroupId}`,
  );
}

async function waitForChildExitBounded(
  child: ChildProcess,
  timeoutMs = 1_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_, rejectTimeout) =>
      setTimeout(
        () => rejectTimeout(new Error("Owned root did not exit in time")),
        timeoutMs,
      ),
    ),
  ]);
}

async function forceKillExactTestProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForTestProcessDeath(
    () => processExists(pid),
    `Unrelated process ${pid}`,
  );
}

async function proveRetainedGroupAuthority(
  exitTiming: "before-readiness" | "after-readiness",
): Promise<void> {
  const fixture = await createManagedAgentFixture(
    () => `fast-root-exit-${exitTiming}`,
  );
  fixtures.push(fixture);
  const observer = new LocalManagedAgentProcessObserver();
  const rawController = new AbortController();
  const forwardedController = new AbortController();
  const unrelated = spawnChild(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  await once(unrelated, "spawn");
  observer.bindAbortSignal(rawController.signal);
  let anchor: ChildProcessWithoutNullStreams | undefined;
  let ownedProcessGroupId: number | undefined;
  try {
    const exitMarker = join(
      fixture.workspaceRoot,
      FIXTURE_PATHS.processDirectory,
      "exit-inner-root",
    );
    anchor = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          FAST_EXIT_ROOT_SCRIPT,
          FIXTURE_PATHS.processPidFile,
          exitTiming,
          exitMarker,
        ],
        cwd: fixture.workspaceRoot,
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    ownedProcessGroupId = anchor.pid;
    expect(ownedProcessGroupId).toBeTypeOf("number");
    const [workerRootPid, nonCooperativeChildPid] =
      await waitForManagedAgentFixturePids(fixture);

    let readiness;
    if (exitTiming === "after-readiness") {
      readiness = await prepareCancellationAfterTransientReadFailure(observer);
      await writeFile(exitMarker, "exit\n");
    }
    await waitForTestProcessDeath(
      () => processExists(workerRootPid!),
      `Fast SDK root ${workerRootPid}`,
    );
    expect(processExists(nonCooperativeChildPid!)).toBe(true);
    if (!readiness) {
      readiness = await prepareCancellationAfterTransientReadFailure(observer);
    }

    expect(readiness).toMatchObject({
      supported: true,
      reason: "ready",
      ownershipProven: true,
    });
    expect(readiness.observedPids).toContain(nonCooperativeChildPid);
    expect(readiness.observedPids).not.toContain(unrelated.pid);

    rawController.abort();
    const teardown = await observer.emergencyCleanup(1_000);
    expect(teardown).toMatchObject({
      quiescent: true,
      deadlineMet: true,
      ownershipProven: true,
      forceKillIssued: true,
      alivePidsAtDeadline: [],
    });
    expect(processExists(nonCooperativeChildPid!)).toBe(false);
    expect(processExists(unrelated.pid!)).toBe(true);
  } finally {
    rawController.abort();
    forwardedController.abort();
    if (anchor && typeof ownedProcessGroupId === "number") {
      await forceKillExactTestGroup(ownedProcessGroupId, anchor);
    }
    observer.dispose();
    await forceKillExactTestProcess(unrelated);
  }
}

interface RegisteredDescendantToolRun {
  readonly fixture: ManagedAgentFixture;
  readonly observer: LocalManagedAgentProcessObserver;
  readonly forwardedController: AbortController;
  readonly anchor: ChildProcessWithoutNullStreams;
  readonly toolPids: readonly [number, number];
  readonly toolProcessGroupId: number;
}

interface RegisteredDescendantToolSetupEvidence {
  readonly anchorProcessGroupId: number;
  readonly toolPids: readonly [number, number];
  readonly toolProcessGroupId: number;
}

interface RegisteredDescendantSetupCleanupError extends Error {
  readonly setupError: unknown;
  readonly cleanupErrors: readonly unknown[];
}

function setupAndCleanupFailure(
  setupError: unknown,
  cleanupErrors: readonly unknown[],
): RegisteredDescendantSetupCleanupError {
  const failure = new Error(
    "Registered descendant setup and cleanup both failed",
  ) as RegisteredDescendantSetupCleanupError;
  Object.defineProperties(failure, {
    cleanupErrors: { value: [...cleanupErrors] },
    setupError: { value: setupError },
  });
  return failure;
}

async function startRegisteredDescendantToolRun(
  observer: LocalManagedAgentProcessObserver,
  name: string,
  afterPidPublication?: (
    evidence: RegisteredDescendantToolSetupEvidence,
  ) => void | Promise<void>,
): Promise<RegisteredDescendantToolRun> {
  const fixture = await createManagedAgentFixture(() => name);
  fixtures.push(fixture);
  const forwardedController = new AbortController();
  const launchFile = join(fixture.root, "registered-tool-launch.json");
  observer.armToolProcessContainment();
  const anchor = asChildProcess(
    observer.spawn({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        REGISTERED_DESCENDANT_TOOL_SCRIPT,
        join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
        join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
        launchFile,
      ],
      cwd: fixture.workspaceRoot,
      env: { ...process.env },
      signal: forwardedController.signal,
    }),
  );
  let toolProcessGroupId: number | undefined;
  try {
    const anchorProcessGroupId = anchor.pid;
    if (typeof anchorProcessGroupId !== "number") {
      throw new Error("Owned fixture anchor failed to spawn");
    }
    toolProcessGroupId = await waitForLaunchedGroupId(launchFile);
    const [parentPid, childPid] = await waitForManagedAgentFixturePids(
      fixture,
      5_000,
    );
    const toolPids = [parentPid!, childPid!] as const;
    if (parentPid !== toolProcessGroupId) {
      throw new Error("Detached fixture group does not match its parent PID");
    }
    await afterPidPublication?.({
      anchorProcessGroupId,
      toolPids,
      toolProcessGroupId,
    });
    await expect(
      prepareCancellationAfterTransientReadFailure(observer),
    ).resolves.toMatchObject({
      supported: true,
      reason: "ready",
      ownershipProven: true,
    });
    return {
      fixture,
      observer,
      forwardedController,
      anchor,
      toolPids,
      toolProcessGroupId,
    };
  } catch (setupError) {
    const cleanupErrors: unknown[] = [];
    try {
      if (
        typeof toolProcessGroupId === "number" &&
        processGroupExists(toolProcessGroupId)
      ) {
        await forceKillExactTestGroupId(toolProcessGroupId);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (typeof anchor.pid === "number") {
        await forceKillExactTestGroup(anchor.pid, anchor);
      }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      forwardedController.abort();
      observer.dispose();
    }
    if (cleanupErrors.length > 0) {
      throw setupAndCleanupFailure(setupError, cleanupErrors);
    }
    throw setupError;
  }
}

async function cleanupRegisteredDescendantToolRun(
  run: RegisteredDescendantToolRun | undefined,
): Promise<void> {
  if (!run) return;
  if (processGroupExists(run.toolProcessGroupId)) {
    await forceKillExactTestGroupId(run.toolProcessGroupId);
  }
  if (typeof run.anchor.pid === "number") {
    if (run.anchor.exitCode === null && run.anchor.signalCode === null) {
      await waitForChildExitBounded(run.anchor, 100).catch(() => undefined);
    }
    if (run.anchor.exitCode === null && run.anchor.signalCode === null) {
      await forceKillExactTestGroup(run.anchor.pid, run.anchor);
    } else {
      await waitForTestProcessDeath(
        () => processGroupExists(run.anchor.pid!),
        `Owned root group ${run.anchor.pid}`,
      );
    }
  }
  run.forwardedController.abort();
  run.observer.dispose();
}

describe("LocalManagedAgentProcessObserver", () => {
  it("retains setup and cleanup failures without requiring AggregateError", () => {
    const setupError = new Error("synthetic setup failure");
    const cleanupError = new Error("synthetic cleanup failure");

    const failure = setupAndCleanupFailure(setupError, [cleanupError]);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(
      "Registered descendant setup and cleanup both failed",
    );
    expect(failure.setupError).toBe(setupError);
    expect(failure.cleanupErrors).toEqual([cleanupError]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps inner arguments out of supervisor argv and scrubs its private payload",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const privateArgument = "inner-only-supervisor-argument";
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [
            "-e",
            [
              'const payload = "SAPIOM_MANAGED_AGENT_SUPERVISOR_PAYLOAD";',
              "const valid = process.argv[1] === " +
                JSON.stringify(privateArgument) +
                " && !Object.hasOwn(process.env, payload);",
              "process.exit(valid ? 0 : 31);",
            ].join(""),
            privateArgument,
          ],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      try {
        expect(anchor.spawnargs.join("\u0000")).not.toContain(privateArgument);
        const [exitCode, signalCode] = await once(anchor, "exit");
        expect(exitCode).toBe(0);
        expect(signalCode).toBeNull();
      } finally {
        if (typeof anchor.pid === "number") {
          await forceKillExactTestGroup(anchor.pid, anchor);
        }
        controller.abort();
        observer.dispose();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "preserves a normal inner exit code without reporting a signal kill",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [
            "-e",
            'process.stderr.write("x".repeat(1024 * 1024), () => process.exit(23));',
          ],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      let forwardedStderrBytes = 0;
      anchor.stderr.on("data", (chunk: Buffer) => {
        forwardedStderrBytes += chunk.byteLength;
      });
      try {
        const [exitCode, signalCode] = await once(anchor, "exit");
        expect(exitCode).toBe(23);
        expect(signalCode).toBeNull();
        expect(forwardedStderrBytes).toBe(1024 * 1024);
      } finally {
        if (typeof anchor.pid === "number") {
          await forceKillExactTestGroup(anchor.pid, anchor);
        }
        controller.abort();
        observer.dispose();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "force-stops and kills the exact non-cooperative fixture group, then confirms death inside one deadline",
    async () => {
      const fixture = await createManagedAgentFixture(() => "process-observer");
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const rawController = new AbortController();
      const forwardedController = new AbortController();
      const unrelated = spawnChild(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      await once(unrelated, "spawn");
      let root: ChildProcessWithoutNullStreams | undefined;
      let ownedProcessGroupId: number | undefined;
      observer.bindAbortSignal(rawController.signal);
      try {
        root = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [FIXTURE_PATHS.processScript, FIXTURE_PATHS.processPidFile],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        ownedProcessGroupId = root.pid;
        expect(ownedProcessGroupId).toBeTypeOf("number");
        const fixturePids = await waitForManagedAgentFixturePids(fixture);
        const readiness =
          await prepareCancellationAfterTransientReadFailure(observer);
        expect(readiness).toMatchObject({
          supported: true,
          reason: "ready",
        });
        expect(
          fixturePids.every((pid) => readiness.observedPids.includes(pid)),
        ).toBe(true);
        expect(readiness.observedPids).not.toContain(unrelated.pid);

        const startedAt = Date.now();
        rawController.abort();
        const teardown = await observer.emergencyCleanup(1_000);

        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          processTableAvailable: true,
          containmentSupported: true,
          ownershipProven: true,
          forceKillIssued: true,
          emergencyCleanupAttempted: true,
          alivePidsAtDeadline: [],
        });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(processExists(unrelated.pid!)).toBe(true);
      } finally {
        rawController.abort();
        forwardedController.abort();
        if (root && typeof ownedProcessGroupId === "number") {
          // Test-harness safety must not depend on the observer behavior under
          // test. Exact test-owned PGID authority is retained until death is
          // independently confirmed, including when an assertion fails.
          await forceKillExactTestGroup(ownedProcessGroupId, root);
        }
        observer.dispose();
        await forceKillExactTestProcess(unrelated);
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills the complete owned group on parent IPC disconnect without touching an unrelated process",
    async () => {
      const fixture = await createManagedAgentFixture(() => "ipc-disconnect");
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const unrelated = spawnChild(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      await once(unrelated, "spawn");
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [FIXTURE_PATHS.processScript, FIXTURE_PATHS.processPidFile],
          cwd: fixture.workspaceRoot,
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      const ownedProcessGroupId = anchor.pid;
      expect(ownedProcessGroupId).toBeTypeOf("number");
      try {
        const fixturePids = await waitForManagedAgentFixturePids(fixture);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          ownershipProven: true,
        });

        anchor.disconnect();
        const teardown = await observer.waitForQuiescence(1_000);
        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          ownershipProven: true,
          forceKillIssued: false,
          alivePidsAtDeadline: [],
        });
        expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
        expect(processExists(unrelated.pid!)).toBe(true);
      } finally {
        if (typeof ownedProcessGroupId === "number") {
          await forceKillExactTestGroup(ownedProcessGroupId, anchor);
        }
        controller.abort();
        observer.dispose();
        await forceKillExactTestProcess(unrelated);
      }
    },
    10_000,
  );

  it("fails preparation closed after a fast root exits and never signals its former numeric group", async () => {
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      signalProcessGroup: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const rawController = new AbortController();
    const forwardedController = new AbortController();
    observer.bindAbortSignal(rawController.signal);
    const child = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    await once(child, "exit");
    try {
      await expect(
        prepareCancellationAfterTransientReadFailure(observer),
      ).resolves.toMatchObject({
        supported: false,
        reason: "root_not_active",
      });
      rawController.abort();
      forwardedController.abort();
      await observer.emergencyCleanup(0);
      expect(signals).toEqual([]);
    } finally {
      observer.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "retains owned group authority when the SDK root exits before its non-cooperative child",
    () => proveRetainedGroupAuthority("before-readiness"),
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "retains owned group authority when the SDK root exits after readiness while its child survives",
    () => proveRetainedGroupAuthority("after-readiness"),
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "stops and kills a freshly revalidated detached tool group wholly descended from the owned root",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "anchored-descendant-tool",
      );
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const unrelated = spawnChild(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      await once(unrelated, "spawn");
      let anchor: ChildProcessWithoutNullStreams | undefined;
      let toolGroupId: number | undefined;
      let fixturePids: readonly number[] = [];
      try {
        observer.armToolProcessContainment();
        anchor = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              REGISTERED_DESCENDANT_TOOL_SCRIPT,
              join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
              join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
              // Omit launch evidence to exercise the direct-launcher contract.
            ],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        fixturePids = await waitForManagedAgentFixturePids(fixture);
        toolGroupId = fixturePids[0];
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          ownershipProven: true,
        });

        const teardown = await observer.emergencyCleanup(2_000);

        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          containmentSupported: true,
          ownershipProven: true,
          forceKillIssued: true,
          toolProcessObservationComplete: true,
          toolProcessChannelsClosed: true,
          alivePidsAtDeadline: [],
        });
        expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
        expect(processExists(unrelated.pid!)).toBe(true);
      } finally {
        forwardedController.abort();
        if (
          typeof toolGroupId === "number" &&
          processGroupExists(toolGroupId)
        ) {
          await forceKillExactTestGroupId(toolGroupId);
        }
        if (anchor && typeof anchor.pid === "number") {
          await forceKillExactTestGroup(anchor.pid, anchor);
        }
        observer.dispose();
        await forceKillExactTestProcess(unrelated);
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "cleans exact fixture and anchor groups when setup fails after PID publication",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      let setupEvidence: RegisteredDescendantToolSetupEvidence | undefined;
      try {
        await expect(
          startRegisteredDescendantToolRun(
            observer,
            "failed-registered-tool-setup",
            (evidence) => {
              setupEvidence = evidence;
              throw new Error("synthetic failure after PID publication");
            },
          ),
        ).rejects.toThrow("synthetic failure after PID publication");

        expect(setupEvidence).toBeDefined();
        expect(
          setupEvidence!.toolPids.every((pid) => !processExists(pid)),
        ).toBe(true);
        expect(processGroupExists(setupEvidence!.toolProcessGroupId)).toBe(
          false,
        );
        expect(processGroupExists(setupEvidence!.anchorProcessGroupId)).toBe(
          false,
        );
      } finally {
        if (
          setupEvidence &&
          processGroupExists(setupEvidence.toolProcessGroupId)
        ) {
          await forceKillExactTestGroupId(setupEvidence.toolProcessGroupId);
        }
        if (
          setupEvidence &&
          processGroupExists(setupEvidence.anchorProcessGroupId)
        ) {
          await forceKillExactTestGroupId(setupEvidence.anchorProcessGroupId);
        }
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "refuses detached tool authority when a foreign member joins the candidate group",
    async () => {
      let injectForeignMember = false;
      let toolProcessGroupId: number | undefined;
      const signals: Array<readonly [number, "SIGSTOP" | "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          const observation = await readRealPosixProcessTable();
          if (
            !observation.available ||
            !injectForeignMember ||
            typeof toolProcessGroupId !== "number"
          ) {
            return observation;
          }
          const processes = new Map(observation.processes);
          let foreignPid = 2_000_000_000;
          while (processes.has(foreignPid)) foreignPid -= 1;
          processes.set(foreignPid, {
            parentPid: process.pid,
            processGroupId: toolProcessGroupId,
            state: "S",
            startedAt: "synthetic-foreign-member",
          });
          return { available: true, processes };
        },
        signalProcessGroup: (groupId, signal) => {
          signals.push([groupId, signal]);
          return signalRealProcessGroup(groupId, signal);
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "foreign-tool-group-member",
        );
        toolProcessGroupId = run.toolProcessGroupId;
        injectForeignMember = true;

        const teardown = await observer.emergencyCleanup(250);

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: true,
        });
        expect(
          signals.filter(([groupId]) => groupId === toolProcessGroupId),
        ).toEqual([]);
        expect(processGroupExists(toolProcessGroupId)).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals a cached detached group after its registered identities disappear and are reused",
    async () => {
      let simulatePidReuse = false;
      let toolProcessGroupId: number | undefined;
      let registeredPids: readonly [number, number] | undefined;
      const signals: Array<readonly [number, "SIGSTOP" | "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          const observation = await readRealPosixProcessTable();
          if (
            !observation.available ||
            !simulatePidReuse ||
            typeof toolProcessGroupId !== "number" ||
            !registeredPids
          ) {
            return observation;
          }
          const processes = new Map(observation.processes);
          const [parentPid, childPid] = registeredPids;
          processes.set(parentPid, {
            parentPid: process.pid,
            processGroupId: toolProcessGroupId,
            state: "S",
            startedAt: "reused-parent-identity",
          });
          processes.set(childPid, {
            parentPid,
            processGroupId: toolProcessGroupId,
            state: "S",
            startedAt: "reused-child-identity",
          });
          return { available: true, processes };
        },
        processGroupLiveness: (groupId) =>
          simulatePidReuse && groupId === toolProcessGroupId
            ? "alive"
            : realProcessGroupLiveness(groupId),
        signalProcessGroup: (groupId, signal) => {
          signals.push([groupId, signal]);
          return signalRealProcessGroup(groupId, signal);
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "reused-tool-identities",
        );
        toolProcessGroupId = run.toolProcessGroupId;
        registeredPids = run.toolPids;
        await forceKillExactTestGroupId(toolProcessGroupId);
        simulatePidReuse = true;

        const teardown = await observer.emergencyCleanup(250);

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: true,
        });
        expect(
          signals.filter(([groupId]) => groupId === toolProcessGroupId),
        ).toEqual([]);
      } finally {
        simulatePidReuse = false;
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "retries detached tool stop and kill failures only after fresh authority checks",
    async () => {
      let processTableReads = 0;
      let toolProcessGroupId: number | undefined;
      let stopAttempts = 0;
      let killAttempts = 0;
      const toolSignals: Array<{
        readonly signal: "SIGSTOP" | "SIGKILL";
        readonly processTableReads: number;
      }> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          processTableReads += 1;
          return readRealPosixProcessTable();
        },
        signalProcessGroup: (groupId, signal) => {
          if (groupId !== toolProcessGroupId) {
            return signalRealProcessGroup(groupId, signal);
          }
          toolSignals.push({ signal, processTableReads });
          if (signal === "SIGSTOP" && stopAttempts++ === 0) return "failure";
          if (signal === "SIGKILL" && killAttempts++ === 0) return "failure";
          return signalRealProcessGroup(groupId, signal);
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "retry-tool-signals",
        );
        toolProcessGroupId = run.toolProcessGroupId;

        const teardown = await observer.emergencyCleanup(3_000);

        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          forceKillIssued: true,
          alivePidsAtDeadline: [],
        });
        expect(toolSignals.map(({ signal }) => signal)).toEqual([
          "SIGSTOP",
          "SIGSTOP",
          "SIGKILL",
          "SIGKILL",
        ]);
        expect(
          toolSignals.every(
            (attempt, index) =>
              index === 0 ||
              attempt.processTableReads >
                toolSignals[index - 1]!.processTableReads,
          ),
        ).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals the detached tool group after the owned root exits and ancestry is lost",
    async () => {
      let toolProcessGroupId: number | undefined;
      const signals: Array<readonly [number, "SIGSTOP" | "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        signalProcessGroup: (groupId, signal) => {
          signals.push([groupId, signal]);
          return signalRealProcessGroup(groupId, signal);
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "root-exit-loses-tool-ancestry",
        );
        toolProcessGroupId = run.toolProcessGroupId;
        process.kill(-run.anchor.pid!, "SIGKILL");
        await waitForChildExitBounded(run.anchor);
        expect(processGroupExists(toolProcessGroupId)).toBe(true);

        const teardown = await observer.emergencyCleanup(250);

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: false,
        });
        expect(
          signals.filter(([groupId]) => groupId === toolProcessGroupId),
        ).toEqual([]);
        expect(processGroupExists(toolProcessGroupId)).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals a detached PGID merely because a capability holder claimed it",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "unanchored-tool-registration",
      );
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const credentialFile = join(fixture.root, "tool-control.json");
      let anchor: ChildProcessWithoutNullStreams | undefined;
      let detachedTool: ChildProcess | undefined;
      let registrations: readonly NetSocket[] = [];
      try {
        observer.armToolProcessContainment();
        anchor = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              EXPORT_TOOL_CONTROL_SCRIPT,
              credentialFile,
            ],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        const credentials = await waitForToolControlCredentials(credentialFile);
        detachedTool = spawnChild(
          process.execPath,
          [FIXTURE_PATHS.processScript, FIXTURE_PATHS.processPidFile],
          {
            cwd: fixture.workspaceRoot,
            detached: true,
            env: { ...process.env },
            stdio: "ignore",
            windowsHide: true,
          },
        );
        const [toolParentPid, toolChildPid] =
          await waitForManagedAgentFixturePids(fixture);
        registrations = await Promise.all([
          startToolRegistration(credentials, "parent", toolParentPid),
          startToolRegistration(credentials, "child", toolChildPid),
        ]);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: false,
          reason: "tool_process_not_registered",
        });

        const teardown = await observer.emergencyCleanup(100);

        expect(teardown.quiescent).toBe(false);
        expect(processGroupExists(detachedTool.pid!)).toBe(true);
      } finally {
        for (const registration of registrations) registration.destroy();
        forwardedController.abort();
        if (detachedTool && typeof detachedTool.pid === "number") {
          await forceKillExactTestGroup(detachedTool.pid, detachedTool);
        }
        if (anchor && typeof anchor.pid === "number") {
          await forceKillExactTestGroup(anchor.pid, anchor);
        }
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "clears a closed pending registration, accepts retries, and requires both lifetime channels to close",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "tool-registration-retry",
      );
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const credentialFile = join(fixture.root, "tool-control.json");
      let anchor: ChildProcessWithoutNullStreams | undefined;
      let detachedToolGroupId: number | undefined;
      let parentRegistration: NetSocket | undefined;
      let childRegistration: NetSocket | undefined;
      try {
        observer.armToolProcessContainment();
        anchor = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              DESCENDANT_TOOL_SCRIPT,
              join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
              join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
              credentialFile,
            ],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        const credentials = await waitForToolControlCredentials(credentialFile);
        const [toolParentPid, toolChildPid] =
          await waitForManagedAgentFixturePids(fixture);
        detachedToolGroupId = toolParentPid;

        await sendClosedToolRegistration(credentials, "parent", toolParentPid);
        [parentRegistration, childRegistration] = await Promise.all([
          openToolRegistration(credentials, "parent", toolParentPid),
          openToolRegistration(credentials, "child", toolChildPid),
        ]);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          containmentSupported: true,
        });

        await forceKillExactTestGroupId(detachedToolGroupId);
        forwardedController.abort();
        const openChannelObservation = await observer.emergencyCleanup(1_000);
        await waitForChildExitBounded(anchor);
        expect(openChannelObservation).toMatchObject({
          quiescent: false,
          deadlineMet: false,
        });

        parentRegistration.destroy();
        childRegistration.destroy();
        const finalObservation = await observer.waitForQuiescence(3_000);
        expect(finalObservation).toMatchObject({
          quiescent: true,
          deadlineMet: true,
        });
      } finally {
        parentRegistration?.destroy();
        childRegistration?.destroy();
        forwardedController.abort();
        if (
          typeof detachedToolGroupId === "number" &&
          processGroupExists(detachedToolGroupId)
        ) {
          await forceKillExactTestGroupId(detachedToolGroupId);
        }
        if (anchor && typeof anchor.pid === "number") {
          await forceKillExactTestGroup(anchor.pid, anchor);
        }
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never reports an armed but unregistered tool scope as quiescent",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      observer.armToolProcessContainment();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      try {
        if (anchor.exitCode === null && anchor.signalCode === null) {
          await once(anchor, "exit");
        }
        await expect(observer.waitForQuiescence(50)).resolves.toMatchObject({
          quiescent: false,
          deadlineMet: false,
          containmentSupported: false,
        });
        await expect(observer.emergencyCleanup(50)).resolves.toMatchObject({
          quiescent: false,
          deadlineMet: false,
          containmentSupported: false,
        });
      } finally {
        controller.abort();
        if (typeof anchor.pid === "number") {
          await forceKillExactTestGroup(anchor.pid, anchor);
        }
        observer.dispose();
      }
    },
    5_000,
  );

  it("bounds a hanging process-table read and never turns unknown observation into quiescence", async () => {
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: () => new Promise(() => undefined),
      signalProcessGroup: (groupId, signal) => {
        signals.push([groupId, signal]);
        try {
          process.kill(-groupId, signal);
        } catch {
          // The test-owned group may already have exited between signals.
        }
        return "sent";
      },
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    const startedAt = Date.now();
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "process_table_unavailable",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      const shortConfirmationStartedAt = Date.now();
      await expect(observer.waitForQuiescence(50)).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        processTableAvailable: false,
      });
      expect(Date.now() - shortConfirmationStartedAt).toBeLessThan(150);

      controller.abort();
      await once(child, "exit");
      expect(signals).toEqual([
        [child.pid!, "SIGSTOP"],
        [child.pid!, "SIGKILL"],
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      controller.abort();
      observer.dispose();
    }
  });

  it("marks an observed POSIX group escape unsupported without authorizing an individual signal", async () => {
    let rootPid = 0;
    let escaped = false;
    const signals: Array<readonly [number, string]> = [];
    const table = async (): Promise<ManagedAgentProcessTableObservation> => {
      const rootRecord = {
        parentPid: process.pid,
        processGroupId: rootPid,
        startedAt: "root",
      };
      const childRecord = {
        parentPid: rootPid,
        processGroupId: escaped ? rootPid + 1 : rootPid,
        startedAt: "child",
      };
      return available([
        [rootPid, rootRecord],
        [rootPid + 100, childRecord],
      ]);
    };
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: table,
      signalProcessGroup: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });
      escaped = true;
      await observer.observeProcessTree();
      await expect(observer.waitForQuiescence(0)).resolves.toMatchObject({
        quiescent: false,
        containmentSupported: false,
      });
      expect(signals).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      controller.abort();
      observer.dispose();
    }
  });

  it("makes raw and forwarded aborts idempotent after ownership preparation", async () => {
    let rootPid = 0;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              startedAt: "root",
            },
          ],
          [
            rootPid + 100,
            {
              parentPid: rootPid,
              processGroupId: rootPid,
              startedAt: "child",
            },
          ],
        ]),
      signalProcessGroup: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const rawController = new AbortController();
    const forwardedController = new AbortController();
    observer.bindAbortSignal(rawController.signal);
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await observer.prepareCancellation();
      rawController.abort();
      forwardedController.abort();
      expect(signals).toEqual([
        [rootPid, "SIGSTOP"],
        [rootPid, "SIGKILL"],
      ]);
    } finally {
      child.kill("SIGKILL");
      observer.dispose();
    }
  });

  it("retries a failed SIGKILL while the trusted stopped root still anchors the group", async () => {
    let rootPid = 0;
    let killAttempts = 0;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              startedAt: "root",
            },
          ],
        ]),
      signalProcessGroup: (groupId, signal) => {
        signals.push([groupId, signal]);
        if (signal === "SIGKILL" && killAttempts++ === 0) return "failure";
        return "sent";
      },
    });
    const rawController = new AbortController();
    const forwardedController = new AbortController();
    observer.bindAbortSignal(rawController.signal);
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await observer.prepareCancellation();
      rawController.abort();
      await observer.emergencyCleanup(0);

      expect(signals).toEqual([
        [rootPid, "SIGSTOP"],
        [rootPid, "SIGKILL"],
        [rootPid, "SIGKILL"],
      ]);
      await expect(observer.waitForQuiescence(0)).resolves.toMatchObject({
        containmentSupported: false,
        forceKillIssued: true,
        quiescent: false,
      });
    } finally {
      child.kill("SIGKILL");
      observer.dispose();
    }
  });

  it("treats an unexpected group-liveness probe error as unknown, never gone", async () => {
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => available([]),
      processGroupLiveness: () => "unknown",
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    await once(child, "exit");
    try {
      await expect(observer.waitForQuiescence(0)).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        containmentSupported: false,
      });
    } finally {
      controller.abort();
      observer.dispose();
    }
  });

  it("rejects Windows cancellation containment before granting signal authority", async () => {
    const observer = new LocalManagedAgentProcessObserver({
      platform: "win32",
    });
    await expect(observer.prepareCancellation()).resolves.toMatchObject({
      supported: false,
      reason: "platform_unsupported",
      ownershipProven: false,
    });
    observer.dispose();
  });

  it("never tracks or signals PIDs injected through the model-writable fixture file", async () => {
    const fixture = await createManagedAgentFixture(() => "forged-pids");
    fixtures.push(fixture);
    const forgedPids = [process.pid, 2_147_483_646] as const;
    await writeFile(
      join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
      JSON.stringify({ parentPid: forgedPids[0], childPid: forgedPids[1] }),
    );
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      signalProcessGroup: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    try {
      await expect(waitForManagedAgentFixturePids(fixture)).resolves.toEqual(
        forgedPids,
      );
      await observer.observeProcessTree();
      const teardown = await observer.waitForQuiescence(0);
      await observer.emergencyCleanup(0);

      expect(teardown.observedPids).not.toContain(forgedPids[0]);
      expect(teardown.observedPids).not.toContain(forgedPids[1]);
      expect(signals).toEqual([]);
    } finally {
      observer.dispose();
    }
  });
});
