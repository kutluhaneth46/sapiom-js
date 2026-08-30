/**
 * `POST /api/agents/scaffold` — the harness creates the agent (SAP-2981;
 * design.md § E4).
 *
 * THE HARNESS CREATES THE AGENT. Every create door in the Studio used to end in
 * an English sentence injected into a terminal — "call the
 * sapiom_dev_agents_scaffold tool with {…}" — and the error copy admitted it
 * ("Ask the coding agent to call sapiom_dev_agents_scaffold"). A creation
 * mechanism that is a prompt has no outcome the app can read: a failed scaffold
 * surfaces as a confused model rather than an error, and "did it work?" is
 * answered by reading a terminal. This route is the outcome, so the dialog can
 * report a refusal and the rail can show the agent before any chat starts.
 *
 * It runs the SAME routine the MCP tool runs (`scaffold` from
 * `@sapiom/agent-core`, injected), so the two creation paths cannot drift into
 * producing different projects.
 *
 * REFUSES ON ITS OWN FINDINGS, like `POST /api/agents/move` beside it — the
 * closest existing precedent for a harness-owned filesystem mutation, and the
 * shape this route copies deliberately:
 *
 *   - `name` must be ONE plain directory segment (`childPath`), so `../evil`,
 *     `a/b`, "" and `.` are refused here rather than only being disabled in a
 *     dialog. The co-located test posts them directly, dialog bypassed.
 *   - `template` must be a plain segment too. `resolveTemplate` joins it onto
 *     the bundled templates dir, so an unguarded `../../..` would name any
 *     directory on the machine as the thing to copy.
 *   - `root` is matched against the directories the RAIL CAN SHOW and the
 *     match from THAT LIST is what the scaffold writes into — the request's
 *     spelling is discarded. A folder the studio has never been pointed at is
 *     not a folder this route creates projects in, so the endpoint cannot be
 *     turned into an arbitrary-path mkdir by a caller that never opened the
 *     rail. No request string reaches `fs`, which is a barrier a static
 *     analyzer can see and a reordered `if` cannot undo.
 *   - the destination is STAT'd. A name already taken in that project is a
 *     refusal, whether the thing sitting there is a registered agent or a
 *     plain directory the registry knows nothing about — only a real `lstat`
 *     answers the second one.
 *
 * AND IT LEAVES NOTHING BEHIND. `scaffold` makes the directory before it copies
 * into it, so a template failure mid-copy would otherwise leave a half-created
 * agent on disk — worse than a refusal, because the retry then fails on "name
 * already exists" and the user has to clean up a folder they never made. A
 * failed scaffold removes the directory this route created.
 *
 * Mounted under the same `/api` boot-token middleware as the rest of the REST
 * surface (server/index.ts).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";

import { refuseAgentName } from "../shared/agent-name.js";
import type { AgentScaffoldResponse } from "../shared/types.js";
import { childPath, hasTraversalSegment } from "../core/path-safety.js";


export interface AgentScaffoldDeps {
  /**
   * Every directory an agent may be created IN: the project roots the studio
   * knows about, plus the branching directories the Project axis renders
   * between a root and an agent. Same list `agent-move.ts` moves into
   * (`moveTargetDirs`), and for the same reason — "a directory the rail can
   * show" and "a directory this route will write into" must be one list, or
   * creation and drag disagree about what a project is.
   */
  listProjectDirs: () => string[] | Promise<string[]>;
  /**
   * The registered agent at this absolute path, or null. Consulted before the
   * `lstat` purely so the refusal can NAME what is in the way ("an agent
   * called x") instead of describing a directory.
   */
  resolveAgent: (agentPath: string) => { name: string; path: string } | null;
  /**
   * Creates the project. Injected so the co-located test can exercise every
   * guard without npm, git, or the registry on the far side of them — and so
   * the route stays the thing under test rather than `@sapiom/agent-core`.
   */
  scaffoldAgent: (opts: {
    targetDir: string;
    template: string;
  }) => Promise<{ dependenciesInstalled: boolean }>;
  /**
   * Applied AFTER the project is on disk, BEFORE the response. The
   * integrator's job: rescan the project root so the registry holds the new
   * agent and `workflows.changed` is broadcast. It runs before the response
   * because that ordering IS the criterion — the agent is in the rail before
   * the caller can open a session on it, so "did it work?" is never a question
   * the user answers by reading a terminal.
   */
  onScaffolded: (agentDir: string) => Promise<void>;
}

