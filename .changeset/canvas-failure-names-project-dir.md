---
"@sapiom/harness": patch
---

Canvas extraction failures now name the project directory they bundled. The Canvas is the only `check()` caller whose directory the user never typed — it comes from the bound workflow row — so a report of "check, run_local and deploy succeed but the Canvas fails on the same project" was unfalsifiable from the panel alone; esbuild's own paths are printed relative to the invoking package, which reads like the bundler resolving `node_modules` from the wrong root.
