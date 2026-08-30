/**
 * The name to give a server-side agent the deploy route has to create for a
 * project that was never linked (a gallery-template clone).
 *
 * The honest answer is the agent's own `defineAgent({ name })`, which the
 * canvas extraction already surfaces as `graph.manifestName` — and which the
 * registry stores as `definitionSlug` and `sapiom.json` caches as `name`. Read
 * through the fingerprint cache (core/canvas-cache.ts), so this is normally
 * free: the canvas renders on bind, so the extraction is already warm.
 *
 * Never throws and never blocks a deploy: any failure (no `node_modules` yet,
 * a bundle error, the check process timing out) comes back as null and the
 * caller falls back to a weaker name source.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { extractWorkflowGraphCached } from "./canvas-cache.js";
import { listSourceFiles } from "./canvas-interconnections.js";

export type ManifestNameInspection =
  | { status: "found"; name: string }
  | { status: "absent" }
  /** `retryable`: the same unchanged source could still name this agent. */
  | { status: "failed"; retryable: boolean };

/**
 * The one extraction failure a later projection of the SAME unchanged source
 * can still clear: there is TypeScript to extract from, but nothing installed
 * to run the extraction with. Failures are deliberately not cached
 * (core/canvas-cache.ts), so re-running after an install succeeds — but the
 * graph watcher only reacts to `.ts`/`.tsx` outside ignored directories, so
 * `node_modules` landing fires nothing. Callers must keep offering a retry.
 *
 * A project with no TypeScript at all is NOT this case: no install can produce
 * a `defineAgent` that was never written.
 */
async function installCouldStillName(projectDir: string): Promise<boolean> {
  let sources: string[];
  try {
    sources = await listSourceFiles(projectDir);
  } catch {
    return false;
  }
  if (sources.length === 0) return false;
  try {
    await fs.access(path.join(projectDir, "node_modules"));
    return false;
  } catch {
    return true;
  }
}

/**
 * Inspect the declared manifest name while preserving the difference between
 * a valid unnamed agent and an extraction failure. Inventory uses the richer
 * result to avoid warning for the normal unnamed case, and `retryable` to
 * decide whether the failure can still be cleared without a source edit.
 */
export async function inspectManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
): Promise<ManifestNameInspection> {
  try {
    const { result } = await extract(projectDir);
    if (!result.ok) {
      return { status: "failed", retryable: await installCouldStillName(projectDir) };
    }
    const name = result.graph.manifestName.trim();
    return name === "" ? { status: "absent" } : { status: "found", name };
  } catch {
    // The extractor itself misbehaved; we learned nothing about why. Assume
    // recoverable so the caller keeps its retry affordance.
    return { status: "failed", retryable: true };
  }
}

export async function resolveManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
): Promise<string | null> {
  const inspected = await inspectManifestName(projectDir, extract);
  return inspected.status === "found" ? inspected.name : null;
}
