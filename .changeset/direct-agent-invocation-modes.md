---
"@sapiom/harness": minor
---

Detect literal direct agent `run` and `launch` relationships in Agent Studio workspace graphs, distinguish blocking and asynchronous modes, and report dynamic targets without drawing misleading connectors.

The syntax-only detector recognizes the exact `ctx.sapiom.agents` form plus proven named `agents` aliases and legacy `orchestrations.launch` imports from `@sapiom/tools`. Unlike the previous text match, unrelated local objects, custom context names, destructured namespaces, namespace imports, and optional chains are not inferred. The existing per-agent Canvas remains launch-only; blocking calls are relationships in the workspace graph and are not billable capability chips.

TypeScript is now a Harness runtime dependency because published Harness and desktop servers execute the syntax parser locally.
