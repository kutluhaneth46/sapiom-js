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

The durable result also records content-free, non-authoritative SDK model
evidence. A completed L1 run must observe the selected alias in both the SDK
init event and the sole `result.modelUsage` key. A cancelled L2 run may have no
result event, so it requires the matching init model and then relies on gateway
reconciliation. These checks prove what the SDK reported, not what the gateway
served: BigQuery provider/model, fallback, token, and cost rows remain the
authoritative exact-deployment evidence for every live inference turn.

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

Requests keep their exact canonical order while completions may be permuted
within the two batchable phases. Every request must precede its own completion;
all five discovery completions must precede the optional verification Read (or
Edit when it is absent), the optional Read must complete before Edit, and the
Edit/Write/MCP phase must complete before the recovery retry. The first
`fail_once` error must complete before its retry, and that retry must complete
before Bash. The evaluator additionally requires at least four distinct
assistant inference turns, plus one when the optional Read is present. This
accepts observed SDK batching without allowing an all-requests-first trace to
masquerade as multi-turn recovery.

Normalized tool and permission events must be an exact chronological
projection of their evidence arrays. Each primary permission event must precede
its matching tool completion. It may appear before or after the matching request
event because the SDK hook and yielded message have independent observation
order. A successful Bash completion must precede the single successful SDK
result, which must precede the final successful terminal event.

Filesystem acceptance is also exact: only the clean target may be modified and
only the managed output may be created, in either evidence order. Trusted
SHA-256 expectations prove the final bytes of both mutation targets, while the
durable result exposes only `{ role, matched }`. The dirty and untracked
sentinels must remain byte-identical, and successful `echo_nonce` handling is
recorded as a content-free nonce-verification boolean.

## L2 cancellation containment boundary

E0.4 certifies one deliberately narrow host model: the exact non-cooperative
fixture command running below an observer-owned Agent SDK supervisor on macOS or
Linux. The exact fixture parent and child each authenticate over a separate
private Unix-socket connection and keep that connection open for their complete
lifetime. Before cancellation may fire, a fresh bounded `ps` sample must observe
an active SDK supervisor root with stable identity, both role-tagged PIDs, their
parent-child relationship, their shared process group, and every current group
member as a descendant of that owned root. The group must be distinct from both
the host and SDK supervisor groups. Every observed root/tool descendant retains
an immutable creation-time, parent, process-group, and session baseline. Once L2
tool containment is armed, every current root descendant must remain in the
supervisor group or authenticated tool group; reparenting or PGID/session
migration fails closed. The random capability and role-tagged lifetime channels
are necessary evidence, but a claimed or cached PID/PGID never grants signal
authority by itself. The model-writable fixture PID file is used only by the
test driver and never enters the observer.

Outside that L2 gate, an unarmed L1 run can briefly create an SDK-owned
subprocess group while the process is still a descendant of the supervisor.
That subgroup is never signal authority. The observer remembers each exact
identity and treats it as pending:
readiness and quiescence remain false, and fallback cannot kill the supervisor
root, while any pending identity is live. A later complete process-table sample
may clear it only by proving that exact identity is absent or a zombie. Any
parent, group, session, or ancestry change before that positive death evidence
permanently fails containment closed. Once L2 tool containment is armed, only
the authenticated supervisor and fixture groups are permitted; an additional
descendant group rejects readiness.

