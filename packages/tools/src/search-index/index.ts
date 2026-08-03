/**
 * `searchindex` capability — provisioned Upstash Search indexes with
 * auto-embedding: full-text + semantic search over JSON documents, no embedding
 * pipeline to run. Distinct from the `search` namespace (web search / scrape);
 * this one is a data store you fill and query.
 *
 *   import { searchindex } from "@sapiom/tools";            // ambient auth
 *   const idx = await searchindex.create({ name: "docs-corpus" });
 *   await idx.upsert([
 *     { id: "getting-started", content: { title: "Get Started", body: "…" },
 *       metadata: { url: "https://docs.example.com/", contentHash: "…" } },
 *   ]);
 *   const hits = await idx.query({ query: "how do I authenticate?", limit: 3 });
 *   hits[0]?.id;                                            // best-matching document
 *
 *   const again = await searchindex.get(idx.id);            // re-bind by id
 *   const all = await searchindex.list();                   // every index you own
 *   const page = await again.range({ limit: 100 });         // enumerate documents
 *
 * Or via an explicit client / a workflow step: `ctx.sapiom.searchindex.create(...)`.
 *
 * Two planes, one handle. The control plane (create/get/list/update/delete)
 * lives on the management gateway; `create`/`get`/`list` return a
 * {@link SearchIndex} handle whose data-plane operations
 * (upsert/query/range/fetchDocuments/deleteDocuments) are bound to that index's
 * own data-plane URL (`https://<id>.search.data.sapiom.ai`). Documents are
 * auto-embedded from `content` server-side; `metadata` is stored verbatim and
 * NOT embedded — put bookkeeping there (URLs, content hashes), never in
 * `content`.
 *
 * Lifetime: indexes created with a `ttl` expire and are REAPED (max ttl 30d).
 * Omit `ttl` for a long-lived index (e.g. a docs corpus); `update(id,
 * { expiresAt })` can extend or set expiry later.
 *
 * Pricing (per request, not per document): upsert / query / range /
 * fetchDocuments / deleteDocuments are $0.000050 each; `query` with
 * `reranking: true` adds a $0.001 surcharge. Control-plane calls are
 * identity-first (nominal). Batch upserts — one call with 50 documents costs
 * the same as one call with 1.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, SearchIndexHttpError } from "./errors.js";

export { SearchIndexHttpError };

const DEFAULT_BASE_URL = resolveServiceUrl(
  "upstash",
  process.env.SAPIOM_SEARCHINDEX_URL,
);

// ----- Types -----

/** Lifecycle state of a search index. */
export type SearchIndexStatus =
  | "provisioning"
  | "active"
  | "expired"
  | "deleting"
  | "deleted";

export interface CreateSearchIndexInput {
  /** Index name (1–128 chars). Not unique server-side — prefer distinctive names. */
  name: string;
  /** Optional region (default: us-central1; eu-west-1 also available). */
  region?: string;
  /**
   * Optional time-to-live, e.g. `"1h"`, `"24h"`, `"7d"` (max 30 days). An
   * expired index is deleted by a reaper — OMIT for a long-lived index.
   */
  ttl?: string;
}

export interface UpdateSearchIndexInput {
  /** New display name (1–128 chars). */
  name?: string;
  /** New ISO-8601 expiry (must be in the future), e.g. to extend a ttl. */
  expiresAt?: string;
}