/**
 * A template name that is safe to hand to `resolveTemplate`, which joins it
 * onto the bundled templates directory. Plain segment, no separators, no dots:
 * a bundled template is a directory name in a package we ship, and nothing
 * legitimate needs more than this alphabet.
 */
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Two paths naming one directory — trailing separators and (on Windows) case
 * are spelling, not identity. Same rule `agent-move.ts` and `studio-rail.ts`
 * apply to their roots, and for the same reason: the client stores whichever
 * form the user typed while the server stores whatever it resolved.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * The route's OWN refusal, from the filesystem rather than from the registry —
 * a message when the directory must not be created, null when it may.
 *
 * `lstat`, not `stat`: a dangling symlink sitting at the destination is still
 * something the user put there, and `scaffold` would happily create through it.
 */
export async function refuseScaffoldOnDisk(
  target: string,
  projectLabel: string,
): Promise<string | null> {
  const name = path.basename(target);
  try {
    await fs.lstat(target);
    return `${projectLabel} already contains ${name}.`;
  } catch {
    // Absent — the only acceptable state for a destination.
  }
  return null;
}

/**
 * POST /api/agents/scaffold  { root, name, template? } -> AgentScaffoldResponse
 *
 * 400 — a malformed body, a name that is not one folder segment, a template
 * that is not a plain segment, a root that is not an absolute path.
 * 409 — a refusal, with the reason in `error` so the dialog shows it verbatim:
 * a root the studio doesn't show as a project, or a name already taken there.
 * 500 — the scaffold itself failed; the directory it may have created is
 * removed first, so the retry meets the same clean state the first attempt did.
 */
export function createAgentScaffoldRouter(
  deps: AgentScaffoldDeps,
): ExpressRouter {
  const router = Router();

  router.post("/api/agents/scaffold", async (req, res, next) => {
    const body = (req.body ?? {}) as {
      root?: unknown;
      name?: unknown;
      template?: unknown;
    };
    const { root, name } = body;
    const template = body.template ?? "default";

    if (typeof root !== "string" || !path.isAbsolute(root) || hasTraversalSegment(root)) {
      res.status(400).json({ error: "root must be an absolute path" });
      return;
    }
    const nameRefusal = refuseAgentName(name);
    if (nameRefusal != null) {
      res.status(400).json({ error: nameRefusal });
      return;
    }
    if (typeof template !== "string" || !TEMPLATE_NAME.test(template)) {
      res.status(400).json({ error: `Unknown template '${String(template)}'.` });
      return;
    }

    try {
      // THE DESTINATION BARRIER, identical in shape to the move route's: the
      // requested root is matched against the directories the rail can show,
      // and the DIRECTORY FROM THAT LIST is what the scaffold writes into.
      const requested = path.resolve(root);
      const projectDir = (await deps.listProjectDirs()).find(
        (dir) =>
          typeof dir === "string" && dir.trim() !== "" && samePath(dir, requested),
      );
      if (projectDir == null) {
        res.status(409).json({
          error: `Can't create an agent in ${requested} — Studio doesn't show that folder as a project.`,
        });
        return;
      }
      const projectLabel = path.basename(path.resolve(projectDir)) || projectDir;
      // `path.resolve` on the LIST's entry, not the request's, and `childPath`
      // re-derives the join it already blessed above: the guard that produces
      // the path is the guard that proved it, so no later edit can separate
      // them.
      const target = childPath(path.resolve(projectDir), name as string);
      if (target == null) {
        res.status(400).json({ error: `'${String(name)}' isn't a folder name.` });
        return;
      }

      const existing = deps.resolveAgent(target);
      if (existing != null) {
        res.status(409).json({
          error: `${projectLabel} already has an agent called ${existing.name}.`,
        });
        return;
      }
      const diskRefusal = await refuseScaffoldOnDisk(target, projectLabel);
      if (diskRefusal != null) {
        res.status(409).json({ error: diskRefusal });
        return;
      }

      let result: { dependenciesInstalled: boolean };
      try {
        result = await deps.scaffoldAgent({ targetDir: target, template });
      } catch (err) {
        // NOTHING HALF-CREATED. Everything above proved the destination was
        // absent, so whatever is there now is this attempt's own wreckage.
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        res.status(500).json({
          error: (err as Error).message || `Couldn't create ${String(name)}.`,
        });
        return;
      }

      // Before the response, deliberately: the agent is in the rail by the time
      // the caller can act on the result.
      await deps.onScaffolded(target);
      res.json({
        ok: true,
        path: target,
        name: path.basename(target),
        template,
        dependenciesInstalled: result.dependenciesInstalled,
      } satisfies AgentScaffoldResponse);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
