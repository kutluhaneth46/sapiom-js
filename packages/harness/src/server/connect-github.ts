/**
 * POST /api/connect/github — clone a public or private GitHub repository using
 * the user's local git credentials, then register the cloned directory in the
 * workflow registry so it appears in the Workspace rail.
 *
 * Relies entirely on the USER's local git credential store (the same one
 * `git clone` uses from the terminal) — no Sapiom token or GitHub token is
 * minted or required. Public repos work with no credentials; private repos
 * work when the user has SSH keys or a credential helper configured.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";

import type { WorkflowRegistryLike } from "../core/workflow-registry.js";
import type { WorkflowInfo } from "../shared/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// URL validation — kept in sync with the client-side parseGitHubRepoUrl.
// ---------------------------------------------------------------------------

const HTTPS_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/;
const SSH_RE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Normalised clone URL (HTTPS). Used for validation/display, NOT necessarily
   *  what we pass to git — we pass the original so SSH URLs use SSH transport. */
  cloneUrl: string;
}

function parseGitHubUrl(raw: string): ParsedGitHubUrl | null {
  const trimmed = raw.trim();
  let owner: string | undefined;
  let repo: string | undefined;

  const httpsMatch = HTTPS_RE.exec(trimmed);
  if (httpsMatch) {
    owner = httpsMatch[1];
    repo = httpsMatch[2];
  } else {
    const sshMatch = SSH_RE.exec(trimmed);
    if (sshMatch) {
      owner = sshMatch[1];
      repo = sshMatch[2];
    }
  }

  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Redact any credential-bearing URL fragment from git output before surfacing
 * it as an error message. Matches the pattern in agent-core/src/git.ts.
 */
function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
}

export interface ConnectGitHubRouterOptions {
  /** Live workflow registry — the cloned dir is registered via connectPath(). */
  registry: WorkflowRegistryLike;
  /**
   * Absolute path to the default parent directory for new clones when the
   * caller does not provide a targetDir. Defaults to `~/sapiom` when omitted.
   */
  defaultCloneParent?: string;
}

/**
 * Run `git clone <repoUrl> <targetDir>` using the user's local git (and
 * credential store). Returns the absolute target directory on success, throws
 * with a user-readable message on failure.
 *
 * Exported for unit testing (the route handler calls this after validation).
 */
export async function gitClone(repoUrl: string, targetDir: string): Promise<void> {
  try {
    // `--` terminates option parsing: a repoUrl/targetDir starting with `-`
    // cannot be misread as a flag (argv-injection hardening mirrors agent-core).
    await execFileAsync("git", ["clone", "--", repoUrl, targetDir], {
      // Run from the user's home directory so relative paths in git config
      // (includeIf, etc.) resolve correctly.
      cwd: os.homedir(),
      // Capture stderr for diagnostics; stdout is not needed for a clone.
      encoding: "utf8",
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const raw = stderr.trim() || (err instanceof Error ? err.message : String(err));
    throw new Error(redactCredentials(raw));
  }
}

export function createConnectGitHubRouter(options: ConnectGitHubRouterOptions): ExpressRouter {
  const { registry, defaultCloneParent } = options;
  const router = Router();

  /**
   * POST /api/connect/github
   *
   * Body: { repoUrl: string; targetDir?: string }
   *   repoUrl   — HTTPS or SSH GitHub URL
   *   targetDir — absolute path for the clone (optional; derived from repo
   *               name under the defaultCloneParent when absent)
   *
   * Success: 200 { path: string } — the absolute path of the cloned directory,
   *   already registered in the workflow registry.
   *
   * Errors:
   *   400 { error }  — invalid URL or dir already exists / non-empty
   *   500 { error }  — git clone failed
   */
  router.post("/api/connect/github", async (req, res) => {
    const body = req.body as { repoUrl?: unknown; targetDir?: unknown } | undefined;
    const rawUrl = typeof body?.repoUrl === "string" ? body.repoUrl.trim() : "";
    const rawTarget = typeof body?.targetDir === "string" ? body.targetDir.trim() : "";

    // --- Validate URL ---
    if (!rawUrl) {
      res.status(400).json({ error: "repoUrl is required" });
      return;
    }
    const parsed = parseGitHubUrl(rawUrl);
    if (!parsed) {
      res.status(400).json({
        error:
          "Invalid GitHub URL. Accepted forms: https://github.com/owner/repo or git@github.com:owner/repo.git",
      });
      return;
    }

    // --- Resolve targetDir ---
    const parent = defaultCloneParent ?? path.join(os.homedir(), "sapiom");
    const targetDir = rawTarget
      ? path.resolve(rawTarget)
      : path.join(parent, parsed.repo);

    // Ensure the parent directory exists before checking for collisions.
    try {
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
    } catch {
      // Best-effort: if mkdir fails, the clone itself will surface the error.
    }

    // Reject if targetDir already exists and is non-empty (git clone would fail
    // anyway, but we give a clearer message here).
    try {
      const entries = await fs.readdir(targetDir);
      if (entries.length > 0) {
        res.status(400).json({
          error: `Directory already exists and is not empty: ${targetDir}`,
        });
        return;
      }
    } catch (err) {
      // ENOENT = does not exist yet; that is exactly what we want. Any other
      // error (ENOTDIR, EACCES) is surfaced to the caller.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        res.status(400).json({ error: `Cannot access target directory: ${(err as Error).message}` });
        return;
      }
    }

    // --- Clone ---
    // Use the original URL so SSH transport (git@...) uses the user's SSH key.
    try {
      await gitClone(rawUrl, targetDir);
    } catch (err) {
      res.status(500).json({ error: `git clone failed: ${(err as Error).message}` });
      return;
    }

    // --- Register ---
    // connectPath() mirrors what POST /api/workflows/connect does for local dirs.
    let info: WorkflowInfo;
    try {
      info = await registry.connectPath(targetDir);
    } catch (err) {
      // Clone succeeded but registration failed — surface the path so the user
      // can manually connect it. Not a fatal error.
      res.status(500).json({
        error: `Cloned to ${targetDir} but could not register: ${(err as Error).message}`,
      });
      return;
    }

    res.json({ path: info.path });
  });

  return router;
}
