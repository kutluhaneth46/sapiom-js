import { readDisclosure } from "./index.js";

// SAP-2764 DisclosureFields on raw /v2 non-streaming bodies: `served_model` +
// `cost_usd` are injected top-level by the gateway; `readDisclosure` camelCases
// them and treats anything missing/malformed as unknown (null) — old-server safe.
describe("llm.readDisclosure", () => {
  it("reads the injected disclosure fields off a /v2 response body", () => {
    const body = {
      type: "message",
      model: "smart", // the echo stays the label
      served_model: "m2.7-fireworks-sapiom",
      cost_usd: 0.000123,
    };
    expect(readDisclosure(body)).toEqual({
      servedModel: "m2.7-fireworks-sapiom",
      costUsd: 0.000123,
    });
  });

  it("returns nulls for responses from servers that do not disclose (additive-safe)", () => {
    expect(readDisclosure({ type: "message", model: "smart" })).toEqual({
      servedModel: null,
      costUsd: null,
    });
    expect(readDisclosure(null)).toEqual({ servedModel: null, costUsd: null });
    expect(readDisclosure(undefined)).toEqual({ servedModel: null, costUsd: null });
  });

  it("treats malformed values as unknown, never fabricates", () => {
    expect(readDisclosure({ served_model: "", cost_usd: Number.NaN })).toEqual({
      servedModel: null,
      costUsd: null,
    });
    expect(readDisclosure({ served_model: 42, cost_usd: "0.1" })).toEqual({
      servedModel: null,
      costUsd: null,
    });
  });
});
