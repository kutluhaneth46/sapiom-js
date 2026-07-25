/**
 * GitHubDeviceConnect — Device Flow UI for connecting to GitHub.
 *
 * Flow:
 *  1. Not connected: primary "Connect GitHub" button → POST /api/github/device/start
 *     → shows user_code + "Open github.com/login/device" link → polls until done.
 *  2. Connected: shows the signed-in login + a searchable repo list.
 *     Pick a repo → clone + connectPath → appears in the Workspace rail.
 *  3. Manual fallback: "…or paste a repo URL" opens the existing form.
 *
 * When SAPIOM_GITHUB_CLIENT_ID is unset the server returns 503 with
 * { error: "notConfigured" }. On that response this component hides the
 * Device Flow UI entirely and renders the URL-paste fallback inline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ConnectGitHubRequest } from "../lib/api";
import { Icon } from "./Icon";

// ---------------------------------------------------------------------------
// Wire types (not shared/types — these are only consumed client-side).
// ---------------------------------------------------------------------------

interface DeviceStartResponse {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

interface PollResult {
  status: "authorized" | "pending" | "slow_down" | "expired" | "denied";
  interval?: number;
}

interface GitHubStatusResponse {
  connected: boolean;
  configured?: boolean;
  login?: string;
}

export interface GitHubRepoEntry {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// API helpers (injected via props so tests can mock them).
// ---------------------------------------------------------------------------

export interface GitHubDeviceApi {
  /** POST /api/github/device/start */
  deviceStart(): Promise<DeviceStartResponse>;
  /** POST /api/github/device/poll */
  devicePoll(deviceCode: string): Promise<PollResult>;
  /** GET /api/github/repos */
  listRepos(): Promise<GitHubRepoEntry[]>;
  /** GET /api/github/status */
  status(): Promise<GitHubStatusResponse>;
  /** POST /api/github/disconnect */
  disconnect(): Promise<void>;
  /** Clone the repo and register it (reuses existing connect-github route). */
  clone(req: ConnectGitHubRequest): Promise<string>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GitHubDeviceConnectProps {
  /** API adapter — production wires RealGitHubDeviceApi; tests inject a stub. */
  api: GitHubDeviceApi;
  /** Parent directory for target-dir default preview (mirrors ConnectGitHubForm). */
  defaultCloneParent?: string;
  /** Called when the URL-paste fallback "Back" button is clicked. */
  onBack: () => void;
  /** Close the whole popover. */
  onClose: () => void;
  /** Called after a successful clone with the new workspace path. */
  onSuccess: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

type View =
  | { kind: "loading" }          // initial status check
  | { kind: "unconfigured" }     // no client ID — show URL-paste fallback hint
  | { kind: "idle" }             // not connected, ready to start
  | { kind: "awaiting"; userCode: string; verificationUri: string; deviceCode: string; intervalSec: number }
  | { kind: "polling" }          // polling after user clicked the link
  | { kind: "error"; message: string }
  | { kind: "connected"; login: string }
  | { kind: "repos"; login: string; repos: GitHubRepoEntry[]; query: string }
  | { kind: "cloning"; repoFullName: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FALLBACK_CLONE_PARENT = "~/sapiom";

export function GitHubDeviceConnect({
  api,
  defaultCloneParent,
  onBack,
  onClose,
  onSuccess,
}: GitHubDeviceConnectProps): JSX.Element {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [cloneError, setCloneError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parent = defaultCloneParent ?? FALLBACK_CLONE_PARENT;

  // Clear any pending poll timer on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
    };
  }, []);

  // On mount: check if already connected (or if the feature is unconfigured).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.status();
        if (cancelled) return;
        if (s.configured === false) {
          setView({ kind: "unconfigured" });
          return;
        }
        if (s.connected && s.login) {
          setView({ kind: "connected", login: s.login });
        } else {
          setView({ kind: "idle" });
        }
      } catch {
        if (!cancelled) setView({ kind: "idle" });
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // ── Start Device Flow ────────────────────────────────────────────────────

  const handleStart = useCallback(async (): Promise<void> => {
    setView({ kind: "loading" });
    try {
      const res = await api.deviceStart();
      // 503 when client ID is not configured — surface the fallback.
      setView({
        kind: "awaiting",
        userCode: res.user_code,
        verificationUri: res.verification_uri,
        deviceCode: res.device_code,
        intervalSec: res.interval ?? 5,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "Failed to start GitHub authorization";
      if (msg.includes("notConfigured") || msg.includes("503")) {
        setView({ kind: "unconfigured" });
      } else {
        setView({ kind: "error", message: msg });
      }
    }
  }, [api]);

  // ── Poll ──────────────────────────────────────────────────────────────────

  const schedulePoll = useCallback(
    (deviceCode: string, intervalSec: number): void => {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const result = await api.devicePoll(deviceCode);
            switch (result.status) {
              case "authorized": {
                // Fetch the login to show in the connected state.
                try {
                  const s = await api.status();
                  setView({ kind: "connected", login: s.login ?? "you" });
                } catch {
                  setView({ kind: "connected", login: "you" });
                }
                break;
              }
              case "pending":
                schedulePoll(deviceCode, intervalSec);
                break;
              case "slow_down":
                schedulePoll(deviceCode, (result.interval ?? intervalSec) + 5);
                break;
              case "expired":
                setView({ kind: "error", message: "The authorization code expired. Please try again." });
                break;
              case "denied":
                setView({ kind: "error", message: "Authorization was denied." });
                break;
            }
          } catch (err) {
            setView({ kind: "error", message: (err as Error).message ?? "Polling failed" });
          }
        })();
      }, intervalSec * 1000);
    },
    [api],
  );

  // Start polling when we enter the "awaiting" state and the user opens the link.
  const handleOpenLink = useCallback(
    (deviceCode: string, intervalSec: number): void => {
      setView((v) =>
        v.kind === "awaiting" ? { ...v, kind: "awaiting" } : v,
      );
      schedulePoll(deviceCode, intervalSec);
    },
    [schedulePoll],
  );

  // ── Load repos ────────────────────────────────────────────────────────────

  const handleLoadRepos = useCallback(
    async (login: string): Promise<void> => {
      setView({ kind: "loading" });
      try {
        const repos = await api.listRepos();
        setView({ kind: "repos", login, repos, query: "" });
      } catch (err) {
        setView({ kind: "error", message: (err as Error).message ?? "Failed to load repos" });
      }
    },
    [api],
  );

  // ── Clone ─────────────────────────────────────────────────────────────────

  const handleClone = useCallback(
    async (repo: GitHubRepoEntry): Promise<void> => {
      setCloneError(null);
      setView({ kind: "cloning", repoFullName: repo.fullName });
      try {
        const repoName = repo.fullName.split("/").pop() ?? "repo";
        const path = await api.clone({
          repoUrl: repo.cloneUrl,
          // targetDir left absent → server derives from repo name under the parent
        });
        onSuccess(path);
      } catch (err) {
        const msg = (err as Error).message ?? "Clone failed";
        // Return to repos list with an error banner.
        setCloneError(msg);
        // Recover: re-fetch repos (login may have changed if token expired).
        try {
          const s = await api.status();
          if (s.connected && s.login) {
            const repos = await api.listRepos();
            setView({ kind: "repos", login: s.login, repos, query: "" });
          } else {
            setView({ kind: "idle" });
          }
        } catch {
          setView({ kind: "idle" });
        }
      }
    },
    [api, onSuccess],
  );

  // ── Disconnect ────────────────────────────────────────────────────────────

  const handleDisconnect = useCallback(async (): Promise<void> => {
    try {
      await api.disconnect();
    } catch {
      // Best-effort
    }
    setView({ kind: "idle" });
  }, [api]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="connect-github-form" data-testid="github-device-connect">
      {/* Header */}
      <div className="connect-card-header">
        <button
          type="button"
          className="theme-toggle connect-card-close"
          onClick={onBack}
          aria-label="Back to menu"
          title="Back"
        >
          <Icon name="ArrowLeft" size={13} />
        </button>
        <span>Connect to GitHub</span>
        <button
          type="button"
          className="theme-toggle connect-card-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <Icon name="X" size={13} />
        </button>
      </div>

      {/* Body */}
      <div className="connect-card-body connect-github-body">
        {view.kind === "loading" && (
          <div className="github-device-loading" data-testid="github-device-loading">
            <Icon name="Loader" size={14} />
            <span>Loading…</span>
          </div>
        )}

        {view.kind === "unconfigured" && (
          <div className="github-device-unconfigured" data-testid="github-device-unconfigured">
            <p className="connect-github-field-hint">
              GitHub connect is not configured — paste a repo URL instead.
            </p>
          </div>
        )}

        {view.kind === "idle" && (
          <>
            <p className="connect-github-field-hint">
              Authorize once to browse and clone your repositories.
            </p>
            <div className="connect-github-actions">
              <button
                type="button"
                className="btn-primary"
                data-testid="github-device-start"
                onClick={() => void handleStart()}
              >
                <Icon name="GitBranch" size={14} />
                Connect GitHub
              </button>
            </div>
          </>
        )}

        {view.kind === "awaiting" && (
          <div className="github-device-awaiting" data-testid="github-device-awaiting">
            <p className="connect-github-label">
              Enter this code on GitHub:
            </p>
            <div className="github-device-code" data-testid="github-device-code">
              {view.userCode}
            </div>
            <a
              href={view.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary github-device-link"
              data-testid="github-device-link"
              onClick={() => handleOpenLink(view.deviceCode, view.intervalSec)}
            >
              <Icon name="ExternalLink" size={14} />
              Open {view.verificationUri}
            </a>
            <p className="connect-github-field-hint github-device-waiting" data-testid="github-device-waiting">
              <Icon name="Loader" size={13} />
              Waiting for authorization…
            </p>
          </div>
        )}

        {view.kind === "polling" && (
          <div className="github-device-awaiting" data-testid="github-device-awaiting">
            <p className="connect-github-field-hint github-device-waiting">
              <Icon name="Loader" size={13} />
              Waiting for authorization…
            </p>
          </div>
        )}

        {view.kind === "error" && (
          <>
            <div className="modal-error" data-testid="github-device-error">
              {view.message}
            </div>
            <div className="connect-github-actions">
              <button
                type="button"
                className="btn-ghost"
                data-testid="github-device-retry"
                onClick={() => void handleStart()}
              >
                Try again
              </button>
            </div>
          </>
        )}

        {view.kind === "connected" && (
          <>
            <div className="github-device-connected" data-testid="github-device-connected">
              <Icon name="Check" size={14} />
              <span>
                Signed in as <strong>{view.login}</strong>
              </span>
            </div>
            <div className="connect-github-actions">
              <button
                type="button"
                className="btn-ghost github-device-disconnect"
                data-testid="github-device-disconnect"
                onClick={() => void handleDisconnect()}
              >
                Disconnect
              </button>
              <button
                type="button"
                className="btn-primary"
                data-testid="github-device-browse"
                onClick={() => void handleLoadRepos(view.login)}
              >
                Browse repos
              </button>
            </div>
          </>
        )}

        {(view.kind === "repos" || view.kind === "cloning") && (
          <RepoList
            login={view.kind === "repos" ? view.login : ""}
            repos={view.kind === "repos" ? view.repos : []}
            query={view.kind === "repos" ? view.query : ""}
            cloning={view.kind === "cloning" ? view.repoFullName : null}
            cloneError={cloneError}
            parent={parent}
            onQueryChange={(q) =>
              setView((v) =>
                v.kind === "repos" ? { ...v, query: q } : v,
              )
            }
            onClone={handleClone}
            onDisconnect={() => void handleDisconnect()}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo list sub-view.
// ---------------------------------------------------------------------------

function RepoList({
  login,
  repos,
  query,
  cloning,
  cloneError,
  parent,
  onQueryChange,
  onClone,
  onDisconnect,
}: {
  login: string;
  repos: GitHubRepoEntry[];
  query: string;
  cloning: string | null;
  cloneError: string | null;
  parent: string;
  onQueryChange: (q: string) => void;
  onClone: (repo: GitHubRepoEntry) => void;
  onDisconnect: () => void;
}): JSX.Element {
  const filtered = repos.filter((r) =>
    r.fullName.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="github-repo-list-wrap" data-testid="github-repo-list">
      {/* Connected status + disconnect link */}
      <div className="github-device-connected-bar">
        <Icon name="Check" size={13} />
        <span className="connect-github-label">{login}</span>
        <button
          type="button"
          className="btn-ghost github-device-disconnect-inline"
          data-testid="github-device-disconnect"
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      </div>

      {/* Search */}
      <div className="connect-github-field">
        <input
          type="text"
          className="modal-input connect-github-input"
          data-testid="github-repo-search"
          placeholder="Search repos…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {cloneError && (
        <div className="modal-error" data-testid="github-clone-error">
          {cloneError}
        </div>
      )}

      {/* List */}
      <div className="github-repo-list" data-testid="github-repo-list-items">
        {filtered.length === 0 ? (
          <p className="connect-github-field-hint">No repositories found.</p>
        ) : (
          filtered.map((repo) => {
            const repoName = repo.fullName.split("/").pop() ?? repo.fullName;
            const isCloning = cloning === repo.fullName;
            return (
              <button
                key={repo.fullName}
                type="button"
                className={"btn-ghost github-repo-item" + (isCloning ? " is-cloning" : "")}
                data-testid={`github-repo-item-${repoName}`}
                disabled={cloning !== null}
                onClick={() => onClone(repo)}
                title={`Clone into ${parent}/${repoName}`}
              >
                <span className="github-repo-item-name">
                  {repo.private && <Icon name="Settings" size={12} />}
                  <span>{repo.fullName}</span>
                </span>
                {isCloning && (
                  <span className="github-repo-cloning-hint">
                    <Icon name="Loader" size={12} />
                    Cloning…
                  </span>
                )}
                {repo.description && (
                  <span className="github-repo-item-desc">{repo.description}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
