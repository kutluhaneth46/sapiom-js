---
"@sapiom/harness": minor
---

Project dependency graphs now open immediately and stay on their fast path. Agents appear as soon as a project is selected and fill in their real names in the background, and a project whose graph is otherwise fine no longer shows "Graph may be incomplete" because one agent's source could not be read. That agent is still called out on its own; the rest of the graph is cached. Graph navigation targets are now served with the revision they belong to, so opening an agent from the map lands on the right one.
