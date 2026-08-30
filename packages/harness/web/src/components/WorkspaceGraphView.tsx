import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  AgentKey,
  SystemGraphLifecycleState,
  SystemGraphSnapshot,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "@shared/system-graph";
import type { BusMessage, WorkflowInfo } from "@shared/types";

import type { HarnessApi } from "../lib/api";
import { systemGraphLoader } from "../lib/system-graph-loader";
import { systemGraphNodeGroups } from "../lib/system-graph-groups";
import { mapSystemGraphNavigation } from "../lib/system-graph-navigation";
import { useRailGroups } from "../lib/use-rail-groups";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SystemGraphCanvas } from "./SystemGraphCanvas";

interface WorkspaceGraphViewProps {
  workspaceKey: WorkspaceKey;
  workspaceName: string;
  api: HarnessApi;
  workflows: readonly WorkflowInfo[];
  workspaceScopes: readonly WorkspaceScopeSummary[];
  lastMessage: BusMessage | null;
  /** Drill from a map node into that agent's board — a CUT to the other
   *  altitude, which also moves the rail selection so the two agree. */
  onOpenAgent: (path: string) => void;
}

export function WorkspaceGraphView({
  workspaceKey,
  workspaceName,
  api,
  workflows,
  workspaceScopes,
  lastMessage,
  onOpenAgent,
}: WorkspaceGraphViewProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<SystemGraphSnapshot | null>(() =>
    systemGraphLoader.peek(workspaceKey),
  );
  const [announcement, setAnnouncement] = useState<{
    revision: number;
    state: SystemGraphLifecycleState;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);

  useEffect(() => {
    let active = true;
    setError(false);
    setLoading(true);
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
        setAnnouncement(null);
        setError(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, workspaceKey, refreshSeq]);

  useEffect(() => {
    if (
      lastMessage?.type !== "system-graph.changed" ||
      lastMessage.workspaceKey !== workspaceKey
    ) {
      return;
    }
    const knownRevision = Math.max(
      snapshot?.revision ?? -1,
      announcement?.revision ?? -1,
    );
    if (lastMessage.revision <= knownRevision) return;
    // The global event subscriber already invalidates the shared cache while
    // this destination is closed. Repeating it here keeps the view correct in
    // isolation and is a no-op for an already-observed revision.
    systemGraphLoader.invalidate(workspaceKey, lastMessage.revision);
    setAnnouncement({
      revision: lastMessage.revision,
      state: lastMessage.state,
    });
    setError(false);
    setRefreshSeq((value) => value + 1);
  }, [announcement?.revision, lastMessage, snapshot?.revision, workspaceKey]);

  const graph = snapshot?.graph ?? null;
  const announcementIsNewer =
    announcement !== null && announcement.revision > (snapshot?.revision ?? -1);
  let lifecycle: SystemGraphLifecycleState = snapshot?.state ?? "building";
  if (announcementIsNewer) {
    lifecycle =
      announcement.state === "degraded"
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
      (announcementIsNewer && announcement?.state !== "degraded"));

  const retry = (): void => {
    systemGraphLoader.invalidate(workspaceKey);
    setAnnouncement(null);
    setError(false);
    setRefreshSeq((value) => value + 1);
  };

  const navigation = useMemo(
    () =>
      graph
        ? mapSystemGraphNavigation(
            graph.nodes,
            workspaceKey,
            workflows,
            workspaceScopes,
          )
        : new Map<AgentKey, WorkflowInfo>(),
    [graph, workspaceKey, workflows, workspaceScopes],
  );

  /* THE MAP READS THE RAIL'S GROUPS (SAP-2983).
     The Group axis is stored per project ROOT, and a workspace scope is the one
     thing that joins this opaque key back to one — the graph payload carries no
     filesystem path on purpose. Sorted by name because a container's order on
     the map is its own (`shelfPack` keeps the rail's group order); this only
     settles the order of agents inside one, which the layout re-decides from
     the topology anyway. */
  const projectRoot = useMemo(
    () =>
      workspaceScopes.find((scope) => scope.workspaceKey === workspaceKey)
        ?.cwd ?? null,
    [workspaceKey, workspaceScopes],
  );
  const railRoots = useMemo(
    () => (projectRoot === null ? [] : [projectRoot]),
    [projectRoot],
  );
  const railGroups = useRailGroups(
    railRoots,
    workflows,
    "name",
    projectRoot !== null,
  );
  const groups = useMemo(() => {
    // `isReady` is BOTH halves — the stored arrangement and the launch edges.
    // Drawing before either lands would put every agent in one `Ungrouped`
    // container for a beat, and that is a real arrangement, not a placeholder:
    // it would read as this project's answer and then silently rearrange.
    if (!graph || projectRoot === null || !railGroups.isReady(projectRoot)) {
      return undefined;
    }
    return systemGraphNodeGroups(
      graph.nodes,
      railGroups.groupsFor(projectRoot, railGroups.agentsIn(projectRoot)),
      navigation,
    );
  }, [graph, navigation, projectRoot, railGroups]);

  return (
    /* The MAP altitude of the right pane (`lib/canvas-altitude.ts`) — a
       project's agents and the edges between them, drawn beside the
       conversation rather than instead of it. */
    <section
      className="workspace-graph-view"
      data-testid="workspace-graph-view"
      aria-label="Workspace dependencies"
    >
      <header className="workspace-graph-bar">
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
            groups={groups}
            onOpenAgent={(agentKey) => {
              const workflow = navigation.get(agentKey);
              if (workflow) onOpenAgent(workflow.path);
            }}
          />
        )}
      </div>
    </section>
  );
}
