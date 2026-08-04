# The two Sapiom MCP servers

Sapiom has a local authoring MCP and a hosted direct-capability MCP. They are
different surfaces. Keep their client aliases distinct:

|                | **Local authoring MCP**                                             | **Hosted capability MCP**                                                              |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Client alias   | `sapiom`                                                            | `sapiom-direct`                                                                        |
| Implementation | `npx -y @sapiom/mcp` over stdio                                     | `https://api.sapiom.ai/v1/mcp` over HTTP                                               |
| Wire identity  | `sapiom-dev`                                                        | Inspect the current MCP handshake                                                      |
| Primary tools  | `sapiom_dev_*` authoring lifecycle plus authentication and feedback | Discover the current direct-capability inventory with `tools/list` and `tool_discover` |
| Use it to…     | Build, check, test, deploy, run, and inspect an agent               | Call a hosted capability directly                                                      |

The alias is client-local configuration. The local package continues to report
`sapiom-dev` in its MCP handshake even though the supported registration alias
is `sapiom`.

## Local authoring MCP

Register the published package in Claude Code:

```sh
claude mcp add sapiom -- npx -y @sapiom/mcp
```

The local server scaffolds agent projects, validates them, and runs them against
local stubs. `scaffold`, `check`, and `run_local` do not require Sapiom
authentication. Local Run creates no Sapiom capability request or spend, but it
executes the agent's ordinary JavaScript, including its file, process, and
network side effects.

`link`, `deploy`, production `run`, inspection, schedules, and signals are
authenticated cloud actions. A production run can make metered capability
calls from the agent's `ctx.sapiom.*` step code.

The server exposes authoring operations rather than duplicating every
capability. Add capabilities to typed agent code through `@sapiom/tools`;
use the hosted MCP only when a client needs to call a capability directly.

## Hosted capability MCP

Register the hosted endpoint under `sapiom-direct` so it can coexist with the
local `sapiom` alias:

```sh
export SAPIOM_API_KEY="your-api-key"
claude mcp add --scope user --transport http sapiom-direct https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"
```

This configuration stores the expanded header value in the Claude Code MCP
configuration. Do not share raw MCP server diagnostics. Discover the endpoint's
current tools at runtime instead of relying on a fixed count.

For maintained public setup and boundary guidance, read
[Connect Claude Code with MCP](https://docs.sapiom.ai/guides/connect-claude-code-with-mcp)
and [Hosted capability MCP](https://docs.sapiom.ai/integration/mcp-servers/remote).
