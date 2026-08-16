import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXTURE_PATHS,
  captureManagedAgentWorkspaceSnapshot,
  createManagedAgentFixture,
  diffManagedAgentWorkspaceSnapshots,
  fixtureGitStatus,
  verifyManagedAgentFixtureBytes,
  type ManagedAgentFixture,
} from "./fixture.js";

const fixtures: ManagedAgentFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("managed-agent disposable git fixture", () => {
  it("starts with a clean target plus dirty tracked and untracked sentinels", async () => {
    const fixture = await createManagedAgentFixture(
      () => "11111111-2222-3333-4444-555555555555",
    );
    fixtures.push(fixture);
    expect(await fixtureGitStatus(fixture)).toBe(
      ` M ${FIXTURE_PATHS.dirtySentinel}\n?? ${FIXTURE_PATHS.untrackedSentinel}\n`,
    );
    expect(fixture.prompt("L1")).toContain(FIXTURE_PATHS.untrackedSentinel);
    expect(fixture.prompt("L1")).not.toContain(fixture.nonce);
    expect(fixture.prompt("L2")).toContain(fixture.l2BashCommand);
    expect(await verifyManagedAgentFixtureBytes(fixture)).toEqual([
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ]);
  });

  it("observes only relative structural changes and preserves sentinel bytes", async () => {
    const fixture = await createManagedAgentFixture(() => "fixture-nonce");
    fixtures.push(fixture);
    const before = await captureManagedAgentWorkspaceSnapshot(
      fixture.workspaceRoot,
    );
    await Promise.all([
      writeFile(
        join(fixture.workspaceRoot, FIXTURE_PATHS.cleanTarget),
        fixture.cleanTargetReplacement,
      ),
      writeFile(
        join(fixture.workspaceRoot, FIXTURE_PATHS.createdTarget),
        fixture.createdTargetContents,
      ),
    ]);
    const after = await captureManagedAgentWorkspaceSnapshot(
      fixture.workspaceRoot,
    );
    expect(diffManagedAgentWorkspaceSnapshots(before, after)).toEqual([
      { path: FIXTURE_PATHS.cleanTarget, change: "modified" },
      { path: FIXTURE_PATHS.createdTarget, change: "created" },
    ]);
    expect(await verifyManagedAgentFixtureBytes(fixture)).toEqual([
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ]);
  });
});
