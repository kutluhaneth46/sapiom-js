/**
 * Unit tests for describeBundleFailure — the mapping that turns esbuild's raw
 * "Could not resolve …" (by far the most common cause: a project whose deps
 * were never installed) into a one-line "run npm install" instruction, while
 * leaving every other bundle failure's message untouched.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeBundleFailure } from "./bundle-error";

/** Permission bits don't deny root, so the unreadable-directory case can only
 *  be staged as an unprivileged user (and not on Windows at all). */
const canDenyReads =
  process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;

describe("describeBundleFailure", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bundle-error-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps an unresolved import in a project with no node_modules to a run-npm-install hint", () => {
    const esbuildErr = new Error(
      "Build failed with 2 errors:\n" +
        'index.ts:1:31: ERROR: Could not resolve "@sapiom/agent"\n' +
        'index.ts:2:18: ERROR: Could not resolve "zod"',
    );

    const hint = describeBundleFailure(dir, esbuildErr);

    // Actionable instruction naming the directory the user must install in.
    expect(hint).toContain("Dependencies are not installed");
    expect(hint).toContain("npm install");
    expect(hint).toContain(dir);
    // Raw esbuild detail is preserved for anyone who needs it.
    expect(hint).toContain('Could not resolve "@sapiom/agent"');
  });

  it("leaves the raw message untouched when node_modules exists (a genuine bad import)", () => {
    mkdirSync(path.join(dir, "node_modules"));
    const esbuildErr = new Error(
      'index.ts:1:31: ERROR: Could not resolve "not-a-real-pkg"',
    );

    const hint = describeBundleFailure(dir, esbuildErr);

    // Deps are installed, so this is a real unresolved import — don't misdirect
    // the user to `npm install`.
    expect(hint).not.toContain("Dependencies are not installed");
    expect(hint).toBe(
      'index.ts:1:31: ERROR: Could not resolve "not-a-real-pkg"',
    );
  });

  it("leaves a non-resolution failure (syntax error) untouched even without node_modules", () => {
    const esbuildErr = new Error(
      'index.ts:3:5: ERROR: Expected ";" but found "const"',
    );

    const hint = describeBundleFailure(dir, esbuildErr);

    expect(hint).not.toContain("Dependencies are not installed");
    expect(hint).toBe('index.ts:3:5: ERROR: Expected ";" but found "const"');
  });

  (canDenyReads ? it : it.skip)(
    "names an unreadable project directory instead of blaming dependencies",
    () => {
      // esbuild reports exactly this pair when it can't list the project: the
      // entry point itself becomes unresolvable. `node_modules` is present, but
      // unreadable — the shape that made the old probe answer "not installed".
      mkdirSync(path.join(dir, "node_modules"));
      const project = path.join(dir, "agent");
      mkdirSync(project);
      writeFileSync(path.join(project, "index.ts"), "export {};");
      chmodSync(project, 0o111); // traversable, not listable
      const esbuildErr = new Error(
        "Build failed with 2 errors:\n" +
          `error: Cannot read directory "../../${path.basename(dir)}/agent": permission denied\n` +
          `error: Could not resolve "${path.join(project, "index.ts")}"`,
      );

      try {
        const hint = describeBundleFailure(project, esbuildErr);

        expect(hint).not.toContain("Dependencies are not installed");
        expect(hint).toContain(project);
        expect(hint).toContain("permission denied");
        // Raw esbuild detail still available for anyone debugging.
        expect(hint).toContain("Cannot read directory");
      } finally {
        chmodSync(project, 0o755);
      }
    },
  );

  it("names a project directory that no longer exists", () => {
    const gone = path.join(dir, "moved-away");

    const hint = describeBundleFailure(
      gone,
      new Error('error: Could not resolve "@sapiom/agent"'),
    );

    expect(hint).not.toContain("Dependencies are not installed");
    expect(hint).toContain(`${gone} no longer exists`);
  });

  it("stringifies a non-Error thrown value", () => {
    expect(describeBundleFailure(dir, "boom")).toBe("boom");
  });
});
