# Project system graph HTTP contract

Agent Studio exposes a local, read-only dependency graph for each opened
Project. The route keeps its historical `/workspaces/` name, but a
`workspaceKey` identifies one exact Project root in the current Studio server.
It is an opaque server-issued value, not a path and not an identifier clients
should derive.

The API is local to the Harness process and sits behind the same boot-token
middleware as the rest of `/api`. Send the token in `X-Harness-Token`. An
unknown or retired key returns `404 { "error": "Workspace not found" }` without
scanning the supplied string as a path.

## Discovering a Project key

`GET /api/state` includes an optional `workspaceScopes` array:

```ts
interface WorkspaceScopeSummary {
  workspaceKey: string;
  cwd: string;
}
```

The browser joins a displayed Project root to the entry with the same `cwd`
and then uses its `workspaceKey`. Filesystem paths stop at this state boundary:
system-graph snapshots and change events never contain a Project root or agent
source path.

## Reading and refreshing

```http
GET  /api/workspaces/:workspaceKey/system-graph
POST /api/workspaces/:workspaceKey/system-graph/refresh
```

`GET` returns the current accepted process-memory snapshot. On a cold read,
known inventory nodes and revision-matched navigation render immediately in a
degraded projection; bounded relationship extraction and background discovery
may publish a later revision. Concurrent reads share that work, and ordinary
reads never await a filesystem baseline or discovery scan. `POST .../refresh`
reruns registry prerequisites, requests a fresh projection, waits for that
attempt, and is the explicit recovery action after an error. Both successful
routes return `200` with a
`SystemGraphSnapshot`:

```ts
interface SystemGraphSnapshot {
  workspaceKey: string;
  revision: number;
  state: "building" | "ready" | "stale" | "degraded";
  graph: SystemGraph | null;
}
```

Revisions increase for accepted lifecycle transitions. They are monotonic for
one `workspaceKey` during one server process, including a remove-and-reopen,
but they are not durable across a Studio restart.

| State      | `graph`                                 | Meaning                                                                                                                                      |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `building` | `null` until a usable projection exists | The first projection, or a refresh without last-good data, is in progress.                                                                   |
| `ready`    | non-null                                | The current projection completed and is cacheable.                                                                                           |
| `stale`    | non-null                                | A last-good graph remains usable while refresh is running or after refresh failed.                                                           |
| `degraded` | partial graph or `null`                 | Projection was not cacheable, or no usable graph could be built. The UI may offer one bounded automatic recovery followed by explicit retry. |

Every `200` response also carries:

```http
X-Sapiom-System-Graph-Cache: complete | degraded
```

`complete` means the returned snapshot is `ready`. `building`, `stale`, and
`degraded` all report `degraded`; the header is a health/cacheability signal,
not an HTTP cache directive.

## Resolving agent navigation

Filesystem navigation is isolated from the public graph payload behind a
separate boot-token-protected route:

```http
GET /api/workspaces/:workspaceKey/system-graph/navigation
```

It returns the resolver sidecar committed atomically with the graph snapshot:

```ts
interface SystemGraphNavigationResponse {
  workspaceKey: string;
  revision: number;
  targets: Array<{ agentKey: string; workflowPath: string }>;
}
```

The response has `Cache-Control: no-store`. Agent paths appear only in this
protected sidecar; they never enter `SystemGraph` JSON, lifecycle events, or
browser-derived identity logic. The browser accepts a sidecar only when both
its `workspaceKey` and `revision` exactly match the displayed snapshot. A
malformed or mismatched response, a newer invalidation, or a snapshot in a
loading, error, `building`, or `stale` state leaves graph cards inert. If the
resolver is newer, the browser reloads the graph through the normal lifecycle
and retries the join within a bounded loop.

## Graph payload

`SystemGraph` is path-free and has `kind: "system"`. Its scope repeats only the
opaque key. Nodes contain an `id`, Project-scoped `agentKey`, and display
`label`. Edges are static `invokes` relationships with a `blocking` or `async`
mode. Blocking and asynchronous calls between the same pair remain distinct in
the JSON even when the UI groups them into one connector.

Projection can remain useful while reporting warnings:

| Warning code                  | Meaning                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `unresolved-target`           | A literal target does not resolve to an agent in the selected Project.                            |
| `dynamic-target`              | Source contains a call whose target cannot be proven statically.                                  |
| `duplicate-edge`              | The same mode-specific relationship was discovered more than once.                                |
| `projection-failed`           | A relationship projection failed and the remaining graph was preserved.                           |
| `duplicate-agent-key`         | More than one contained agent proposed the same key; local fallback identities disambiguate them. |
| `inventory-extraction-failed` | One agent could not be enriched, so the remaining inventory was returned.                         |

Registry-known agents enter a working-tree package inventory and render
immediately. A syntax-proven source definition name is canonical without
bundling or executing project code; a retained marker/cloud slug remains only a
compatibility alias. Unknown or invalid identity uses a safe provisional marker
or `local:` key and makes the snapshot degraded. Marker-authorized legacy name
inspection and relationship extraction run in bounded background queues after
the inventory projection commits. Settled identities/edges publish a later
revision; failures preserve provisional nodes and unambiguous direct edges.

## Freshness event

After an accepted transition, the Harness event WebSocket publishes:

```ts
{
  type: "system-graph.changed";
  workspaceKey: string;
  revision: number;
  state: "building" | "ready" | "stale" | "degraded";
}
```

The event is an invalidation hint. Clients compare its key and revision with
the displayed snapshot and refetch when newer; the graph itself is not sent on
the event bus.

Opening a Project graph acquires a canonical-root watcher lease. Sessions and
graphs for the same root share its bounded asynchronous fingerprint rather than
multiplying recursive walks. Relevant raw events synchronously make old
navigation inert; source/inventory reconciliation is debounced, coalesced, and
generation-guarded. Platforms without recursive watch support, or watchers that
later error, fall back to asynchronous polling over the same admitted candidate
and dependency observations. Removing the final lease retires the watcher and
degrades its accepted freshness proof before a later reopen can reuse it.
