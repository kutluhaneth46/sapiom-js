---
"@sapiom/harness": patch
---

Stop an agent that can never be named from holding a whole project's graph at
"Graph may be incomplete".

An agent that does not declare a name has its source read to recover one. If
even one agent in a project could not be read, the projection refused to cache,
so the project reopened as degraded under the "Graph may be incomplete" banner
every time. A companion package with no agent export in it has nothing to find
no matter how often it is re-read, and a single such directory was enough to
mark everything around it incomplete.

The cache now depends on whether the name lookup can still produce a different
answer, not on whether it found a name. A lookup with nowhere left to go no
longer blocks caching. Two cases still do, because for them the answer really
can change: a lookup that was still running when the projection's time budget
expired, and one that failed only because the project's dependencies are not
installed yet — that project keeps its banner and its Retry button, which is
what clears it once the install lands.

The affected agents keep their warnings either way. The graph stops calling
itself incomplete over agents it was never going to resolve; it does not go
quiet about what it could not resolve.

Also stops one agent being registered twice when Studio reaches the same
directory by two different paths — once as given and once with symlinks
resolved. The duplicate pair made every reference between agents ambiguous,
silently dropping those connections from the graph.
