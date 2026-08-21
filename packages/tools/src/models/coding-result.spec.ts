/**
 * coding.run — terminal wire-result mapping, including the serving-disclosure
 * fields. Coding servers currently emit `served_model`/`cost_usd` as null
 * (they cannot observe them yet) and older servers omit them entirely — both
 * must map to null (unknown), never a fabricated value.
 */
import { createClient } from "../index.js";

function fakeCodingFetch(wireResult: Record<string, unknown>): typeof globalThis.fetch {
  return (async (_url: string, init: RequestInit = {}) => {
    const isPost = (init.method ?? "GET") === "POST";
    const attributes = isPost
      ? { status: "pending" }
      : {
          status: "completed",
          summary: "done",
          result: wireResult,
          error: null,
        };
    return {
      ok: true,
      status: isPost ? 202 : 200,
      json: async () => ({
        data: {
          id: "run-xyz",
          attributes,
          relationships: { execution_environment: { data: { id: "env-1" } } },
        },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

const BASE_WIRE = {
  success: true,
  turns: 2,
  model_used: "smart",
  duration_ms: 900,
  tool_call_count: 3,
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe("coding.run — terminal result mapping", () => {
  it("maps null disclosure fields (current coding servers) to null", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeCodingFetch({ ...BASE_WIRE, served_model: null, cost_usd: null }),
    });
    const result = await sapiom.models.coding.run({ task: "do a thing" });
    expect(result.status).toBe("completed");
    expect(result.result?.modelUsed).toBe("smart");
    expect(result.result?.servedModel).toBeNull();
    expect(result.result?.costUsd).toBeNull();
    expect(result.result).not.toHaveProperty("degradation");
  });

  it("maps absent disclosure fields (older servers) to null, existing fields untouched", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeCodingFetch(BASE_WIRE) });
    const result = await sapiom.models.coding.run({ task: "do a thing" });
    expect(result.result?.servedModel).toBeNull();
    expect(result.result?.costUsd).toBeNull();
    expect(result.result?.toolCallCount).toBe(3);
    expect(result.result?.usage.inputTokens).toBe(10);
  });

  it("passes disclosure values through when a server reports them", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeCodingFetch({
        ...BASE_WIRE,
        served_model: "deployment-a",
        cost_usd: 0.002,
        degradation: { kind: "fallback" },
      }),
    });
    const result = await sapiom.models.coding.run({ task: "do a thing" });
    expect(result.result?.servedModel).toBe("deployment-a");
    expect(result.result?.costUsd).toBe(0.002);
    expect(result.result?.degradation).toEqual({ kind: "fallback" });
  });
});
