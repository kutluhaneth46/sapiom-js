// Copies the setup window's static assets into dist/renderer.
// tsc emits only setup.js from src/renderer; the .html/.css must be copied.
// We ALSO copy the harness's shared design-system CSS (theme-tokens + button
// primitives) so the onboarding window uses the exact same tokens/components as
// the SPA — single source of truth, no duplicated theme values.
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src", "renderer");
const outDir = join(root, "dist", "renderer");

// The harness ships the shared CSS in its web/src; resolve its package root so
// this works from the workspace build (where these files live).
const harnessStylesDir = join(dirname(require.resolve("@sapiom/harness/package.json")), "web", "src");

await mkdir(outDir, { recursive: true });
for (const file of ["setup.html", "setup.css"]) {
  await cp(join(srcDir, file), join(outDir, file));
}
for (const file of ["theme-tokens.css", "primitives.css"]) {
  await cp(join(harnessStylesDir, file), join(outDir, file));
}
console.log("copied renderer assets (+ shared harness CSS) → dist/renderer");