The runtime creates one immutable monotonic deadline and makes the observer
adopt that same object before the first abort, `Query.close()`, or
`Query.return()`. An SDK-forwarded signal observed before adoption is remembered
but grants no signal authority until the bounded deadline exists. The runtime
then gives the Agent SDK its documented abort and bounded query-close path
first. It does not bind the raw per-run `Options.abortController` to host
signals. Only the SDK-forwarded post-grace `SpawnOptions.signal` can trigger the
fallback. In SDK 0.3.228, `Query.close()` starts cleanup but returns `void`, so
the runtime immediately follows it with and awaits `Query.return()` under the
same deadline. `queryClosed` means that awaitable cleanup settled; invoking
`close()` alone is never completion evidence. Host emergency cleanup starts
only after that cleanup settles, the forwarded signal has already requested the
fallback, or the bounded SDK-grace budget expires. As a compatibility shim
certified only for the pinned Agent SDK 0.3.228, the returned handle accepts the
first SDK `child.kill()` logically by setting `child.killed = true`, but it
intentionally sends no native signal. The hermetic real-SDK loopback test is a
sequence sentinel for 0.3.228's exact close/return behavior: one logical kill,
the SDK-forwarded abort, a second rejected logical kill, return settlement,
then host fallback. An SDK upgrade must remove or recertify the shim before the
pin changes. The forwarded abort signal requests the sampled host fallback;
only freshly validated host group cleanup sends signals. The fallback first
stops the observer-created SDK supervisor group. A new process-table sample
must then revalidate the active root identity, both role identities, their
relationship and shared group, every current root/tool descendant's parent,
group, session, and ancestry, and at least one open lifetime channel. Only that
fresh proof authorizes `SIGSTOP` to the detached fixture group. A second fresh
sample must show both the root and every tool-group member stopped before
`SIGKILL` is sent to the fixture group. A third fresh sample must prove the
fixture group absent before the supervisor group receives `SIGKILL`, and a
fourth must prove that root group absent. Failed stop/kill attempts remain
retryable, but every attempt—including an ESRCH or helper failure—advances the
sample generation and requires another fresh proof. The five-second absolute
deadline bounds the entire sequence.

Deadline expiry seals all evidence collection and ordinary fallback authority.
Disposal has one narrower leak-prevention rule: if this observer successfully
stopped an owned group before sealing, that stopped kernel group cannot execute,
fork, exit, or have its PGID recycled, so disposal may issue its final `SIGKILL`
without a new sample. This never changes a failed deadline result and never
applies to a group that was not stopped while authority was fresh.

If the root exits, a stable identity changes parent/group/session, a foreign
member appears, ancestry is lost, both channels close prematurely, or a
process-table read is unavailable, the observer never signals the detached
group. This includes an inner SDK command exit that reparents a surviving
descendant: an unchanged old PGID does not retain authority after ancestry is
lost. A successful complete table that no longer contains the stable identity
is positive exit evidence; otherwise an escaped same-identity PID and its new
group remain in final liveness accounting. The observer may still stop or kill
its own live SDK supervisor group, but the run remains a fail-closed
`teardown_timeout` while any tool process or lifetime channel remains. This also
prevents numeric PID/PGID reuse from converting cached evidence into authority.
`forceKillIssued` describes only owned SDK supervisor roots and is not required
when SDK graceful shutdown succeeds.

If an exact Bash launch is armed and the query settles before readiness—by
throwing, clean iterator completion, or an SDK error result—its registration
task is not discarded. Readiness, SDK abort/close/return, owned-root fallback,
and death confirmation share one absolute five-second clock. Such an early
settlement never fabricates `cancellationRequested`. Safe L2 completion requires
that both authenticated lifetime channels were observed, both closed, and a
fresh table/liveness sample found no member of the observed fixture group. A
missing channel, an open channel, or a live observed group produces
`teardown_timeout`; later test/campaign-owned cleanup cannot turn that result
into a pass. Workspace snapshots and result assembly occur afterward. The
close-deadline timer remains referenced so a CLI host cannot exit before
cleanup and result reporting finish.

An unavailable or timed-out process table is explicit unknown evidence, never
an empty process table. Closed pending registrations release their role so the
trusted fixture may retry; duplicate live roles fail closed. A capability holder
can at worst deny certification—it cannot make the host signal an unrelated
group. Invalid observation, unknown group liveness, exhausted signal retries,
and Windows all fail closed. Windows live L2 is rejected before the query or
credential is opened. The detached-group path is limited to this exact fixture;
universal Bash containment, other command shapes, Windows Job Objects, and
production recovery belong to later epics, and this probe does not claim those
guarantees.

The disposable fixture uses a host-owned lifetime lease outside the writable
workspace. The lease exists before launch; `shutdown` contents or a missing
lease both make the fixture parent stop its child and exit. Cleanup can therefore
remove the temporary root without turning a startup race into a permanently
running process.

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
