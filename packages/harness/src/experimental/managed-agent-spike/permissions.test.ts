import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ManagedAgentPathError,
  createManagedAgentPermissionHandler,
  resolveManagedAgentToolPath,
} from "./permissions.js";
import type { ManagedAgentPermissionEvidence } from "./types.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "managed-agent-permission-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await Promise.all([
    writeFile(join(workspace, "inside.txt"), "inside"),
    writeFile(join(outside, "secret.txt"), "outside"),
  ]);
  await symlink(join(outside, "secret.txt"), join(workspace, "escape.txt"));
  await symlink(outside, join(workspace, "escape-dir"));
  workspace = await realpath(workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("symlink-aware managed-agent containment", () => {
  it("allows existing and new in-root paths", async () => {
    expect(await resolveManagedAgentToolPath(workspace, "inside.txt")).toBe(
      join(workspace, "inside.txt"),
    );
    expect(await resolveManagedAgentToolPath(workspace, "nested/new.txt")).toBe(
      join(workspace, "nested/new.txt"),
    );
  });

  it("denies direct, traversal, sibling-prefix, and symlink escapes", async () => {
    const outsidePath = join(outside, "secret.txt");
    for (const requested of [
      outsidePath,
      "../outside/secret.txt",
      `${workspace}-evil/file.txt`,
      "escape.txt",
      "escape-dir/secret.txt",
      "escape-dir/new.txt",
    ]) {
      await expect(
        resolveManagedAgentToolPath(workspace, requested),
      ).rejects.toBeInstanceOf(ManagedAgentPathError);
    }
  });
});

describe("managed-agent permission handler", () => {
  it("uses exact Bash equality and emits content-free decisions", async () => {
    const evidence: ManagedAgentPermissionEvidence[] = [];
    const handler = createManagedAgentPermissionHandler({
      canonicalWorkspaceRoot: workspace,
      allowedBashCommands: ["git status --short"],
      allowedMcpTools: ["mcp__probe__echo_nonce"],
      onDecision: (decision) => evidence.push(decision),
    });
    const permission = {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      requestId: "request-1",
    };

    await expect(
      handler("Bash", { command: "git status --short" }, permission),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      handler("Bash", { command: "git status --short " }, permission),
    ).resolves.toMatchObject({ behavior: "deny", interrupt: false });
    await expect(
      handler("Read", { file_path: join(outside, "secret.txt") }, permission),
    ).resolves.toMatchObject({ behavior: "deny", interrupt: false });
    await expect(
      handler("mcp__probe__echo_nonce", { nonce: "secret" }, permission),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(handler("WebFetch", {}, permission)).resolves.toMatchObject({
      behavior: "deny",
    });

    expect(evidence.map(({ decision, reason }) => [decision, reason])).toEqual([
      ["allow", "exact_bash_command"],
      ["deny", "bash_command_not_allowed"],
      ["deny", "path_outside_workspace"],
      ["allow", "managed_mcp_tool"],
      ["deny", "tool_not_allowed"],
    ]);
    expect(JSON.stringify(evidence)).not.toContain(join(outside, "secret.txt"));
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(vi.isMockFunction(handler)).toBe(false);
  });
});
