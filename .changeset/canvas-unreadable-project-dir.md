---
"@sapiom/agent-core": patch
---

Report the real cause when a bundle fails because the project directory itself can't be read. `describeBundleFailure` probed only for a missing `node_modules`, which an unreadable or vanished project directory also answers — so a Canvas render whose esbuild failed with `Cannot read directory "…": permission denied` told the user to run `npm install` in a directory nothing could list. It now names the directory and the reason (permission denied, no longer exists, not a directory) and keeps the raw esbuild detail. `check()` and local-run bundling also anchor esbuild's `absWorkingDir` to the project, so diagnostics read `index.ts` instead of a `../../../../..` chain relative to whichever package invoked them.
