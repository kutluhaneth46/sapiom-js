import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXTURE_PATHS,
  captureManagedAgentWorkspaceSnapshot,
  createManagedAgentFixture,
  diffManagedAgentWorkspaceSnapshots,
  fixtureGitStatus,
  observeManagedAgentL1FinalBytes,
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

  it("renders L1 as eleven exact ordered calls without resolving the escape link", async () => {
    const fixture = await createManagedAgentFixture(() => "prompt-contract");
    fixtures.push(fixture);
    const prompt = fixture.prompt("L1");
    expect(prompt.split("\n")[0]).toBe("SAPIOM_MANAGED_AGENT_L1_PROMPT_V2");
    expect(prompt).toContain(
      "at most one optional verification Read after call 5 and before call 6",
    );
    expect(prompt).toContain(
      "exactly repeat call 1, 2, or 3 with the same literal file_path",
    );
    expect(prompt).toContain("Do not Read any other fixture path");
    const numberedLines = prompt
      .split("\n")
      .filter((line) => /^\d+\./.test(line));

    expect(numberedLines).toHaveLength(11);
    expect(numberedLines.map((line) => Number.parseInt(line, 10))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(numberedLines[4]).toContain(
      JSON.stringify({ file_path: FIXTURE_PATHS.escapeLink }),
    );
    expect(numberedLines[4]).toContain("exact relative path");
    expect(numberedLines[4]).not.toContain(fixture.outsideSentinel);
    expect(numberedLines[5]).toContain(
      JSON.stringify({
        file_path: FIXTURE_PATHS.cleanTarget,
        old_string: "clean target base\n",
        new_string: fixture.cleanTargetReplacement,
        replace_all: false,
      }),
    );
    expect(numberedLines[8]).toContain("fail_once");
    expect(numberedLines[9]).toContain("fail_once");
    expect(numberedLines[10]).toContain(
      JSON.stringify({ command: fixture.l1BashCommand }),
    );
    expect(prompt.split(fixture.outsideSentinel)).toHaveLength(2);
    expect(prompt.replace(fixture.outsideSentinel, "")).not.toContain(
      fixture.root,
    );
    expect(prompt).toContain(
      "After call 11 completes, make no further tool calls",
    );
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
    expect(
      observeManagedAgentL1FinalBytes(after, fixture.expectedL1FinalBytes),
    ).toEqual([
      { role: "clean_target", matched: true },
      { role: "managed_output", matched: true },
    ]);
    await writeFile(
      join(fixture.workspaceRoot, FIXTURE_PATHS.createdTarget),
      "wrong final bytes\n",
    );
    const incorrect = await captureManagedAgentWorkspaceSnapshot(
      fixture.workspaceRoot,
    );
    expect(
      observeManagedAgentL1FinalBytes(incorrect, fixture.expectedL1FinalBytes),
    ).toEqual([
      { role: "clean_target", matched: true },
      { role: "managed_output", matched: false },
    ]);
    expect(await verifyManagedAgentFixtureBytes(fixture)).toEqual([
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ]);
  });
});
