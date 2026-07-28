/**
 * These exist because the Windows spawn bug was invisible to every test tier we
 * had: the mock-mode e2e never touches a server, the integration tests inject a
 * fake `spawnPty` (so they never reach CreateProcess), and CI ran the real thing
 * on Linux only. `platform` is a parameter precisely so the Windows branch is
 * asserted from Linux.
 */
import { describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "./spawn-target.js";

describe("resolveSpawnTarget", () => {
  it("leaves POSIX spawns untouched", () => {
    expect(resolveSpawnTarget("claude", ["--settings", "/tmp/s.json"], "linux")).toEqual({
      command: "claude",
      args: ["--settings", "/tmp/s.json"],
    });
    expect(resolveSpawnTarget("codex", [], "darwin")).toEqual({ command: "codex", args: [] });
  });

  it("routes a bare command through cmd.exe on Windows", () => {
    // The actual bug: npm installs `claude.cmd`, CreateProcess does no PATHEXT
    // lookup and cannot execute a .cmd, so a bare name died with
    // "Cannot create process, error code: 2" while doctor reported it present.
    expect(resolveSpawnTarget("claude", ["--settings", "C:\\s.json"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "claude", "--settings", "C:\\s.json"],
    });
  });

  it("routes an explicit .cmd shim through cmd.exe too", () => {
    const { command, args } = resolveSpawnTarget("C:\\npm\\claude.cmd", ["-p", "hi"], "win32");
    expect(command).toBe("cmd.exe");
    expect(args).toEqual(["/d", "/s", "/c", "C:\\npm\\claude.cmd", "-p", "hi"]);
  });

  it("spawns a real executable image directly — no needless shell", () => {
    // cmd.exe itself, and any .exe, must NOT be double-wrapped: that would add a
    // shell and its quoting rules for nothing.
    expect(resolveSpawnTarget("cmd.exe", ["/c", "exit", "0"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "exit", "0"],
    });
    expect(resolveSpawnTarget("C:\\Program Files\\nodejs\\node.exe", ["-v"], "win32")).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["-v"],
    });
  });

  it("matches the executable extension case-insensitively", () => {
    // Windows paths are case-insensitive; `where` happily returns CLAUDE.CMD.
    expect(resolveSpawnTarget("NODE.EXE", [], "win32").command).toBe("NODE.EXE");
    expect(resolveSpawnTarget("SETUP.COM", [], "win32").command).toBe("SETUP.COM");
  });

  it("preserves arguments verbatim, including spaces and empty strings", () => {
    // Quoting is node-pty's job; mangling args here would corrupt config paths
    // under "C:\Users\...\AppData\Local\Programs".
    const args = ["--settings", "C:\\Users\\a b\\s.json", "", "--flag"];
    expect(resolveSpawnTarget("claude", args, "win32").args).toEqual(["/d", "/s", "/c", "claude", ...args]);
  });

  it("does not mutate the caller's array", () => {
    const args = ["--one"];
    resolveSpawnTarget("claude", args, "win32");
    expect(args).toEqual(["--one"]);
  });
});