/** Read-only metadata for a search index. */
export interface SearchIndexInfo {
  /** Unique index id (`res_…`) — also the subdomain of the data-plane URL. */
  id: string;
  /** Display name. */
  name: string;
  /** Lifecycle state. */
  status: SearchIndexStatus;
  /** The index's own data-plane base URL (`https://<id>.search.data.sapiom.ai`). */
  url: string;
  /** Region the index is provisioned in. */
  region: string;
  /** ISO-8601 expiry, or `null` when the index does not expire. */
  expiresAt: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** One document to store: `content` is auto-embedded, `metadata` is not. */
export interface SearchDocument {
  /** Unique document id within the index. */
  id: string;
  /** The searchable fields (auto-embedded server-side), e.g. `{ title, body }`. */
  content: Record<string, unknown>;
  /** Stored verbatim, never embedded — URLs, content hashes, timestamps, … */
  metadata?: Record<string, unknown>;
}

/** One search result. `score` is higher-is-better relevance when present. */
export interface SearchHit {
  id: string;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface SearchQueryInput {
  /** The search query (semantic + full-text). */
  query: string;
  /** Max results to return (1–1000). */
  limit?: number;
  /** Re-rank results server-side for better relevance (+$0.001 per query). */
  reranking?: boolean;
  /** Optional metadata filter expression. */
  filter?: string;
}

export interface SearchIndexRangeInput {
  /** Opaque pagination cursor from a previous page (start with none or `"0"`). */
  cursor?: string;
  /** Page size. */
  limit?: number;
}

/** One page of documents. Keep calling with `nextCursor` until it is null/empty. */
export interface SearchIndexRangeResult {
  nextCursor: string | null;
  documents: SearchDocument[];
}

/** Options accepted by every data-plane operation. */
export interface DataPlaneOptions {
  /**
   * The namespace inside the index to operate on (alphanumeric, `-`, `_`).
   * Defaults to `"default"` — most callers never set this.
   */
  indexName?: string;
}

/**
 * A bound search-index handle: the index's metadata plus its data-plane
 * operations, each priced per request ($0.000050; query reranking +$0.001).
 */
export interface SearchIndex extends SearchIndexInfo {
  /** Insert or replace documents — ONE priced request regardless of count. */
  upsert(documents: SearchDocument[], opts?: DataPlaneOptions): Promise<void>;
  /** Search the index. Returns ranked hits (best first). */
  query(input: SearchQueryInput, opts?: DataPlaneOptions): Promise<SearchHit[]>;
  /** Enumerate documents page by page — the reconciliation primitive. */
  range(
    input?: SearchIndexRangeInput,
    opts?: DataPlaneOptions,
  ): Promise<SearchIndexRangeResult>;
  /** Fetch specific documents by id (`null` for ids that don't exist). */
  fetchDocuments(
    ids: string[],
    opts?: DataPlaneOptions,
  ): Promise<Array<SearchDocument | null>>;
  /** Delete specific documents by id. */
  deleteDocuments(ids: string[], opts?: DataPlaneOptions): Promise<void>;
}

// ----- Internal wire shapes -----

/** The gateway's `SearchDatabaseResponse` DTO. */
interface RawSearchIndexResponse {
  id: string;
  type?: string;
  name: string;
  status: string;
  url: string;
  region: string;
  expiresAt: string | null;
  createdAt: string;
}

function mapInfo(raw: RawSearchIndexResponse): SearchIndexInfo {
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status as SearchIndexStatus,
    url: raw.url,
    region: raw.region,
    expiresAt: raw.expiresAt ?? null,
    createdAt: raw.createdAt,
  };
}

const INDEX_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TTL_PATTERN = /^\d+[mhd]$/;

function resolveIndexName(opts?: DataPlaneOptions): string {
  const indexName = opts?.indexName ?? "default";
  if (!INDEX_NAME_PATTERN.test(indexName)) {
    throw new SearchIndexHttpError(
      `indexName must match ${INDEX_NAME_PATTERN} (got "${indexName}")`,
      400,
      { indexName },
    );
  }
  return indexName;
}

/**
 * Unwrap an Upstash data-plane response defensively: the API returns either the
 * value directly or wrapped as `{ result: value }` depending on the endpoint.
 */
function unwrapResult(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "result" in raw) {
    return (raw as { result: unknown }).result;
  }
  return raw;
}

