import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  waitForManagedAgentFixturePids,
  type ManagedAgentFixture,
} from "./fixture.js";
import { LocalManagedAgentProcessObserver } from "./process-observer.js";

const fixtures: ManagedAgentFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("LocalManagedAgentProcessObserver", () => {
  it("terminates a recorded local tool parent and child within five seconds", async () => {
    const fixture = await createManagedAgentFixture(() => "process-observer");
    fixtures.push(fixture);
    const observer = new LocalManagedAgentProcessObserver();
    const controller = new AbortController();
    let aliveAtFailure: readonly number[] = [];
    try {
      observer.spawn({
        command: process.execPath,
        args: [FIXTURE_PATHS.processScript, FIXTURE_PATHS.processPidFile],
        cwd: fixture.workspaceRoot,
        env: { ...process.env },
        signal: controller.signal,
      });
      const pids = await waitForManagedAgentFixturePids(fixture);
      await observer.observeProcessTree();
      controller.abort();
      const teardown = await observer.waitForQuiescence(5_000);
      aliveAtFailure = teardown.alivePidsAtDeadline;
      expect(teardown.quiescent).toBe(true);
      expect(teardown.deadlineMet).toBe(true);
      expect(teardown.elapsedMs).toBeLessThanOrEqual(5_000);
      expect(pids.every((pid) => teardown.observedPids.includes(pid))).toBe(
        true,
      );
      expect(teardown.alivePidsAtDeadline).toEqual([]);
    } finally {
      controller.abort();
      if (aliveAtFailure.length > 0) await observer.emergencyCleanup();
      observer.dispose();
    }
  }, 10_000);

  it("never tracks or signals PIDs injected through the model-writable fixture file", async () => {
    const fixture = await createManagedAgentFixture(() => "forged-pids");
    fixtures.push(fixture);
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    if (typeof unrelated.pid !== "number") {
      unrelated.kill("SIGKILL");
      throw new Error("unrelated test process did not expose a PID");
    }
    const forgedPids = [process.pid, unrelated.pid] as const;
    await writeFile(
      join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
      JSON.stringify({
        parentPid: forgedPids[0],
        childPid: forgedPids[1],
      }),
    );
    const observer = new LocalManagedAgentProcessObserver();
    const signalSpy = vi.spyOn(process, "kill");
    try {
      await expect(waitForManagedAgentFixturePids(fixture)).resolves.toEqual(
        forgedPids,
      );
      await observer.observeProcessTree();
      const teardown = await observer.waitForQuiescence(0);
      await observer.emergencyCleanup();

      expect(teardown.observedPids).not.toContain(forgedPids[0]);
      expect(teardown.observedPids).not.toContain(forgedPids[1]);
      expect(signalSpy).not.toHaveBeenCalled();
      expect(unrelated.exitCode).toBeNull();
    } finally {
      signalSpy.mockRestore();
      unrelated.kill("SIGKILL");
      observer.dispose();
    }
  });
});
