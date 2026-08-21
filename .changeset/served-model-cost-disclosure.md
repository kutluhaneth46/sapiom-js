---
"@sapiom/tools": minor
---

Execution results now expose the server's serving disclosure.

- `models.run` (`ModelRunOutcome`): new optional `servedModel` (wire `served_model`) — the server-reported identifier of the deployment that actually served the final turn, distinct from `modelUsed` (still the requested label/model). **The documented meaning of the existing `costUsd` field changed**: it is now the USD cost as reported by the server (served-deployment-priced when the server disclosed it, the server's estimate otherwise) rather than a flat client-side assumption. The numeric type and presence are unchanged.
- `models.coding.run` (`CodingRunOutcome`): new optional `servedModel` / `costUsd` — currently reported as null by coding servers (unknown), reserved for parity across result shapes.
- `llm.run` / `llm.redeem` / `llm.callSession`: new `LlmDisclosure` type describing the `served_model` / `cost_usd` fields the server injects top-level into raw `/v2` non-streaming response bodies, plus a `readDisclosure()` helper returning the camel-cased `LlmDisclosureResult`. The response `model` field is unchanged and keeps echoing the requested label.
- All result shapes reserve an optional `degradation` annotation, typed `unknown` (server-defined shape, not yet stable; absent on a clean execution).

All additions are optional/nullable: existing consumers compile and run unchanged. On results from older servers the mappers and `readDisclosure` return `servedModel`/`costUsd` as `null` (unknown); `degradation` and the raw body fields are simply absent.
