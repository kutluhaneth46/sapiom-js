---
"@sapiom/harness": patch
---

Removed the legacy deploy / prod-run / run-local terminal macros. The Studio performs these actions through its direct API routes now, so the old macros were an unused duplicate path that would have started the coding agent (and its cost) unnecessarily.
