import { Router } from "express";

import type {
  WorkspaceScope,
  WorkspaceScopeResolver,
} from "../core/system-graph.js";
import type { SystemGraphStore } from "../core/system-graph-store.js";
import {
  SYSTEM_GRAPH_CACHE_HEADER,
  type SystemGraphCacheStatus,
} from "../shared/system-graph.js";

export interface SystemGraphRouterOptions {
  scopeResolver: WorkspaceScopeResolver;
  store: SystemGraphStore;
  onScopeAccess?: (scope: WorkspaceScope) => void | Promise<void>;
}

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createSystemGraphRouter(
  options: SystemGraphRouterOptions,
): Router {
  const router = Router();

  router.get(
    "/workspaces/:workspaceKey/system-graph",
    async (req, res, next) => {
      try {
        const scope = await options.scopeResolver.resolve(
          req.params.workspaceKey,
        );
        if (!scope) {
          res.status(404).json({ error: "Workspace not found" });
          return;
        }
        try {
          await options.onScopeAccess?.(scope);
        } catch {
          // Watcher setup is best-effort. A graph read must remain available
          // even when automatic freshness cannot be armed.
        }
        const snapshot = await options.store.get(scope);
        const cacheStatus: SystemGraphCacheStatus =
          snapshot.state === "ready" ? "complete" : "degraded";
        res.set(SYSTEM_GRAPH_CACHE_HEADER, cacheStatus).json(snapshot);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
