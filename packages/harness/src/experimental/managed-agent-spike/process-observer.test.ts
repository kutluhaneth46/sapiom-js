import { once } from "node:events";
import {
  spawn as spawnChild,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  type ManagedAgentKernelProcessRecord,
  type ManagedAgentProcessTableObservation,
} from "./process-observer.js";

const fixtures: ManagedAgentFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function available(
  entries: readonly (readonly [number, ManagedAgentKernelProcessRecord])[],
): ManagedAgentProcessTableObservation {
  return { available: true, processes: new Map(entries) };
}

function activeNodeCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  };
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

async function forceKillExactTestGroup(
  processGroupId: number,
  root: ChildProcess,
): Promise<void> {
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

describe("LocalManagedAgentProcessObserver", () => {
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
        const readiness = await observer.prepareCancellation();
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
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
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
      child.kill("SIGKILL");
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
