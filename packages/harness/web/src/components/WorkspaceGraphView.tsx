import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  SystemGraphLifecycleState,
  SystemGraphNavigationResponse,
  SystemGraphSnapshot,
  WorkspaceKey,
} from "@shared/system-graph";

import type { HarnessApi } from "../lib/api";
import { systemGraphLoader } from "../lib/system-graph-loader";
import type { SystemGraphAnnouncement } from "../lib/system-graph-announcements";
import {
  resolveSystemGraphNavigationForRevision,
  systemGraphNavigationForSnapshot,
} from "../lib/system-graph-navigation";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SystemGraphCanvas } from "./SystemGraphCanvas";

interface WorkspaceGraphViewProps {
  workspaceKey: WorkspaceKey;
  workspaceName: string;
  api: HarnessApi;
  latestAnnouncement: SystemGraphAnnouncement | null;
  onOpenAgent: (path: string) => void;
  onExpandRail?: () => void;
}

export function workspaceGraphNavigationIsCurrent(input: {
  snapshotRevision: number | null;
  snapshotState: SystemGraphLifecycleState | null;
  announcementRevision: number | null;
  incomingRevision?: number | null;
  loading: boolean;
  error: boolean;
}): boolean {
  const newestAnnouncement = Math.max(
    input.announcementRevision ?? -1,
    input.incomingRevision ?? -1,
  );
  return (
    !input.loading &&
    !input.error &&
    input.snapshotRevision !== null &&
    (input.snapshotState === "ready" || input.snapshotState === "degraded") &&
    newestAnnouncement <= input.snapshotRevision
  );
}

