---
"@sapiom/tools": minor
---

Add the `searchindex` namespace (`ctx.sapiom.searchindex`) and `search.map()` (SAP-2255).

`searchindex` covers the full priced Upstash Search surface behind the Sapiom
gateway — control plane `create`/`get`/`list`/`update`/`delete`, with
`create`/`get`/`list` returning a bound `SearchIndex` handle carrying the
data-plane operations (`upsert`/`query`/`range`/`fetchDocuments`/
`deleteDocuments`) against the index's own `*.search.data.sapiom.ai` URL.
Documents are `{ id, content, metadata? }` — `content` is auto-embedded
server-side, `metadata` is stored verbatim (put URLs/content-hashes there).
`range` is the enumeration/reconciliation primitive; data-plane calls are
priced per request ($0.000050; `query` reranking +$0.001). Errors throw the new
`SearchIndexHttpError`.

`search.map({ url })` exposes Firecrawl site mapping ($0.009 flat) with
structured `{ links: [{ url, title?, description? }] }` output — gateway-direct,
since `/v2/map` is not a routed capability.

Both are wired into the `Sapiom` client interface, `bind()`, the barrel, the
`./search-index` subpath export, and the stub client (stateful in-memory
indexes, so `run_local` exercises upsert → query/range/fetch/delete flows
deterministically).
