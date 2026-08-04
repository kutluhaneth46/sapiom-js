import { describe, expect, it, vi } from "vitest";

vi.mock("./version.js", () => ({ packageVersion: () => "9.9.9" }));

import { createServerInfo } from "./server-info.js";

describe("createServerInfo", () => {
  it("reports the package version and the local/cloud boundary", () => {
    const info = createServerInfo();

    expect(info.version).toBe("9.9.9");
    expect(info.description).toContain("tests agents locally");
    expect(info.description).toContain("authenticated cloud actions");
    expect(info.description).toContain("hosted direct-capability MCP");
    expect(info.description).not.toContain("unmetered");
    expect(info.description).not.toContain("makes no paid capability calls");
  });
});
