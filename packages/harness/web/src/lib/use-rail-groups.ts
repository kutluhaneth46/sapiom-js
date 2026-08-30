import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { WorkflowInfo } from "@shared/types";

import { createApi } from "./api";
import type { GroupNode, LaunchEdge, MaterializedRailState, RailState } from "./agent-groups";
import {
  EMPTY_RAIL_STATE,
  deriveOrStored,
  materialize,
  railStateWrite,
  readRailState,
  resetToDetected,
} from "./agent-groups";
import { rootContains } from "./session-scope";
import type { RailSort } from "./project-tree";

/**
 * The Group axis's live state: one stored arrangement per project root, read
 * from and written to `<root>/.sapiom/studio-rail.json`.
 *
 * Module-level api instance, matching `use-account-plan.ts` — the rail is handed
 * callbacks rather than a client, and these routes are read-mostly.
 */
const api = createApi();

/** Roots are joined into one dependency string; a newline cannot appear in a
 *  path the settings file or a session cwd produced, a space can. */
const ROOTS_SEP = "\n";

/**
 * ONE arrangement per project root, shared by every consumer on the page.
 *
 * The rail and the project MAP are two views of the same groups (SAP-2983), and
 * two hook instances holding two copies is exactly how they come to disagree:
 * an edit in the rail would leave the map still drawing the arrangement from
 * before it, with no event to tell it otherwise — the file is the only shared
 * medium, and nothing re-reads it. So the cache is module-level for the same
 * reason the file is per project: there is one answer, and both surfaces read
 * it.
 *
 * What deliberately does NOT live here is "have I asked for this yet". That
 * stays per hook, so mounting a surface re-reads the file — it is a committable
 * file that a branch switch or a hand edit can change under the app, and a
 * module-level request latch would mean the page never looked again, and never
 * retried a read that failed. Two surfaces mounting therefore issue two GETs of
 * the same file, which is a cheap read and idempotent.
 */
interface RailGroupsStore {
  /** A property of the INSTALL, not of a root, so one read serves every
   *  project. Null until it lands. */
  edges: LaunchEdge[] | null;
  states: Map<string, RailState>;
  /** Roots whose file READ SUCCEEDED. Gates writes. */
  loaded: Set<string>;
  /** Roots whose read has SETTLED, successfully or not. Gates drawing.
   *  See `hasSettled` — the two must stay different sets. */
  settled: Set<string>;
  listeners: Set<() => void>;
  /** Bumped on every mutation. `useSyncExternalStore` compares it by identity,
   *  and every accessor below takes it as a dependency — a Map mutated in place
   *  cannot be compared, and a version number can. */
  version: number;
}

const store: RailGroupsStore = {
  edges: null,
  states: new Map(),
  loaded: new Set(),
  settled: new Set(),
  listeners: new Set(),
  version: 0,
};

