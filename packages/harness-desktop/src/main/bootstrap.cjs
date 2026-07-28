/**
 * CommonJS entry point that hands off to the real ESM main.
 *
 * Electron's ESM support is real but its *entry point* handling on Windows is
 * not: an ESM main died with exit 3 (Node's "Internal JavaScript Parse Failure")
 * before Electron initialised logging, so nothing was printed on any channel —
 * not stdout, not stderr, not redirected to a file, not a crash dump. Unpacking
 * asar was necessary but not sufficient; the entry itself is the problem.
 *
 * A `.cjs` file is CommonJS regardless of the package's `"type": "module"`, so
 * Electron loads this synchronously the way it has always loaded main scripts,
 * and CJS can `import()` ESM. Everything after this line is unchanged.
 *
 * The catch matters as much as the handoff: a failure here used to be a bare exit
 * code. Now it lands in a file (and stderr), so the next failure is readable
 * instead of silent.
 */
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

import("./index.js").catch((err) => {
  const detail = err && err.stack ? err.stack : String(err);
  // SAPIOM_SMOKE_OUT is where --smoke already writes its report, so CI picks this
  // up in the same place; otherwise fall back to the temp dir.
  const target = process.env.SAPIOM_SMOKE_OUT
    ? `${process.env.SAPIOM_SMOKE_OUT}.boot-error.txt`
    : join(tmpdir(), "sapiom-boot-error.txt");
  try {
    writeFileSync(target, `failed to load the ESM main entry:\n${detail}\n`);
  } catch {
    /* nothing better to do — the console.error below is the last resort */
  }
  console.error("[bootstrap] failed to load ./index.js:", detail);
  process.exit(1);
});
