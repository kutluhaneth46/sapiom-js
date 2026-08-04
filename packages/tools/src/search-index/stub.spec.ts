import { createStubClient } from "../stub/index.js";
import { SearchIndexHttpError } from "./index.js";

describe("searchindex stateful stub", () => {
  it("matches pagination and payload-inclusion semantics", async () => {
    const sapiom = createStubClient();
    const index = await sapiom.searchindex.create({
      name: "docs-corpus",
      region: "eu-west-1",
      ttl: "7d",
    });

    expect(index.region).toBe("eu-west-1");
    expect(index.expiresAt).not.toBeNull();
    await index.upsert([
      {
        id: "a",
        content: { title: "Alpha" },
        metadata: { contentHash: "h1" },
      },
      {
        id: "b",
        content: { title: "Beta" },
        metadata: { contentHash: "h2" },
      },
      {
        id: "c",
        content: { title: "Gamma" },
        metadata: { contentHash: "h3" },
      },
    ]);

    const first = await index.range({ limit: 2 });
    expect(first).toEqual({
      nextCursor: "2",
      documents: [{ id: "a" }, { id: "b" }],
    });

    const second = await index.range({
      cursor: first.nextCursor!,
      limit: 2,
      includeMetadata: true,
      includeData: true,
    });
    expect(second).toEqual({
      nextCursor: null,
      documents: [
        {
          id: "c",
          content: { title: "Gamma" },
          metadata: { contentHash: "h3" },
        },
      ],
    });

    await expect(
      index.fetchDocuments(["a", "missing"], { includeMetadata: true }),
    ).resolves.toEqual([{ id: "a", metadata: { contentHash: "h1" } }, null]);
    await expect(index.query({ query: "beta" })).resolves.toMatchObject([
      { id: "b", content: { title: "Beta" }, score: 1 },
    ]);
  });

  it("uses the same fail-fast validation matrix as the live client", async () => {
    const sapiom = createStubClient();
    await expect(sapiom.searchindex.create({ name: "" })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(
      sapiom.searchindex.create({ name: "docs", ttl: "31d" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(sapiom.searchindex.get("")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      sapiom.searchindex.update("", { name: "docs" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(sapiom.searchindex.delete("")).rejects.toMatchObject({
      status: 400,
    });

    const index = await sapiom.searchindex.create({ name: "docs" });
    await expect(index.upsert([])).rejects.toMatchObject({ status: 400 });
    await expect(
      index.upsert([{ id: "bad", content: null } as never]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      index.upsert([{ id: "bad", content: {} }], { indexName: "bad name!" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(index.query({ query: " ", limit: 0 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.range({ cursor: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.range({ limit: 1001 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      index.range({ includeMetadata: "yes" } as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(index.fetchDocuments([])).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.fetchDocuments([""])).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.deleteDocuments([""])).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      sapiom.searchindex.update(index.id, { name: "" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sapiom.searchindex.update(index.id, {
        expiresAt: "January 1, 2099",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 404 for unknown resources and invalidates handles after deletion", async () => {
    const sapiom = createStubClient();
    await expect(sapiom.searchindex.get("res_missing")).rejects.toEqual(
      expect.objectContaining({ name: "SearchIndexHttpError", status: 404 }),
    );
    await expect(
      sapiom.searchindex.update("res_missing", { name: "renamed" }),
    ).rejects.toBeInstanceOf(SearchIndexHttpError);
    await expect(
      sapiom.searchindex.delete("res_missing"),
    ).rejects.toMatchObject({
      status: 404,
    });

    const index = await sapiom.searchindex.create({ name: "docs" });
    await sapiom.searchindex.delete(index.id);
    const staleHandleCalls = [
      () => index.upsert([{ id: "a", content: {} }]),
      () => index.query({ query: "anything" }),
      () => index.range(),
      () => index.fetchDocuments(["a"]),
      () => index.deleteDocuments(["a"]),
    ];
    for (const call of staleHandleCalls) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
    // The live control plane treats a repeated delete of the same retained row
    // as an idempotent terminal retry.
    await expect(sapiom.searchindex.delete(index.id)).resolves.toBeUndefined();
  });
});
