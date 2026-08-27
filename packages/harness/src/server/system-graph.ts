import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import type {
  WorkspaceScope,
  WorkspaceScopeResolver,
} from "../core/system-graph.js";
import type { SystemGraphStore } from "../core/system-graph-store.js";
import {
  SYSTEM_GRAPH_CACHE_HEADER,
  type SystemGraphCacheStatus,
  type SystemGraphSnapshot,
} from "../shared/system-graph.js";

export interface SystemGraphRouterOptions {
  scopeResolver: WorkspaceScopeResolver;
  store: SystemGraphStore;
  onScopeAccess?: (scope: WorkspaceScope) => void | Promise<void>;
  /** Re-run registry prerequisites before an explicit user retry. */
  onScopeRefresh?: (
    scope: WorkspaceScope,
  ) => SystemGraphSnapshot | Promise<SystemGraphSnapshot>;
}

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createSystemGraphRouter(
  options: SystemGraphRouterOptions,
): Router {
  const router = Router();
  const route = "/workspaces/:workspaceKey/system-graph";

  const serve = async (
    req: Request,
    res: Response,
    next: NextFunction,
    refresh: boolean,
  ): Promise<void> => {
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
      const snapshot = refresh
        ? await (options.onScopeRefresh?.(scope) ??
            options.store.refresh(scope))
        : await options.store.get(scope);
      const cacheStatus: SystemGraphCacheStatus =
        snapshot.state === "ready" ? "complete" : "degraded";
      res.set(SYSTEM_GRAPH_CACHE_HEADER, cacheStatus).json(snapshot);
    } catch (err) {
      next(err);
    }
  };

  router.get(route, (req, res, next) => {
    void serve(req, res, next, false);
  });
  router.post(`${route}/refresh`, (req, res, next) => {
    void serve(req, res, next, true);
  });

  return router;
}
