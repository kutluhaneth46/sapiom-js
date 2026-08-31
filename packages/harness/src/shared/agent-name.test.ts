/**
 * The one agent-name rule (SAP-2981).
 *
 * It is tested here rather than beside either consumer because both the dialog
 * and `POST /api/agents/scaffold` depend on it saying the SAME thing: a name
 * the field accepts and the route refuses reads as a broken app.
 */
import { describe, expect, it } from "vitest";

import { refuseAgentName } from "./agent-name.js";

describe("refuseAgentName", () => {
  it("accepts an ordinary agent folder name", () => {
    expect(refuseAgentName("order-triage")).toBeNull();
    expect(refuseAgentName("Order_Triage2")).toBeNull();
  });

  it("refuses the shapes that would escape the project", () => {
    // Each of these is a directory the caller must not be able to name, and
    // each carries its own sentence because the user reads it verbatim.
    expect(refuseAgentName("../evil")).toMatch(/one folder name/);
    expect(refuseAgentName("a/b")).toMatch(/one folder name/);
    expect(refuseAgentName("..")).toMatch(/dot/);
    expect(refuseAgentName(".hidden")).toMatch(/dot/);
    expect(refuseAgentName("")).toMatch(/Give the agent a name/);
    expect(refuseAgentName("   ")).toMatch(/Give the agent a name/);
    expect(refuseAgentName(" leading")).toMatch(/space/);
    expect(refuseAgentName(42)).toMatch(/Give the agent a name/);
    expect(refuseAgentName("x".repeat(65))).toMatch(/too long/);
    // Windows makes `foo.` into `foo`, so the name the caller is told it got
    // and the directory on disk would disagree.
    expect(refuseAgentName("trailing.")).toMatch(/end with a dot/);
  });

  it("refuses a NUL, which reaches fs as a throw rather than a refusal", () => {
    expect(refuseAgentName("ok\u0000name")).toMatch(/isn't a folder name/);
  });
});
