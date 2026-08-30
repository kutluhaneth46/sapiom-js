/**
 * Where `@sapiom/agent-core`'s bundled starter templates live on disk.
 *
 * One resolver, because there are now two callers that scaffold a real project
 * — the demo seed (`core/example-seed.ts`) and `POST /api/agents/scaffold` —
 * and both need the same two corrections. `scaffold()` takes `templatesDir`
 * explicitly when its caller is ESM (there is no `__dirname` to resolve the
 * bundled `templates/` from), and the packaged app needs the asar translation:
 * `scaffold` COPIES the template with `cpSync`, which cannot `opendir` inside
 * `app.asar` (ENOTDIR) no matter what Electron patches.
 */
import { createRequire } from "node:module";
import * as path from "node:path";

import { unpackedPath } from "./asar-path.js";

const nodeRequire = createRequire(import.meta.url);

export function agentCoreTemplatesDir(): string {
  const entry = nodeRequire.resolve("@sapiom/agent-core");
  return unpackedPath(path.resolve(path.dirname(entry), "..", "..", "templates"));
}
