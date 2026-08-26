/**
 * bundle-error — turn esbuild's raw bundle failure into an actionable hint.
 *
 * The Canvas render, `check`, and `run_local` all esbuild-bundle a project's
 * `index.ts` resolving its imports from the project's own `node_modules`. By
 * far the most common failure is "Could not resolve …" against a project whose
 * dependencies were simply never installed (a fresh clone, or a scaffold whose
 * install was skipped/failed). Relaying esbuild's raw message — a wall of
 * "Could not resolve \"@sapiom/agent\" … Could not resolve \"zod\"" with deep
 * relative paths — leaves the user staring at noise. This maps that exact case
 * to a one-line instruction, while preserving the original detail for any other
 * bundle failure (a genuine bad import, a syntax error).
 *
 * The other cause has to be separated from it, because the "no node_modules"
 * probe below cannot tell the two apart: when the project DIRECTORY itself
 * can't be listed, esbuild fails to resolve even the entry point
 *
 *   error: Cannot read directory "../../../../../Users/me/agents/x": permission denied
 *   error: Could not resolve "/Users/me/agents/x/index.ts"
 *
 * and `existsSync(<dir>/node_modules)` answers false for the same reason — so
 * the user was told to run `npm install` in a directory nothing can read.
 * Listing the directory first names the real cause.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Why `sourceDir` couldn't be listed, in the user's terms, or null if it can. */
function directoryReadFailure(sourceDir: string): string | null {
  try {
    readdirSync(sourceDir);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `${sourceDir} no longer exists`;
    if (code === "ENOTDIR") return `${sourceDir} is not a directory`;
    if (code === "EACCES" || code === "EPERM") {
      return (
        `${sourceDir} can't be read (permission denied). Grant this app access to that ` +
        `folder, or move the agent somewhere it can read`
      );
    }
    return `${sourceDir} can't be read (${code ?? "unknown error"})`;
  }
}

/**
 * Describe an esbuild bundle failure for `sourceDir`. Names an unreadable
 * project directory when that is the real cause; otherwise, when the project
 * has no `node_modules` and esbuild reported an unresolved import, returns an
 * actionable "run npm install" hint (with the raw detail appended). Any other
 * failure's message is returned unchanged.
 */
export function describeBundleFailure(sourceDir: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  const unreadable = directoryReadFailure(sourceDir);
  if (unreadable) return `${unreadable}. (esbuild: ${raw})`;

  const nodeModules = path.join(sourceDir, "node_modules");
  if (!existsSync(nodeModules) && /Could not resolve/.test(raw)) {
    return (
      `Dependencies are not installed. Run \`npm install\` in ${sourceDir}, then try again. ` +
      `(esbuild: ${raw})`
    );
  }
  return raw;
}
