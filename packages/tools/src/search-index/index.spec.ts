import { Transport } from "../_client/index.js";
import * as searchindex from "./index.js";
import { SearchIndexHttpError } from "./index.js";
import type { SearchIndex } from "./index.js";

// Capability fns are tested directly with a real Transport plus a scripted fetch
// mock, so URL/method/header/body assertions are exact and we verify the Transport
// injects the tenant credential on the gateway-direct default header
// (x-sapiom-api-key) for BOTH planes — control (management gateway) and data
// (the index's own URL).

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  apiKey: string | undefined = "test-key",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler({ url, init });
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const BASE = "https://upstash.test";
const DATA_URL = "https://res_abc123.search.data.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];
const bodyOf = (c: FetchCall) => JSON.parse(c.init.body as string);

const indexDto = (overrides: Record<string, unknown> = {}) => ({
  id: "res_abc123",
  type: "search",
  name: "docs-corpus",
  status: "active",
  url: DATA_URL,
  region: "us-central1",
  expiresAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

/** Build a bound handle by round-tripping `create` against a mocked gateway. */
async function makeHandle(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
): Promise<{ idx: SearchIndex; calls: FetchCall[] }> {
  const { transport, calls } = makeTransport([
    (c) =>
      c.url === `${BASE}/v1/search/indexes` && c.init.method === "POST"
        ? jsonResponse(indexDto(), { status: 201 })
        : undefined,
    ...handlers,
  ]);
  const idx = await searchindex.create(
    { name: "docs-corpus" },
    transport,
    BASE,
  );
  calls.length = 0; // drop the create call; tests assert data-plane calls only
  return { idx, calls };
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

describe("searchindex.create()", () => {
  it("POSTs /v1/search/indexes on x-sapiom-api-key and returns a bound handle", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto(), { status: 201 }),
    ]);

    const idx = await searchindex.create(
      { name: "docs-corpus", region: "us-central1", ttl: "7d" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes`);
    expect(calls[0]!.init.method).toBe("POST");
    // Gateway-direct surface — credential rides the default x-sapiom-api-key.
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({
      name: "docs-corpus",
      region: "us-central1",
      ttl: "7d",
    });

    expect(idx.id).toBe("res_abc123");
    expect(idx.name).toBe("docs-corpus");
    expect(idx.status).toBe("active");
    expect(idx.url).toBe(DATA_URL);
    expect(idx.expiresAt).toBeNull();
    expect(typeof idx.upsert).toBe("function");
    expect(typeof idx.query).toBe("function");
    expect(typeof idx.range).toBe("function");
    expect(typeof idx.fetchDocuments).toBe("function");
    expect(typeof idx.deleteDocuments).toBe("function");
  });

  it("omits region/ttl from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto(), { status: 201 }),
    ]);
    await searchindex.create({ name: "docs-corpus" }, transport, BASE);
    expect(bodyOf(calls[0]!)).toEqual({ name: "docs-corpus" });
  });

  it("throws before fetching on a missing name", async () => {
    const { transport, calls } = makeTransport([]);
    await expect(
      searchindex.create({ name: "" }, transport, BASE),
    ).rejects.toBeInstanceOf(SearchIndexHttpError);
    expect(calls).toHaveLength(0);
  });

  it("throws before fetching on a malformed ttl", async () => {
    const { transport, calls } = makeTransport([]);
    await expect(
      searchindex.create({ name: "x", ttl: "1 week" }, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws SearchIndexHttpError with status + body on a non-2xx (e.g. 422 limit)", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({
            error: "resource_limit_exceeded",
            message: "Maximum 50 Search databases per account",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
    ]);
    await expect(
      searchindex.create({ name: "docs-corpus" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "SearchIndexHttpError",
      status: 422,
      body: { error: "resource_limit_exceeded" },
    });
  });
});

describe("searchindex.get() / list() / update() / delete()", () => {
  it("GETs /v1/search/indexes/:id (URL-encoded) and binds the handle", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(indexDto())]);
    const idx = await searchindex.get("res_abc123", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes/res_abc123`);
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(idx.url).toBe(DATA_URL);
    expect(typeof idx.range).toBe("function");
  });

  it("lists indexes as bound handles and tolerates a non-array response", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.url === `${BASE}/v1/search/indexes`
          ? jsonResponse([indexDto(), indexDto({ id: "res_def456", name: "other" })])
          : undefined,
    ]);
    const all = await searchindex.list(transport, BASE);
    expect(all).toHaveLength(2);
    expect(all[0]!.name).toBe("docs-corpus");
    expect(typeof all[1]!.upsert).toBe("function");

    const { transport: t2 } = makeTransport([() => jsonResponse({})]);
    expect(await searchindex.list(t2, BASE)).toEqual([]);
  });

  it("PATCHes only the provided fields on update", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto({ expiresAt: "2027-01-01T00:00:00.000Z" })),
    ]);
    const idx = await searchindex.update(
      "res_abc123",
      { expiresAt: "2027-01-01T00:00:00.000Z" },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes/res_abc123`);
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(bodyOf(calls[0]!)).toEqual({ expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(idx.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("DELETEs the index and accepts a 204 with no body", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      searchindex.delete("res_abc123", transport, BASE),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes/res_abc123`);
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("surfaces a 404 (not-found / ownership mismatch) as SearchIndexHttpError", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(
      searchindex.get("res_missing", transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Data plane (via the bound handle)
// ---------------------------------------------------------------------------

describe("SearchIndex.upsert()", () => {
  it("POSTs the documents ARRAY verbatim to {url}/upsert/default", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ result: "Success" }),
    ]);
    const docs = [
      {
        id: "getting-started",
        content: { title: "Get Started", body: "…" },
        metadata: { url: "https://docs.example.com/", contentHash: "abc" },
      },
    ];
    await idx.upsert(docs);
    expect(calls[0]!.url).toBe(`${DATA_URL}/upsert/default`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    // The body is the bare array — the gateway forwards it verbatim.
    expect(bodyOf(calls[0]!)).toEqual(docs);
  });

  it("targets a custom indexName namespace", async () => {
    const { idx, calls } = await makeHandle([() => jsonResponse({})]);
    await idx.upsert([{ id: "a", content: { t: 1 } }], {
      indexName: "articles",
    });
    expect(calls[0]!.url).toBe(`${DATA_URL}/upsert/articles`);
  });

  it("throws before fetching on an empty documents array or bad indexName", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.upsert([])).rejects.toMatchObject({ status: 400 });
    await expect(
      idx.upsert([{ id: "a", content: {} }], { indexName: "bad name!" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe("SearchIndex.query()", () => {
  const hits = [
    {
      id: "getting-started",
      content: { title: "Get Started" },
      metadata: { url: "https://docs.example.com/" },
      score: 0.92,
    },
    { id: "verify", content: { title: "Verify Users" } },
  ];

  it("POSTs {url}/search/default with query/limit/reranking/filter and maps hits", async () => {
    const { idx, calls } = await makeHandle([() => jsonResponse(hits)]);
    const results = await idx.query({
      query: "how do I authenticate?",
      limit: 3,
      reranking: true,
      filter: "tags = 'auth'",
    });
    expect(calls[0]!.url).toBe(`${DATA_URL}/search/default`);
    expect(bodyOf(calls[0]!)).toEqual({
      query: "how do I authenticate?",
      limit: 3,
      reranking: true,
      filter: "tags = 'auth'",
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "getting-started",
      content: { title: "Get Started" },
      metadata: { url: "https://docs.example.com/" },
      score: 0.92,
    });
    expect(results[1]!.score).toBeUndefined();
  });

  it("unwraps a { result: [...] } envelope", async () => {
    const { idx } = await makeHandle([() => jsonResponse({ result: hits })]);
    const results = await idx.query({ query: "verify" });
    expect(results.map((h) => h.id)).toEqual(["getting-started", "verify"]);
  });

  it("returns [] for a non-array response and drops malformed hits", async () => {
    const { idx } = await makeHandle([
      () => jsonResponse({ result: [{ notAnId: true }, hits[0]] }),
    ]);
    const results = await idx.query({ query: "x" });
    expect(results.map((h) => h.id)).toEqual(["getting-started"]);

    const { idx: idx2 } = await makeHandle([() => jsonResponse("weird")]);
    expect(await idx2.query({ query: "x" })).toEqual([]);
  });

  it("throws before fetching on an empty query", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.query({ query: "" })).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("SearchIndex.range()", () => {
  it("POSTs {url}/range/default with cursor/limit and maps the page", async () => {
    const { idx, calls } = await makeHandle([
      () =>
        jsonResponse({
          nextCursor: "42",
          documents: [
            { id: "a", content: { t: 1 }, metadata: { contentHash: "h1" } },
            { id: "b", content: { t: 2 } },
          ],
        }),
    ]);
    const page = await idx.range({ cursor: "0", limit: 100 });
    expect(calls[0]!.url).toBe(`${DATA_URL}/range/default`);
    expect(bodyOf(calls[0]!)).toEqual({ cursor: "0", limit: 100 });
    expect(page.nextCursor).toBe("42");
    expect(page.documents.map((d) => d.id)).toEqual(["a", "b"]);
    expect(page.documents[0]!.metadata).toEqual({ contentHash: "h1" });
  });

  it("sends an empty body on the first page and normalizes an empty nextCursor to null", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ nextCursor: "", documents: [] }),
    ]);
    const page = await idx.range();
    expect(bodyOf(calls[0]!)).toEqual({});
    expect(page).toEqual({ nextCursor: null, documents: [] });
  });
});

describe("SearchIndex.fetchDocuments() / deleteDocuments()", () => {
  it("POSTs {url}/fetch/default with ids and preserves nulls for misses", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse([{ id: "a", content: { t: 1 } }, null]),
    ]);
    const docs = await idx.fetchDocuments(["a", "missing"]);
    expect(calls[0]!.url).toBe(`${DATA_URL}/fetch/default`);
    expect(bodyOf(calls[0]!)).toEqual({ ids: ["a", "missing"] });
    expect(docs[0]!.id).toBe("a");
    expect(docs[1]).toBeNull();
  });

  it("DELETEs {url}/delete/default with the ids body", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ deleted: 2 }),
    ]);
    await idx.deleteDocuments(["a", "b"]);
    expect(calls[0]!.url).toBe(`${DATA_URL}/delete/default`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(bodyOf(calls[0]!)).toEqual({ ids: ["a", "b"] });
  });

  it("throws before fetching on empty ids", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.fetchDocuments([])).rejects.toMatchObject({ status: 400 });
    await expect(idx.deleteDocuments([])).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toHaveLength(0);
  });

  it("surfaces a data-plane 404 (ownership mismatch) as SearchIndexHttpError", async () => {
    const { idx } = await makeHandle([
      () =>
        new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(idx.fetchDocuments(["a"])).rejects.toMatchObject({
      name: "SearchIndexHttpError",
      status: 404,
    });
  });
});
