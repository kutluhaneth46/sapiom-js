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
import {
  extractWorkflowGraphCached,
  type CachedExtractionOptions,
} from "./canvas-cache.js";

export type ManifestNameInspection =
  | { status: "found"; name: string }
  | { status: "absent" | "failed" };

export type ManifestNameInspectionOptions = CachedExtractionOptions;

/**
 * Inspect the declared manifest name while preserving the difference between
 * a valid unnamed agent and an extraction failure. Inventory uses the richer
 * result to avoid warning for the normal unnamed case.
 */
export async function inspectManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
  options: ManifestNameInspectionOptions = {},
): Promise<ManifestNameInspection> {
  try {
    const { result } =
      options.authorizeBeforeLaunch || options.beforeLaunchAuthorization
        ? await extract(projectDir, undefined, options)
        : await extract(projectDir);
    if (!result.ok) {
      return {
        status: result.code === "NO_DEFINITION" ? "absent" : "failed",
      };
    }
    const name = result.graph.manifestName.trim();
    return name === "" ? { status: "absent" } : { status: "found", name };
  } catch {
    return { status: "failed" };
  }
}

export async function resolveManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
): Promise<string | null> {
  const inspected = await inspectManifestName(projectDir, extract);
  return inspected.status === "found" ? inspected.name : null;
}
