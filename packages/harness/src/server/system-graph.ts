import { Router } from "express";

import type { WorkspaceScopeResolver } from "../core/system-graph.js";
import type { SystemGraphStore } from "../core/system-graph-store.js";

export interface SystemGraphRouterOptions {
  scopeResolver: WorkspaceScopeResolver;
  store: SystemGraphStore;
}

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createSystemGraphRouter(
  options: SystemGraphRouterOptions,
): Router {
  const router = Router();

  router.get(
    "/workspaces/:workspaceKey/system-graph",
    async (req, res, next) => {
      const scope = options.scopeResolver.resolve(req.params.workspaceKey);
      if (!scope) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      try {
        res.json(await options.store.get(scope));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
