# `searchindex` — provisioned search indexes with auto-embedding

Upstash Search behind the Sapiom gateway: create an index, upsert JSON
documents, and query them with combined full-text + semantic search. Documents
are auto-embedded server-side — there is no embedding pipeline to run.

Not to be confused with the `search` namespace (web search / page scrape /
email lookup): `searchindex` is a data store you fill and query.

## Usage

```ts
import { searchindex } from "@sapiom/tools"; // ambient auth
// or: ctx.sapiom.searchindex inside a workflow step
// or: createClient({ apiKey }).searchindex

// Control plane — create/list/get/update/delete indexes.
const idx = await searchindex.create({ name: "docs-corpus" }); // no ttl: long-lived

// Data plane — the returned handle is bound to the index's own URL.
await idx.upsert([
  {
    id: "getting-started",
    content: { title: "Get Started", body: "…" }, // auto-embedded
    metadata: { url: "https://docs.example.com/", contentHash: "…" }, // NOT embedded
  },
]);

const hits = await idx.query({ query: "how do I authenticate?", limit: 3 });
// hits: [{ id, content, metadata, score }] — best first

// Reconciliation: enumerate everything, page by page. Range items carry only
// `id` unless you ask for payloads — `includeMetadata: true` is the
// hash-diff reconciler's flag (verified against the live data plane).
let cursor: string | null = null;
do {
  const page = await idx.range({
    cursor: cursor ?? undefined,
    limit: 100,
    includeMetadata: true,
  });
  // page.documents[].metadata.contentHash → diff against fresh hashes
  cursor = page.nextCursor;
} while (cursor);

await idx.deleteDocuments(["stale-doc"]);

// Resolve an existing index by name:
const again = (await searchindex.list()).find((i) => i.name === "docs-corpus");
```

## Semantics worth knowing

- **`content` is embedded, `metadata` is not.** Put searchable text in
  `content`; put bookkeeping (URLs, hashes, timestamps) in `metadata` so it
  doesn't pollute relevance.
- **`ttl` means reaping.** An index created with `ttl` (max 30d) is deleted
  when it expires. Omit `ttl` for anything long-lived; `update(id,
  { expiresAt })` adjusts expiry later.
- **`indexName` is a namespace** inside the index (default `"default"`). Most
  callers never set it.
- **`delete(id)` destroys the whole index and all its data.** Use the handle's
  `deleteDocuments(ids)` for document-level deletes.
- Errors throw `SearchIndexHttpError` carrying `status` + parsed `body`. A 404
  also covers ownership mismatches; 422 is the per-account index limit (50).

## Pricing

Data-plane operations are priced **per request, not per document** — batch your
upserts:

| Operation                                            | Price     |
| ---------------------------------------------------- | --------- |
| `upsert` / `query` / `range` / `fetchDocuments` / `deleteDocuments` | $0.000050 |
| `query` with `reranking: true`                        | +$0.001   |
| Control plane (create/get/list/update/delete)         | identity-first (nominal) |
