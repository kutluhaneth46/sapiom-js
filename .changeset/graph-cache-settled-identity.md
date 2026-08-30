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
answer, not on whether it found a name. Only one case is treated as final, the
one that can be proven: a project with no TypeScript in it has nothing for an
agent name to be declared in, and no install or re-run will invent one. Every
other failure still blocks caching, so that project keeps its banner and its
Retry button — the thing that clears it once dependencies are installed, or
after a check that ran out of time succeeds on a second attempt.

The affected agents keep their warnings either way. The graph stops calling
itself incomplete over agents it was never going to resolve; it does not go
quiet about what it could not resolve.

Also stops one agent being registered twice when Studio reaches the same
directory by two different paths — once as given and once with symlinks
resolved. The duplicate pair made every reference between agents ambiguous,
silently dropping those connections from the graph. This prevents new
duplicates; a workspace that already contains a pair from an earlier version
still needs them removed by hand.
