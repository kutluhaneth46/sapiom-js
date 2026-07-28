/**
 * Windows can't spawn a bare command name, or a `.cmd` shim, the way POSIX can.
 *
 * node-pty spawns via `CreateProcess`, which — unlike a shell — does NO `PATHEXT`
 * resolution and cannot execute a `.cmd` at all. So a coding agent installed by
 * npm (which ships `claude.cmd`, not `claude.exe`) failed with
 * `Cannot create process, error code: 2` even though `doctor` found it: detection
 * shells out to `where`, which *does* resolve PATHEXT, so the agent looks present
 * and then won't start.
 *
 * ## Why this does not use `cmd.exe`
 *
 * The obvious fix — `cmd.exe /d /s /c <command> <args…>` — is a command-injection
 * hole, and a functional bug besides. node-pty quotes each argument for
 * `CreateProcess`/MSVCRT, escaping an embedded `"` as `\"`. But the immediate
 * child would be `cmd.exe`, whose tokenizer does not understand backslash-escaped
 * quotes: it toggles "inside quotes" on every literal `"` it sees. One embedded
 * quote therefore desynchronises cmd for the rest of the line, and any `&` or `|`
 * that lands in the now-unquoted span becomes a real command separator. That is
 * CVE-2024-27980's bug class, and `/s` does not address it.
 *
 * It is reachable on every session, not in a corner case: the codex adapter
 * builds `developer_instructions=${JSON.stringify(prompt)}` (JSON *always* emits
 * literal quotes) and the claude-code adapter passes raw prompt-file contents as
 * an argv element. Even ignoring injection, the quote desync mangles those values.
 *
 * So instead of escaping around a shell, we remove the shell. An npm `.cmd` shim
 * is a wrapper that ultimately runs `node <cli.js> %*`, so we read the shim,
 * recover the interpreter and script it points at, and spawn *those* directly.
 * Arguments then pass through exactly one quoting layer — node-pty's, which is
 * correct for `CreateProcess` — and no metacharacter is ever interpreted.
 *
 * Dependencies are injected so the whole Windows path is unit-testable from
 * Linux CI, which is where this class of bug hid: nothing in our test tiers ever
 * spawned a real agent on Windows.
 */
import { existsSync, readFileSync } from "node:fs";
// The win32 namespace explicitly, NOT the host-dependent exports: `join` and
// `delimiter` resolve to POSIX rules when this runs on Linux, which silently
// broke both PATH splitting (":" vs ";") and path building ("/" vs "\\") in the
// unit tests that simulate Windows — and would have broken the real lookup for
// anyone reasoning about it from a POSIX box.
import { win32 } from "node:path";

export interface SpawnTarget {
  command: string;
  args: string[];
}

export interface SpawnTargetDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  readText?: (p: string) => string;
}

/** Executable images `CreateProcess` can launch directly, no interpreter needed. */
const DIRECTLY_EXECUTABLE = [".exe", ".com"];
/** Shims we must look inside, because Windows cannot execute them. */
const SHIM_EXTENSIONS = [".cmd", ".bat"];

function hasExtension(file: string, extensions: readonly string[]): boolean {
  const lower = file.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/** Windows' own lookup rules: the literal name first, then each PATHEXT. */
function findOnPath(command: string, deps: Required<Pick<SpawnTargetDeps, "env" | "fileExists">>): string | null {
  const pathExt = (deps.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = (base: string): string[] => [base, ...pathExt.map((ext) => base + ext)];

  // An explicit path (absolute, or containing a separator) is not PATH-searched.
  if (win32.isAbsolute(command) || /[\\/]/.test(command)) {
    return candidates(command).find(deps.fileExists) ?? null;
  }
  // Windows separates PATH with ";" — always, regardless of the host we run on.
  for (const dir of (deps.env.PATH ?? deps.env.Path ?? "").split(";").filter(Boolean)) {
    const hit = candidates(win32.join(dir, command)).find(deps.fileExists);
    if (hit) return hit;
  }
  return null;
}

/**
 * Recover what an npm-generated `.cmd` shim actually runs. Its final line is of
 * the form:
 *
 *   … "%_prog%"  "%dp0%\node_modules\@scope\pkg\cli.js" %*
 *
 * so the script is the quoted `%dp0%`-relative path, and the interpreter is the
 * `node.exe` npm placed beside the shim (falling back to `node` on PATH).
 * Returns null when the shim isn't of that shape — we then refuse to spawn
 * rather than reaching for a shell, because a wrong guess here is a security bug.
 */
function readShimTarget(
  shim: string,
  deps: Required<Pick<SpawnTargetDeps, "env" | "fileExists" | "readText">>,
): SpawnTarget | null {
  let contents: string;
  try {
    contents = deps.readText(shim);
  } catch {
    return null;
  }

  const scriptRef = /"%~?dp0%?\\([^"]+\.[cm]?js)"/i.exec(contents);
  if (!scriptRef?.[1]) return null;

  const shimDir = win32.dirname(shim);
  const script = win32.join(shimDir, scriptRef[1]);
  if (!deps.fileExists(script)) return null;

  // npm prefers a node.exe sitting next to the shim; otherwise PATH's node.
  const adjacentNode = win32.join(shimDir, "node.exe");
  const interpreter = deps.fileExists(adjacentNode)
    ? adjacentNode
    : findOnPath("node", deps);
  if (!interpreter) return null;

  return { command: interpreter, args: [script] };
}

export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  deps: SpawnTargetDeps = {},
): SpawnTarget {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args] };

  const resolved: Required<Pick<SpawnTargetDeps, "env" | "fileExists" | "readText">> = {
    env: deps.env ?? process.env,
    fileExists: deps.fileExists ?? existsSync,
    readText: deps.readText ?? ((p) => readFileSync(p, "utf8")),
  };

  // Already a real executable image (cmd.exe itself, an absolute .exe): launch it
  // as given. Resolving further would only add failure modes.
  if (hasExtension(command, DIRECTLY_EXECUTABLE)) return { command, args: [...args] };

  const found = findOnPath(command, resolved);
  if (!found) {
    // Same outcome CreateProcess would give, with a message that says why.
    throw new Error(
      `cannot spawn "${command}" on Windows: not found on PATH (searched with PATHEXT). ` +
        `Install it, or pass an absolute path to the executable.`,
    );
  }

  if (hasExtension(found, DIRECTLY_EXECUTABLE)) return { command: found, args: [...args] };

  if (hasExtension(found, SHIM_EXTENSIONS)) {
    const target = readShimTarget(found, resolved);
    if (target) return { command: target.command, args: [...target.args, ...args] };
    throw new Error(
      `cannot spawn "${found}" on Windows: it is a .cmd/.bat shim whose target could not be ` +
        `determined, and running it through cmd.exe would expose arguments to shell parsing ` +
        `(command injection). Install a build that provides a real .exe, or point the harness ` +
        `at the interpreter and script directly.`,
    );
  }

  // Something like an extensionless sh script: not executable by CreateProcess,
  // and not a shim we can read. Refuse rather than shell out.
  throw new Error(
    `cannot spawn "${found}" on Windows: not an executable image and not a readable shim.`,
  );
}
