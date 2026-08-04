# @sapiom/mcp

The **local authoring** MCP server for Sapiom. It runs on your machine over
stdio and reports the wire identity `sapiom-dev`. Register it in your client
under the supported alias `sapiom`. Its `sapiom_dev_*` tools let a coding
agent scaffold, test, deploy, and inspect Sapiom agents.

> **Not the capability surface.** This is _not_ the remote "Sapiom" MCP (the
> hosted connector with `sapiom_sandbox_*`, scrape, search, … capability tools).
> The local server exposes no direct capability tools. Local Run creates no
> Sapiom capability request or spend, but authored JavaScript and its ordinary
> side effects still run. Cloud actions authenticate separately and a production
> run can make metered capability calls. See
> [the two Sapiom MCP servers](../../docs/mcp-servers.md) for which to use when.

## Install

No global install is required. In Claude Code:

```sh
claude mcp add sapiom -- npx -y @sapiom/mcp
```

The registration alias is `sapiom`; the package's MCP handshake still reports
the server identity `sapiom-dev`.

## Configuration

The server targets the `production` environment by default. Register a
staging-specific local server with:

```sh
claude mcp add sapiom -e SAPIOM_ENVIRONMENT=staging -- npx -y @sapiom/mcp
```

- `production` (alias `prod`) → `app.sapiom.ai` / `api.sapiom.ai` — the default.
- `staging` (alias `dev`) → `app.sapiom.dev` / `api.sapiom.dev`.

Both resolve from built-in presets, so no config file is required. A custom
target can be defined in `~/.sapiom/credentials.json` (the server prints the
expected shape if it encounters an unknown environment name).

## Authentication

Cloud operations such as `clone`, `link`, `deploy`, production `run`,
`inspect`, schedules, and signals need a Sapiom API key. Run
**`sapiom_authenticate`** and the server opens a browser login flow, then
caches the resulting key per environment in
`~/.sapiom/credentials.json`. After that, tools work without re-authenticating.
`sapiom_status` reports who you're authenticated as; `sapiom_logout` clears the
cached credentials.

The local authoring tools (`scaffold`, `check`, `run_local`) need no
Sapiom authentication. `run_local` replaces `ctx.sapiom.*` calls with
local stubs, but it still executes the agent's ordinary JavaScript and any
file, process, or network side effects that code performs.

## Tools

| Tool                                 | Network | What it does                                                                            |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------- |
| `sapiom_authenticate`                | browser | Log in and cache an API key for the current environment                                 |
| `sapiom_status`                      | —       | Report authentication status                                                            |
| `sapiom_logout`                      | —       | Clear cached credentials                                                                |
| `sapiom_send_feedback`               | ✓       | Relay the user's product feedback to the Sapiom team                                    |
| `sapiom_dev_agents_scaffold`         | —       | Create a new agent project                                                              |
| `sapiom_dev_agents_check`            | —       | Bundle + validate the step graph offline                                                |
| `sapiom_dev_agents_run_local`        | —       | Run the agent locally with stubbed Sapiom capabilities; ordinary side effects still run |
| `sapiom_dev_agents_link`             | ✓       | Resolve or create the hosted agent and cache its definition id                          |
| `sapiom_dev_agents_clone`            | ✓       | Fork a gallery template (or re-clone a fork) into a local project                       |
| `sapiom_dev_agents_deploy`           | ✓       | Push the current commit, build, and wait for it                                         |
| `sapiom_dev_agents_run`              | ✓       | Start a real cloud execution                                                            |
| `sapiom_dev_agents_inspect`          | ✓       | Inspect an execution or build (optionally waiting for it)                               |
| `sapiom_dev_agents_signal`           | ✓       | Resume a paused execution by delivering a signal                                        |
| `sapiom_dev_agents_schedule`         | ✓       | Create a recurring (cron) or one-off schedule for a deployed agent                      |
| `sapiom_dev_agents_schedule_inspect` | ✓       | Inspect one schedule (with fire history) or list an agent's schedules                   |
| `sapiom_dev_agents_schedule_cancel`  | ✓       | Cancel a schedule (stops all future fires)                                              |
| `sapiom_dev_agents_cron_preview`     | ✓       | Validate a cron expression and preview its next occurrences                             |

A typical loop: `scaffold` → write step code → `run_local` until green → `link`
→ `deploy` → `run` → `inspect`.

## How capabilities fit in

Agents authored here call Sapiom capabilities — sandboxes, repositories,
coding agents, search, storage, content generation — through
[`@sapiom/tools`](../tools) (`ctx.sapiom.*`). `run_local` resolves those calls
from stubs; a production run executes them in Sapiom cloud and can incur
capability spend. This MCP never grows a per-capability tool of its own —
capabilities live in `@sapiom/tools` and the hosted MCP registered as
`sapiom-direct`. See
[the positioning doc](../../docs/mcp-servers.md) for the full policy.

## Sending feedback

`sapiom_send_feedback` relays a user's product feedback (a bug, a rough edge, a
feature request) to the Sapiom team. The agent sends only what the user said;
the server attaches package version, platform, arch, node version, environment
and a timestamp itself, so the model never has to read those off the machine.

A host embedding this server can advertise its own version with
**`SAPIOM_HARNESS_VERSION`** — it rides along as `clientMeta.harnessVersion`,
which is what makes "which build is this user on" answerable during triage. The
field is omitted entirely when the variable is unset, never filled with a
placeholder. `@sapiom/harness` sets it automatically.

## Usage analytics

The server emits anonymous usage analytics (one `tool.call` event per tool
invocation: tool name, arguments, duration, ok/error class) via
[`@sapiom/analytics-core`](../analytics-core) to the hosted Sapiom collector
by default. Opt out at any time with `SAPIOM_TELEMETRY_DISABLED=1` or
`DO_NOT_TRACK=1` — either makes the emitter a complete no-op (nothing is sent,
nothing is written to disk). `SAPIOM_ANALYTICS_ENDPOINT` overrides the
destination. Telemetry is a synchronous in-memory enqueue that never throws,
never blocks a tool call, and can never change a tool result.

## License

MIT
