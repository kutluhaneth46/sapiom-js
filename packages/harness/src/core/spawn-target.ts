/**
 * Windows can't spawn a bare command name the way POSIX can.
 *
 * node-pty spawns via `CreateProcess`, which — unlike a shell — performs NO
 * `PATHEXT` resolution and cannot execute a `.cmd`/`.bat` at all. So on Windows
 * a coding agent installed by npm (which ships `claude.cmd`, not `claude.exe`)
 * fails with `Cannot create process, error code: 2` (ERROR_FILE_NOT_FOUND) even
 * though `doctor` found it — detection shells out to `where`, which *does*
 * resolve PATHEXT, so the agent looks present and then won't start.
 *
 * Routing through `cmd.exe /d /s /c` hands resolution to the shell that owns
 * those rules, instead of reimplementing PATHEXT lookup here:
 *   /d  skip AutoRun commands from the registry
 *   /s  the documented quoting mode for a command line built this way
 *   /c  run the command, then exit — so the pty's lifetime tracks the agent's
 *       and cmd.exe propagates its exit code
 *
 * Kept as a pure function taking `platform` explicitly so the Windows branch is
 * unit-testable from Linux CI, which is where this class of bug hid: nothing in
 * our test tiers ever spawned a real agent on Windows.
 */

export interface SpawnTarget {
  command: string;
  args: string[];
}

/** Executable images `CreateProcess` can launch directly, no shell needed. */
const DIRECTLY_EXECUTABLE = [".exe", ".com"];

export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== "win32") return { command, args: [...args] };

  // Already a real executable image (e.g. cmd.exe itself, or an absolute path
  // to a .exe): spawn it directly. Wrapping it would add a shell and its
  // quoting rules for nothing.
  const lower = command.toLowerCase();
  if (DIRECTLY_EXECUTABLE.some((ext) => lower.endsWith(ext))) {
    return { command, args: [...args] };
  }

  return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
}
