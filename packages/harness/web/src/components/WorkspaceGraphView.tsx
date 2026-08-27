import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  AgentKey,
  SystemGraph,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

import type { HarnessApi } from "../lib/api";
import { createSystemGraphLoader } from "../lib/system-graph-loader";
import { mapSystemGraphNavigation } from "../lib/system-graph-navigation";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SystemGraphCanvas } from "./SystemGraphCanvas";

/**
 * V0 mirrors the server's process-lifetime snapshot in the browser tab, with
 * one later-open retry for a degraded projection. SAP-2904 owns source-driven
 * invalidation and user-visible freshness states.
 */
const loadSystemGraph = createSystemGraphLoader();

interface WorkspaceGraphViewProps {
  workspaceKey: WorkspaceKey;
  workspaceName: string;
  api: HarnessApi;
  workflows: readonly WorkflowInfo[];
  workspaceScopes: readonly WorkspaceScopeSummary[];
  onOpenAgent: (path: string) => void;
  onExpandRail?: () => void;
}

export function WorkspaceGraphView({
  workspaceKey,
  workspaceName,
  api,
  workflows,
  workspaceScopes,
  onOpenAgent,
  onExpandRail,
}: WorkspaceGraphViewProps): JSX.Element {
  const [graph, setGraph] = useState<SystemGraph | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setGraph(null);
    setError(false);
    void loadSystemGraph(api, workspaceKey).then(
      (next) => {
        if (active) setGraph(next);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, workspaceKey, attempt]);

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
      </header>

      <div className="workspace-graph-body">
        {error ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-error"
            icon="TriangleAlert"
            title="Couldn't load this workspace graph"
            body="The local projection failed. Retry the filesystem scan."
            cta={
              <button
                type="button"
                className="btn-primary"
                onClick={() => setAttempt((value) => value + 1)}
              >
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
              const workflow = navigation.get(agentKey);
              if (workflow) onOpenAgent(workflow.path);
            }}
          />
        )}
      </div>
    </section>
  );
}
