# Managed Agent Feasibility Spike

This subpath is an Epic 0 probe, not a production Harness runtime. It does not
change the PTY adapter, Studio UI, session history, or existing Claude Code and
Codex flows.

## Host policy boundary

Every model-requested Read, Edit, Write, Bash, and in-process MCP call is gated
by one programmatic `PreToolUse` hook registered without a matcher. The hook
runs before the SDK's permission evaluation, applies canonical-path containment,
exact Bash equality, and an MCP allowlist, and returns a complete fresh input
object only when allowing the call. Unknown tools fail closed.

`canUseTool` remains only as defense in depth for calls the SDK leaves
unresolved. It shares the same evaluator and deduplicates by tool-use ID, so it
cannot create a second evidence record. A live result is rejected when any
requested tool lacks exactly one primary `PreToolUse` decision. This detects a
hook that was skipped, but detection after execution is not by itself a host
boundary.

Before `query()` is created, a credential-free subprocess rooted in the
probe's isolated HOME and `CLAUDE_CONFIG_DIR` calls SDK `resolveSettings()`.
`disableAllHooks`, resolution errors, timeouts, malformed output, and configured
`policyHelper`/`policyHelpers` all produce `policy_violation` without creating a
query. Policy helpers fail closed because SDK 0.3.228 does not execute them in
`resolveSettings()` and therefore cannot prove parity with query startup.

The subprocess requires a Node executable. E0.4 uses the current Node host;
Electron-as-Node and packaged executable resolution are deliberately deferred
to E0.7. The runtime also exposes only a narrow async-iterator/close query
interface. It does not expose or call SDK `Query.mcpCall()`, whose trusted
control channel bypasses permission checks.

## Correlation and turn evidence

The runtime sends `x-sapiom-eval-source` and `x-sapiom-execution-id`, then embeds
the same non-secret values in the initial prompt as:

```text
SAPIOM_CERTIFICATION_CORRELATION_V1;eval_source=<value>;execution_id=<value>
```

The production gateway consumes both headers, but its current BigQuery
projection persists neither `polsia_eval_source` nor `sapiom_execution_id`.
Reconciliation therefore follows the existing E0.2 contract and searches the
replayed initial prompt marker. The authoritative SDK-side inference count is
the number of distinct assistant message IDs. IDs are hashed and counted only
in memory; raw or hashed IDs are not emitted. SDK `result.num_turns` is retained
separately as bounded informational evidence and is not used as the BigQuery
call-count key.

## Pre-fix live evidence

The first Sonnet 5 L1 attempt reached an SDK success result and clean teardown,
but SDK default permissions executed successful Read and Bash calls without
invoking the former `canUseTool` boundary. The fixed matrix stopped immediately;
no retry or later model/scenario attempt ran. BigQuery showed exact Sonnet
provider/model, no fallback, positive tokens, and cost for all 11 calls, but no
durable correlation field and no independent SDK inference count.

That attempt is not acceptance evidence. Do not run another paid L1/L2 matrix
until this correction has independent review and explicit authorization.
