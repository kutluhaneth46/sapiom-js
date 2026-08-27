import type { WorkspaceKey } from "@shared/system-graph";

export const SYSTEM_GRAPH_DEFAULT_MIN_ZOOM = 0.25;
export const SYSTEM_GRAPH_FLOOR_ZOOM = 0.1;
export const SYSTEM_GRAPH_MAX_ZOOM = 3;
export const SYSTEM_GRAPH_ZOOM_STEP = 0.25;
export const SYSTEM_GRAPH_WHEEL_RATE = 0.0015;

const FIT_EDGE_REM = 3.5;
const FIT_EDGE_AXIS_CAP = 0.2;

export interface SystemGraphSize {
  width: number;
  height: number;
}

export interface SystemGraphView {
  zoom: number;
  x: number;
  y: number;
}

export interface SystemGraphFit extends SystemGraphView {
  minZoom: number;
}

export interface SavedSystemGraphView {
  view: SystemGraphView;
  autoFitted: boolean;
}

export interface SystemGraphViewportStore {
  get(workspaceKey: WorkspaceKey): SavedSystemGraphView | undefined;
  set(workspaceKey: WorkspaceKey, saved: SavedSystemGraphView): void;
}

const roundZoom = (zoom: number): number => Math.round(zoom * 100) / 100;

export function clampSystemGraphZoom(
  zoom: number,
  minZoom = SYSTEM_GRAPH_DEFAULT_MIN_ZOOM,
): number {
  return Math.min(
    SYSTEM_GRAPH_MAX_ZOOM,
    Math.max(Math.max(SYSTEM_GRAPH_FLOOR_ZOOM, minZoom), roundZoom(zoom)),
  );
}

export function fitSystemGraphView(
  graph: SystemGraphSize,
  viewport: SystemGraphSize,
  rootFontSize: number,
): SystemGraphFit {
  if (
    graph.width <= 0 ||
    graph.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return {
      zoom: 1,
      x: 0,
      y: 0,
      minZoom: SYSTEM_GRAPH_DEFAULT_MIN_ZOOM,
    };
  }
  const preferred = FIT_EDGE_REM * rootFontSize;
  const insetX = Math.min(preferred, viewport.width * FIT_EDGE_AXIS_CAP);
  const insetY = Math.min(preferred, viewport.height * FIT_EDGE_AXIS_CAP);
  const fitted = Math.min(
    (viewport.width - insetX * 2) / graph.width,
    (viewport.height - insetY * 2) / graph.height,
    SYSTEM_GRAPH_MAX_ZOOM,
  );
  const zoom = Math.max(
    SYSTEM_GRAPH_FLOOR_ZOOM,
    Math.min(SYSTEM_GRAPH_MAX_ZOOM, Math.floor(fitted * 100) / 100),
  );
  return {
    zoom,
    x: 0,
    y: 0,
    minZoom: Math.min(SYSTEM_GRAPH_DEFAULT_MIN_ZOOM, zoom),
  };
}

export function resetSystemGraphView(): SystemGraphView {
  return { zoom: 1, x: 0, y: 0 };
}

export function zoomSystemGraphAtPointer(
  view: SystemGraphView,
  nextZoom: number,
  pointer: SystemGraphPoint,
): SystemGraphView {
  if (view.zoom <= 0 || nextZoom === view.zoom)
    return { ...view, zoom: nextZoom };
  const ratio = nextZoom / view.zoom;
  return {
    zoom: nextZoom,
    x: pointer.x - ratio * (pointer.x - view.x),
    y: pointer.y - ratio * (pointer.y - view.y),
  };
}

export interface SystemGraphPoint {
  x: number;
  y: number;
}

export function wheelSystemGraphView(
  view: SystemGraphView,
  deltaY: number,
  pointer: SystemGraphPoint,
  minZoom: number,
): SystemGraphView {
  const zoom = clampSystemGraphZoom(
    view.zoom * Math.exp(-deltaY * SYSTEM_GRAPH_WHEEL_RATE),
    minZoom,
  );
  return zoomSystemGraphAtPointer(view, zoom, pointer);
}

export function createSystemGraphViewportStore(): SystemGraphViewportStore {
  const saved = new Map<WorkspaceKey, SavedSystemGraphView>();
  return {
    get(workspaceKey) {
      const value = saved.get(workspaceKey);
      return value
        ? { view: { ...value.view }, autoFitted: value.autoFitted }
        : undefined;
    },
    set(workspaceKey, value) {
      saved.set(workspaceKey, {
        view: { ...value.view },
        autoFitted: value.autoFitted,
      });
    },
  };
}
