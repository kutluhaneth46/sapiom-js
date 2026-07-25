import { describe, it, expect } from "vitest";
import { DEFAULT_MACROS } from "./macros.js";

describe("DEFAULT_MACROS", () => {
  it("defines exactly the 2 registered macros — open_prod and visualize", () => {
    expect(DEFAULT_MACROS.map((m) => m.id)).toEqual(["open_prod", "visualize"]);
  });

  it("no longer contains the deprecated pty-inject macros (run_local, deploy, prod_run)", () => {
    const ids = DEFAULT_MACROS.map((m) => m.id);
    expect(ids).not.toContain("run_local");
    expect(ids).not.toContain("deploy");
    expect(ids).not.toContain("prod_run");
  });

  it("open_prod deep-links to the workflow and requires one to be selected", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "open_prod")!;
    expect(macro.requiresWorkflow).toBe(true);
    expect(macro.action).toEqual({
      kind: "open-url",
      url: "https://app.sapiom.ai/workflows/{{workflow.definitionId}}",
    });
  });

  it("visualize is the ONE canvas macro — a server-side force refresh, unbound-friendly, no pty involved", () => {
    const macro = DEFAULT_MACROS.find((m) => m.id === "visualize")!;
    // Works whether or not a workflow is bound — the refresh pipeline reads
    // the session's actual binding server-side, so there's no prompt text
    // (and therefore no {{workflow.path}} to throw on when unbound).
    expect(macro.requiresWorkflow).toBeFalsy();
    expect(macro.action).toEqual({ kind: "render-canvas" });
  });

  it("the old ai-visualize macro (LLM writes the whole HTML page) is gone — enrichment replaced it", () => {
    expect(DEFAULT_MACROS.find((m) => m.id === "ai-visualize")).toBeUndefined();
  });

  it("every macro has a non-empty label and icon", () => {
    for (const macro of DEFAULT_MACROS) {
      expect(macro.label.length).toBeGreaterThan(0);
      expect(macro.icon.length).toBeGreaterThan(0);
    }
  });
});
