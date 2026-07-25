/**
 * Default action-rail macros. Pure data — no execution wiring. The server
 * resolves `{{...}}` placeholders (see MacroDef in shared/types.ts) and
 * either injects the text into the session pty or opens the URL. Matches the
 * SPA's MOCK_MACROS fixture (web/src/lib/mock-data.ts) so mock and real mode
 * present the same action rail.
 */
import type { MacroDef } from "../shared/types.js";

export const DEFAULT_MACROS: MacroDef[] = [
  {
    id: "open_prod",
    label: "Open prod",
    icon: "ExternalLink",
    requiresWorkflow: true,
    action: {
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    },
  },
  {
    // One-click refresh of the bound workflow's canvas: drops the extraction
    // cache and re-runs the fully deterministic render (core/canvas-render.ts
    // — structure + derived annotations, no LLM, no user token), all
    // server-side without touching the session's pty. A cheap no-op when the
    // session is unbound.
    id: "visualize",
    label: "Visualize",
    icon: "Sparkles",
    requiresWorkflow: false,
    action: { kind: "render-canvas" },
  },
];
