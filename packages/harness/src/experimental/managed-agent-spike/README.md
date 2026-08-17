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

The hook also requires a non-empty, bounded `tool_use_id` from the event. When
the SDK supplies the optional callback ID, it must be independently bounded and
exactly match the event ID. Invalid identifiers are denied before policy
evaluation and never become normalized permission evidence.

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

`correlation.promptEmbedded` records whether that marked prompt was handed to
the query factory. It remains false when the settings preflight prevents the
factory invocation.

The production gateway consumes both headers, but its current BigQuery
projection persists neither `polsia_eval_source` nor `sapiom_execution_id`.
Reconciliation therefore follows the existing E0.2 contract and searches the
replayed initial prompt marker. The authoritative SDK-side inference count is
the number of distinct assistant message IDs. IDs are hashed and counted only
in memory; raw or hashed IDs are not emitted. SDK `result.num_turns` is retained
separately as bounded informational evidence and is not used as the BigQuery
call-count key.

The hermetic pinned-SDK loopback exercises Read, allowed and denied Bash, and a
real in-process `echo_nonce` MCP turn. It requires one primary `PreToolUse`
decision for each request and separately verifies the MCP handler invocation
and SDK tool-result event.

## L1 certification contract v2

L1 is independently versioned as `managed-agent-l1-prompt-v2` and
`managed-agent-l1-evaluator-v2` while the transport result remains contract
version 1. The frozen prompt contains 11 canonical calls. It permits at most
one additional verification Read, only after both denial probes and before the
Edit, and only for the clean target, dirty sentinel, or untracked sentinel.

The host registers the six prompt path literals under content-free roles. Role
lookup uses normalized lexical path identity before realpath containment so an
SDK-normalized absolute path retains the same role as its relative prompt
literal. A different in-workspace path remains unregistered and is denied.
Permission evidence contains only an operation ID such as
`read:clean_target`; it never contains the raw path or tool input.

The evaluator requires every canonical request ID to be non-empty and unique,
with exactly one matching completion and one primary `PreToolUse` decision.
Fallback-only decisions, duplicate or orphan evidence, mismatched tools,
reordering, omission, retries, and every other extra operation fail closed.
The optional Read count and role are reported separately as nonblocking
efficiency evidence.

Filesystem acceptance is also exact: only the clean target may be modified and
only the managed output may be created, in either evidence order. Trusted
SHA-256 expectations prove the final bytes of both mutation targets, while the
durable result exposes only `{ role, matched }`. The dirty and untracked
sentinels must remain byte-identical, and successful `echo_nonce` handling is
recorded as a content-free nonce-verification boolean.

## L2 cancellation containment boundary

E0.4 certifies one deliberately narrow host model: the exact non-cooperative
fixture command running under an observer-owned supervisor in a detached macOS
or Linux process group. The supervisor is the persistent group leader and stays
alive when the inner Agent SDK root exits while a same-group descendant
survives. Before cancellation may fire, a bounded host `ps` sample must prove
that the trusted supervisor `ChildProcess` is still active and is the group
leader, and both PIDs read from the fixture file must already be present in the
independently host-observed group. The file is comparison evidence only; its
contents are never passed into the observer or used as signal targets.

The runtime binds the observer directly to the per-run `Options.abortController`
signal. On abort it synchronously and idempotently sends `SIGSTOP` followed by
`SIGKILL` to the supervisor-owned group while the trusted anchor handle remains
active. The returned SDK process also maps direct kills to that group, and a
parent IPC disconnect kills the group. The fixture parent and child
intentionally ignore `SIGTERM`, making the forced path load-bearing. The
supervisor's bounded `ps` helper remains inside the owned group and only its
known PID plus the anchor PID are excluded from its membership decision.
Iterator abandonment, query close, bounded process enumeration, and
group-death confirmation share one absolute five-second process-termination
deadline. Workspace snapshots and result assembly occur afterward. The
close-deadline timer remains referenced so a CLI host cannot exit before
cleanup and result reporting finish.

An unavailable or timed-out process table is explicit unknown evidence, never
an empty process table. The active detached supervisor still authorizes safe
cleanup of its owned group, but the run fails certification. An invalid or
inactive supervisor, an observed `setsid`/group escape, unknown group liveness,
failed signals, and Windows all fail closed. Windows live L2 is rejected before
the query or credential is opened. Universal containment, POSIX group escape,
Windows Job Objects, and production recovery belong to later epics; this probe
does not claim those guarantees.

## Pre-v2 live evidence

The exact-trace-v1 campaign completed both Sonnet 5 L1 repetitions and the
first MiniMax M3 L1 repetition. The second M3 L1 run had a successful terminal
result, exact model provenance, complete primary permission coverage, and clean
teardown, but made one additional allowed in-root verification Read. The v1
exact-trace evaluator rejected that run and the campaign stopped immediately;
no L2 run followed.

Those runs remain diagnostic history, not v2 acceptance evidence. Do not
restart the paid L1/L2 matrix until this v2 correction has clean CI,
independent review, and explicit authorization.
