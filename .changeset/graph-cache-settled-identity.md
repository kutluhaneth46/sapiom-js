---
"@sapiom/harness": patch
---

Stop a permanently unreadable agent from holding a whole project's graph at
"Graph may be incomplete".

An agent that does not declare a name has its source read to recover one. If
even one agent in a project could not be read, the projection refused to cache
— so the project reopened as degraded, under the "Graph may be incomplete"
banner, every time. In practice that is the normal state of a real workspace:
a companion package with no agent export, or one whose dependencies were never
installed, can never be named no matter how often it is re-read, and a single
such directory was enough to mark everything around it incomplete.

The cache now depends on whether the name lookup FINISHED, not on whether it
found a name. A lookup that completed is settled and no longer blocks caching;
one that was still running when the projection's time budget expired does
block it, because caching a placeholder would leave the wrong label on screen
until the next edit.

The affected agents keep their warnings. The graph stops calling itself
incomplete; it does not go quiet about what it could not resolve.

Also fixes duplicate agents when Studio is launched through a symlinked
directory. Agents were registered once under the path as given and again under
its resolved form, and the duplicate pair made every reference between agents
ambiguous, silently dropping those connections from the graph.
