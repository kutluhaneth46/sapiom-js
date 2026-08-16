import { afterEach, describe, expect, it } from "vitest";

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
      observer.trackPids(pids);
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
      if (aliveAtFailure.length > 0)
        await observer.emergencyCleanup(aliveAtFailure);
      observer.dispose();
    }
  }, 10_000);
});