function toDocument(raw: unknown): SearchDocument | null {
  if (!raw || typeof raw === "string" || typeof raw !== "object") return null;
  const doc = raw as {
    id?: unknown;
    content?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  if (typeof doc.id !== "string") return null;
  return {
    id: doc.id,
    content: doc.content ?? {},
    ...(doc.metadata !== undefined && { metadata: doc.metadata }),
  };
}

function toHit(raw: unknown): SearchHit | null {
  const doc = toDocument(raw);
  if (!doc) return null;
  const score = (raw as { score?: unknown }).score;
  return {
    ...doc,
    ...(typeof score === "number" && { score }),
  };
}

async function dataPlaneJson(
  transport: Transport,
  url: string,
  init: RequestInit,
  errorPrefix: string,
): Promise<unknown> {
  const res = await ensureOk(await transport.fetch(url, init), errorPrefix);
  if (res.status === 204) return undefined;
  const text = await res.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ----- The handle -----

/** Bind an index's data-plane operations to its own URL. */
function bindIndex(info: SearchIndexInfo, transport: Transport): SearchIndex {
  return {
    ...info,

    async upsert(documents, opts) {
      if (!Array.isArray(documents) || documents.length === 0) {
        throw new SearchIndexHttpError(
          "upsert requires at least one document",
          400,
          undefined,
        );
      }
      const indexName = resolveIndexName(opts);
      // The gateway forwards the array body verbatim and remaps to Upstash's
      // auto-embedding upsert. Priced per REQUEST — batch your documents.
      await dataPlaneJson(
        transport,
        `${info.url}/upsert/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(documents),
        },
        `Failed to upsert into search index '${info.id}'`,
      );
    },

    async query(input, opts) {
      if (!input?.query) {
        throw new SearchIndexHttpError(
          "query requires a non-empty query string",
          400,
          undefined,
        );
      }
      const indexName = resolveIndexName(opts);
      const body: Record<string, unknown> = { query: input.query };
      if (input.limit != null) body.limit = input.limit;
      if (input.reranking != null) body.reranking = input.reranking;
      if (input.filter != null) body.filter = input.filter;

      const raw = await dataPlaneJson(
        transport,
        `${info.url}/search/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        `Failed to query search index '${info.id}'`,
      );
      const results = unwrapResult(raw);
      if (!Array.isArray(results)) return [];
      return results
        .map(toHit)
        .filter((hit): hit is SearchHit => hit !== null);
    },

    async range(input, opts) {
      const indexName = resolveIndexName(opts);
      const body: Record<string, unknown> = {};
      if (input?.cursor != null) body.cursor = input.cursor;
      if (input?.limit != null) body.limit = input.limit;

      const raw = await dataPlaneJson(
        transport,
        `${info.url}/range/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        `Failed to range search index '${info.id}'`,
      );
      const page = unwrapResult(raw) as
        | { nextCursor?: unknown; documents?: unknown }
        | undefined;
      const documents = Array.isArray(page?.documents)
        ? page.documents
            .map(toDocument)
            .filter((doc): doc is SearchDocument => doc !== null)
        : [];
      const nextCursor =
        typeof page?.nextCursor === "string" && page.nextCursor !== ""
          ? page.nextCursor
          : null;
      return { nextCursor, documents };
    },

    async fetchDocuments(ids, opts) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new SearchIndexHttpError(
          "fetchDocuments requires at least one id",
          400,
          undefined,
        );
      }
      const indexName = resolveIndexName(opts);
      const raw = await dataPlaneJson(
        transport,
        `${info.url}/fetch/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        },
        `Failed to fetch documents from search index '${info.id}'`,
      );
      const results = unwrapResult(raw);
      if (!Array.isArray(results)) return ids.map(() => null);
      return results.map(toDocument);
    },

    async deleteDocuments(ids, opts) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new SearchIndexHttpError(
          "deleteDocuments requires at least one id",
          400,
          undefined,
        );
      }
      const indexName = resolveIndexName(opts);
      await dataPlaneJson(
        transport,
        `${info.url}/delete/${indexName}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        },
        `Failed to delete documents from search index '${info.id}'`,
      );
    },
  };
}

// ----- Control-plane operations -----

/**
 * Create a search index and return its bound handle. Omit `ttl` for a
 * long-lived index — expired indexes are reaped. Failed requests throw
 * {@link SearchIndexHttpError} (422 when the per-account index limit is hit).
 */
export async function create(
  input: CreateSearchIndexInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex> {
  if (!input?.name || input.name.length > 128) {
    throw new SearchIndexHttpError(
      "create requires a name of 1-128 characters",
      400,
      { name: input?.name },
    );
  }
  if (input.ttl !== undefined && !TTL_PATTERN.test(input.ttl)) {
    throw new SearchIndexHttpError(
      `ttl must match ${TTL_PATTERN} (e.g. "1h", "24h", "7d"), got "${input.ttl}"`,
      400,
      { ttl: input.ttl },
    );
  }
  const body: Record<string, unknown> = { name: input.name };
  if (input.region !== undefined) body.region = input.region;
  if (input.ttl !== undefined) body.ttl = input.ttl;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/search/indexes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to create search index",
  );
  return bindIndex(mapInfo((await res.json()) as RawSearchIndexResponse), transport);
}

/** Retrieve a search index by id and return its bound handle. */
export async function get(
  id: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex> {
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/search/indexes/${encodeURIComponent(id)}`,
    ),
    `Failed to get search index '${id}'`,
  );
  return bindIndex(mapInfo((await res.json()) as RawSearchIndexResponse), transport);
}

/**
 * List your active search indexes as bound handles. Read-only — useful for
 * resolving an index by name before operating on it:
 *
 *   const idx = (await searchindex.list()).find((i) => i.name === "docs-corpus");
 */
export async function list(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex[]> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/search/indexes`),
    "Failed to list search indexes",
  );
  const raw = (await res.json()) as RawSearchIndexResponse[];
  return Array.isArray(raw)
    ? raw.map((r) => bindIndex(mapInfo(r), transport))
    : [];
}

/** Update an index's `name` and/or `expiresAt`; returns the updated handle. */
export async function update(
  id: string,
  input: UpdateSearchIndexInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex> {
  const body: Record<string, unknown> = {};
  if (input?.name !== undefined) body.name = input.name;
  if (input?.expiresAt !== undefined) body.expiresAt = input.expiresAt;

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/search/indexes/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    `Failed to update search index '${id}'`,
  );
  return bindIndex(mapInfo((await res.json()) as RawSearchIndexResponse), transport);
}

/**
 * Delete a whole index and ALL its data (idempotent server-side). For deleting
 * individual documents use the handle's `deleteDocuments`. Exported as `delete`:
 * `await searchindex.delete(id)`.
 */
async function deleteIndex(
  id: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/search/indexes/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
    `Failed to delete search index '${id}'`,
  );
}

export { deleteIndex as delete };