export function WorkspaceGraphView({
  workspaceKey,
  workspaceName,
  api,
  latestAnnouncement,
  onOpenAgent,
  onExpandRail,
}: WorkspaceGraphViewProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<SystemGraphSnapshot | null>(() =>
    systemGraphLoader.peek(workspaceKey),
  );
  const [announcement, setAnnouncement] = useState<{
    revision: number;
    state: SystemGraphLifecycleState;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [navigationResponse, setNavigationResponse] =
    useState<SystemGraphNavigationResponse | null>(null);
  const incomingAnnouncement =
    latestAnnouncement?.workspaceKey === workspaceKey
      ? latestAnnouncement
      : null;
  const effectiveAnnouncement =
    incomingAnnouncement &&
    incomingAnnouncement.revision > (announcement?.revision ?? -1)
      ? incomingAnnouncement
      : announcement;
  const navigationIsCurrent = workspaceGraphNavigationIsCurrent({
    snapshotRevision: snapshot?.revision ?? null,
    snapshotState: snapshot?.state ?? null,
    announcementRevision: announcement?.revision ?? null,
    incomingRevision: incomingAnnouncement?.revision ?? null,
    loading,
    error,
  });

  useEffect(() => {
    let active = true;
    setError(false);
    setLoading(true);
    setNavigationResponse(null);
    void systemGraphLoader.load(api, workspaceKey).then(
      (next) => {
        if (!active) return;
        setSnapshot((current) =>
          current && current.revision > next.revision ? current : next,
        );
        setAnnouncement((current) =>
          current && current.revision > next.revision ? current : null,
        );
        setLoading(false);
      },
      () => {
        if (!active) return;
        setError(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, workspaceKey, refreshSeq]);

  useEffect(() => {
    if (!snapshot?.graph || !navigationIsCurrent) {
      setNavigationResponse(null);
      return;
    }
    const revision = snapshot.revision;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      const resolution = await resolveSystemGraphNavigationForRevision(
        api,
        workspaceKey,
        revision,
        controller.signal,
      );
      if (!active) return;
      if (resolution.kind === "matched") {
        setNavigationResponse(resolution.response);
        return;
      }
      if (resolution.kind === "graph-behind") {
        setNavigationResponse(null);
        systemGraphLoader.invalidate(workspaceKey, resolution.revision);
        setAnnouncement({
          revision: resolution.revision,
          state: "stale",
        });
        setError(false);
        setRefreshSeq((value) => value + 1);
        return;
      }
      setNavigationResponse(null);
    })().catch(() => {
      if (active) setNavigationResponse(null);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, navigationIsCurrent, snapshot?.revision, workspaceKey]);

  useEffect(() => {
    if (
      !latestAnnouncement ||
      latestAnnouncement.workspaceKey !== workspaceKey
    ) {
      return;
    }
    const knownRevision = Math.max(
      snapshot?.revision ?? -1,
      announcement?.revision ?? -1,
    );
    if (latestAnnouncement.revision <= knownRevision) return;
    // The global event subscriber already invalidates the shared cache while
    // this destination is closed. Repeating it here keeps the view correct in
    // isolation and is a no-op for an already-observed revision.
    systemGraphLoader.invalidate(workspaceKey, latestAnnouncement.revision);
    setAnnouncement({
      revision: latestAnnouncement.revision,
      state: latestAnnouncement.state,
    });
    setNavigationResponse(null);
    setError(false);
    setRefreshSeq((value) => value + 1);
  }, [
    announcement?.revision,
    latestAnnouncement,
    snapshot?.revision,
    workspaceKey,
  ]);

  const graph = snapshot?.graph ?? null;
  const announcementIsNewer =
    effectiveAnnouncement !== null &&
    effectiveAnnouncement.revision > (snapshot?.revision ?? -1);
  let lifecycle: SystemGraphLifecycleState = snapshot?.state ?? "building";
  if (announcementIsNewer) {
    lifecycle =
      effectiveAnnouncement.state === "degraded"
        ? "degraded"
        : graph
          ? "stale"
          : "building";
  }
  if (error) lifecycle = snapshot?.graph ? "stale" : "degraded";
  const refreshing =
    !error &&
    graph !== null &&
    (loading ||
      (announcementIsNewer && effectiveAnnouncement?.state !== "degraded"));

  const retry = (): void => {
    systemGraphLoader.invalidate(workspaceKey);
    setAnnouncement(null);
    setNavigationResponse(null);
    setError(false);
    setRefreshSeq((value) => value + 1);
  };

  const navigation = useMemo(
    () =>
      navigationIsCurrent
        ? systemGraphNavigationForSnapshot(navigationResponse, snapshot)
        : new Map<string, string>(),
    [navigationIsCurrent, navigationResponse, snapshot],
  );

  return (
    <section
      className="workspace-graph-view"
      data-testid="workspace-graph-view"
      aria-label="Workspace dependencies"
    >
      <header className="workspace-graph-bar">
        {onExpandRail && (
          <button
            type="button"
            className="theme-toggle"
            data-testid="workspace-graph-rail-expand"
            aria-label="Expand workspace panel"
            onClick={onExpandRail}
          >
            <Icon name="PanelLeftOpen" size={15} />
          </button>
        )}
        <Icon name="Folder" size={15} />
        <span
          className="workspace-graph-title"
          title={workspaceName}
          {...trackingAttrs({ object: "workspace" })}
        >
          {workspaceName}
        </span>
        {refreshing && graph && (
          <span
            className="status-tag workspace-graph-lifecycle"
            data-testid="system-graph-refreshing"
            data-state="refreshing"
            role="status"
          >
            <span className="canvas-task-spinner" aria-hidden="true" />
            Refreshing graph
          </span>
        )}
        {lifecycle === "stale" && graph && !refreshing && (
          <span
            className="workspace-graph-lifecycle"
            data-testid="system-graph-stale"
            data-state="stale"
            role="status"
          >
            <span className="status-tag">
              <Icon name="TriangleAlert" size={13} />
              Graph may be out of date
            </span>
            <button
              type="button"
              className="status-tag status-tag-action"
              onClick={retry}
            >
              <Icon name="RefreshCw" size={13} />
              Retry
            </button>
          </span>
        )}
        {lifecycle === "degraded" && graph && (
          <span
            className="workspace-graph-lifecycle"
            data-testid="system-graph-degraded"
            data-state="degraded"
            role="status"
          >
            <span className="status-tag">
              <Icon name="TriangleAlert" size={13} />
              Graph may be incomplete
            </span>
            <button
              type="button"
              className="status-tag status-tag-action"
              onClick={retry}
            >
              <Icon name="RefreshCw" size={13} />
              Retry
            </button>
          </span>
        )}
      </header>

      <div className="workspace-graph-body">
        {!graph && lifecycle === "degraded" ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-error"
            icon="TriangleAlert"
            title={
              error
                ? "Couldn't load this workspace graph"
                : "Couldn't build this workspace graph"
            }
            body={
              error
                ? "Studio couldn't load the latest local graph. Check that Studio is still running, then retry."
                : "Studio couldn't produce a usable local projection. Retry after the workspace is readable."
            }
            cta={
              <button type="button" className="btn-primary" onClick={retry}>
                Retry
              </button>
            }
          />
        ) : !graph ? (
          <div
            className="canvas-loading system-graph-state"
            data-testid="system-graph-loading"
          >
            <span className="canvas-task-spinner" aria-hidden="true" />
            <p className="canvas-empty-hint">Loading workspace graph…</p>
          </div>
        ) : graph.nodes.length === 0 && lifecycle === "degraded" ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-incomplete"
            icon="TriangleAlert"
            title="Workspace graph is incomplete"
            body="Studio couldn't inspect enough of this workspace to show a reliable graph."
            cta={
              <button type="button" className="btn-primary" onClick={retry}>
                Retry
              </button>
            }
          />
        ) : graph.nodes.length === 0 ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-empty"
            icon="Frame"
            title="No agents in this workspace"
            body="Agent projects discovered inside this folder will appear here."
          />
        ) : (
          <SystemGraphCanvas
            graph={graph}
            workspaceKey={workspaceKey}
            navigableAgentKeys={new Set(navigation.keys())}
            onOpenAgent={(agentKey) => {
              const workflowPath = navigation.get(agentKey);
              if (workflowPath) onOpenAgent(workflowPath);
            }}
          />
        )}
      </div>
    </section>
  );
}