function notify(): void {
  store.version += 1;
  for (const listener of [...store.listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

const snapshot = (): number => store.version;

/** Roots are compared canonically — the rail holds what the user typed and the
 *  map holds what the server resolved, and `<root>/` and `<root>` are one
 *  directory. Storing under the raw spelling would give one project two
 *  arrangements. */
const canonicalRoot = (root: string): string =>
  root.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");

/** Writes in flight, per canonical root. See `commit` below. */
const writeChain = new Map<string, Promise<void>>();

export interface RailGroups {
  /** The rows to render for one project root: the stored groups if the user has
   *  any, the derived ones until then, `Ungrouped` last either way. */
  groupsFor: (root: string, workflows: readonly WorkflowInfo[]) => GroupNode[];
  /** The agents this root contains, in registry order. Containment is
   *  `session-scope.rootContains`, the app's ONE answer — an agent files under
   *  every open root that holds it, exactly as on the Project axis. */
  agentsIn: (root: string) => WorkflowInfo[];
  /**
   * Whether this root can be edited yet: its stored arrangement AND the launch
   * edges have both arrived.
   *
   * Both halves matter. Editing before the file lands would write over an
   * arrangement that is still in flight; materializing before the edges land
   * would freeze an EMPTY derived set as the user's own, which is the stuck
   * state `Reset to detected` exists to escape — reached by clicking fast.
   *
   * The map reads it for a different reason and the same one: drawing before
   * both halves land would show every agent in `Ungrouped` for a beat, which is
   * a real arrangement and would read as the answer.
   */
  isReady: (root: string) => boolean;
  /**
   * Whether this root's arrangement is safe to DRAW: the edges landed and the
   * read has settled — successfully or not.
   *
   * Deliberately weaker than `isReady`, and the difference is a real failure.
   * A read that fails is answered as "nothing stored", which shows the DERIVED
   * groups; the rail renders those, because a group axis you cannot write to is
   * still a group axis you can look at. `isReady` stays false for that root
   * forever, on purpose, so nothing can be edited into a file we were unable to
   * read. A map gated on `isReady` would therefore fall back to an unlabelled
   * flat layout on a read-only checkout or a 5xx, while the rail six inches away
   * showed the systems by name — which is the exact divergence this feature
   * exists to remove.
   */
  hasSettled: (root: string) => boolean;
  /** The stored state, for the reset control's copy ("Discards 3 groups"). */
  stateFor: (root: string) => RailState;
  /** Apply a pure operation to one root's arrangement and persist the result.
   *  Materializes first, always: the type demands it, so a user's arrangement
   *  can never be overwritten by a later detection pass. */
  edit: (
    root: string,
    workflows: readonly WorkflowInfo[],
    fn: (state: MaterializedRailState) => MaterializedRailState,
  ) => void;
  /** Hand authority back to detection and ERASE the stored file. Removing rather
   *  than skipping the write is what makes the reset persist. */
  reset: (root: string) => void;
}

/**
 * PERSISTENCE HAPPENS AT THE EDIT, NEVER IN AN EFFECT. This is the whole ticket.
 *
 * The reference prototype synced state to storage from a `useEffect` keyed on
 * the state. That effect also runs on MOUNT, where the state is still
 * un-materialized (`groups: null`) — and serializing that wrote `groups: []`,
 * which means the entirely different thing "the user materialized groups and
 * then deleted every one". So the first page load silently converted "detection
 * owns this" into "the user deleted everything", and from the second load onward
 * every agent fell into `Ungrouped`, in every project, permanently. It read as
 * the group axis never having been built.
 *
 * Fixing the serializer alone would not have been enough, and this is the part
 * worth spelling out: a mount-time sync effect is ALSO wrong in the other
 * direction. Loading is asynchronous, so on mount the state is un-materialized
 * even for a project that does have an arrangement stored — and an effect
 * faithfully persisting "un-materialized" as a file removal would DELETE that
 * file a beat before the read that would have loaded it lands.
 *
 * So there is no sync effect at all. A write is a consequence of an edit, and
 * `commit` below is the only thing in the app that ever touches the file.
 */
export function useRailGroups(
  roots: readonly string[],
  workflows: readonly WorkflowInfo[],
  sort: RailSort,
  enabled: boolean,
): RailGroups {
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);

  /** Roots and edges this INSTANCE has already asked for. Refs, not state, so
   *  they update synchronously and a re-render mid-flight cannot start a second
   *  read; per instance, so a remount re-reads. */
  const requested = useRef(new Set<string>());
  const edgesRequested = useRef(false);

  // The registry changes as agents are scanned, and the load effect below must
  // not re-run for that — it would re-read every project's file. It reads the
  // latest registry through a ref instead of depending on it.
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;

  // Launch edges are a property of the INSTALL, not of a root, so one read
  // serves every project. Fetched only once the axis is in use: it greps every
  // registered agent's sources, and the Project axis has no use for the answer.
  useEffect(() => {
    if (!enabled || edgesRequested.current) return;
    edgesRequested.current = true;
    void api
      .listLaunchEdges()
      .then((next) => {
        store.edges = next;
        notify();
      })
      .catch(() => {
        // No edges is a truthful degradation: every agent shows in `Ungrouped`,
        // which is what a repo with no launch calls looks like anyway. Recorded
        // as an empty ARRAY rather than left null so the axis becomes editable —
        // hand-grouping is the whole point when detection finds nothing.
        store.edges = [];
        notify();
      });
  }, [enabled]);

  const rootsKey = roots.map(canonicalRoot).join(ROOTS_SEP);
  useEffect(() => {
    if (!enabled) return;
    for (const root of rootsKey.split(ROOTS_SEP).filter(Boolean)) {
      if (requested.current.has(root)) continue;
      requested.current.add(root);
      void api
        .getRailState(root)
        .then((raw) => {
          // Parsed against the FULL registry rather than this root's slice: a
          // member path belonging to a neighbouring project is still a real
          // agent, and pruning it here would silently drop it from a file the
          // next edit rewrites.
          store.states.set(root, readRailState(raw, workflowsRef.current));
          store.loaded.add(root);
          store.settled.add(root);
          notify();
        })
        .catch(() => {
          // An older server with no such route, or an unreadable project. Both
          // read as "nothing stored", which shows the derived groups — but the
          // root stays NOT loaded, so nothing can be edited into a file we were
          // unable to read. It IS settled: both surfaces now have the same
          // answer to draw, which is the point of the two sets being different.
          store.states.set(root, EMPTY_RAIL_STATE);
          store.settled.add(root);
          // Forget the request so a later mount tries the read again; a
          // permanent latch would make one bad response permanent.
          requested.current.delete(root);
          notify();
        });
    }
  }, [enabled, rootsKey]);

  const stateFor = useCallback(
    (root: string): RailState => store.states.get(canonicalRoot(root)) ?? EMPTY_RAIL_STATE,
    // `version` stands in for the store: a Map mutated in place cannot be a
    // dependency, and the counter it bumps can.
    [version],
  );

  const isReady = useCallback(
    (root: string): boolean => store.edges !== null && store.loaded.has(canonicalRoot(root)),
    [version],
  );

  const hasSettled = useCallback(
    (root: string): boolean => store.edges !== null && store.settled.has(canonicalRoot(root)),
    [version],
  );

  /**
   * Writes in flight per root, chained.
   *
   * Two edits in quick succession — drag, then reset — are two requests, and
   * concurrent requests can complete out of order. That is not a cosmetic race
   * here: the reset's DELETE finishing before the drag's PUT leaves the file
   * holding the arrangement the reset was meant to erase, which is the stuck
   * state all over again. Chaining makes the file end where the user left off.
   *
   * Module-level with the rest of the store, because two SURFACES editing one
   * root are the same race as two edits from one.
   */
  const commit = useCallback((root: string, next: RailState): void => {
    const key = canonicalRoot(root);
    store.states.set(key, next);
    notify();
    const write = railStateWrite(next);
    const previous = writeChain.get(key) ?? Promise.resolve();
    const persisted = previous.then(() =>
      write.kind === "write" ? api.saveRailState(root, write.raw) : api.clearRailState(root),
    );
    writeChain.set(
      key,
      persisted.catch(() => {
        // A read-only checkout or an older server. The arrangement still applies
        // for this session; it simply will not be there next time — and the
        // chain must survive so a later edit still gets its turn.
      }),
    );
  }, []);

  const edit = useCallback(
    (
      root: string,
      rootWorkflows: readonly WorkflowInfo[],
      fn: (state: MaterializedRailState) => MaterializedRailState,
    ): void => {
      const key = canonicalRoot(root);
      if (store.edges === null || !store.loaded.has(key)) return;
      const current = store.states.get(key) ?? EMPTY_RAIL_STATE;
      commit(root, fn(materialize(current, rootWorkflows, store.edges, sort)));
    },
    [commit, sort],
  );

  const reset = useCallback(
    (root: string): void => {
      const key = canonicalRoot(root);
      if (!store.loaded.has(key)) return;
      commit(root, resetToDetected(store.states.get(key) ?? EMPTY_RAIL_STATE));
    },
    [commit],
  );

  const agentsIn = useCallback(
    (root: string): WorkflowInfo[] =>
      workflows.filter((workflow) => rootContains(root, workflow.path)),
    [workflows],
  );

  const groupsFor = useCallback(
    (root: string, rootWorkflows: readonly WorkflowInfo[]): GroupNode[] =>
      deriveOrStored(
        rootWorkflows,
        store.states.get(canonicalRoot(root)) ?? EMPTY_RAIL_STATE,
        store.edges ?? [],
        sort,
      ),
    [sort, version],
  );

  return useMemo(
    () => ({ groupsFor, agentsIn, isReady, hasSettled, stateFor, edit, reset }),
    [groupsFor, agentsIn, isReady, hasSettled, stateFor, edit, reset],
  );
}
