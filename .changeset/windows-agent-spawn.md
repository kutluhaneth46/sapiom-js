---
"@sapiom/harness": patch
---

Fix starting a session on Windows. An agent installed by npm is `claude.cmd`, and node-pty spawns via `CreateProcess`, which performs no `PATHEXT` resolution and cannot execute a `.cmd` at all — so every session failed with `Cannot create process, error code: 2` while `doctor` reported the agent present (detection shells `where`, which *does* resolve `PATHEXT`). Background tasks and macros failed the same way through `child_process.spawn`.

Both paths now resolve the shim to what it really runs — Claude Code ships a native `bin\claude.exe`, other packages a `cli.js` run under node — and spawn that directly. Deliberately **not** via `cmd.exe`: node-pty escapes `"` as `\"` for `CreateProcess`, but cmd only counts raw quotes, so one embedded quote desynchronises its parser and any following `&`/`|` becomes a command separator (CVE-2024-27980's class, reachable on every session since the codex adapter passes `JSON.stringify(prompt)` as an argument). Resolving the target keeps arguments in exactly one quoting layer, with no shell involved.

Also exports `resolveSpawnTarget` and `createClaudeCodeAdapter` for hosts that spawn a pty themselves or need to point the adapter at a different binary. No change on macOS or Linux.
