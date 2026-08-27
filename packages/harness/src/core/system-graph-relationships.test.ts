import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentInventoryItem } from "./system-graph-inventory.js";
import { SourceAgentRelationshipProvider } from "./system-graph-relationships.js";

const temporaryRoots: string[] = [];

async function callerWithSource(source: string): Promise<AgentInventoryItem> {
  const sourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "system-graph-relationships-test-"),
  );
  temporaryRoots.push(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, "index.ts"), source);
  return {
    agentKey: "research",
    definitionId: 1,
    definitionSlug: "research",
    label: "Research",
    resolutionAliases: ["research"],
    sourceRoot,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SourceAgentRelationshipProvider", () => {
  it("aggregates evidence by target and mode while preserving distinct modes", async () => {
    const caller = await callerWithSource(`
ctx.sapiom.agents.run({ definition: "growth" });
ctx.sapiom.agents.run({ definition: "growth" });
ctx.sapiom.agents.launch({ definition: "growth" });
ctx.sapiom.agents.launch({ definition: dynamicTarget });
`);

    const result =
      await new SourceAgentRelationshipProvider().listRelationships(caller);

    expect(result.relationships).toEqual([
      {
        target: "growth",
        mode: "blocking",
        evidence: [
          { file: "index.ts", line: 2, column: 1 },
          { file: "index.ts", line: 3, column: 1 },
        ],
      },
      {
        target: "growth",
        mode: "async",
        evidence: [{ file: "index.ts", line: 4, column: 1 }],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic-target",
        mode: "async",
        evidence: { file: "index.ts", line: 5, column: 1 },
      },
    ]);
  });

  it("returns identical relationship semantics for unchanged caller input", async () => {
    const caller = await callerWithSource(
      'ctx.sapiom.agents.run({ definition: "growth" });\n',
    );
    const provider = new SourceAgentRelationshipProvider();

    const first = await provider.listRelationships(caller);
    const second = await provider.listRelationships(caller);

    expect(second).toEqual(first);
  });
});
