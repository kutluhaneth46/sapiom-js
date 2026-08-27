import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceScope } from "./system-graph.js";
import { SystemGraphWatcherManager } from "./system-graph-watcher.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let scope: WorkspaceScope;
let manager: SystemGraphWatcherManager;
let onSourceChange: ReturnType<typeof vi.fn>;
let onInventoryChange: ReturnType<typeof vi.fn>;

async function scaffoldAgent(name: string): Promise<string> {
  const agentRoot = path.join(root, name);
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "sapiom.json"),
    JSON.stringify({ name }),
  );
  await fs.writeFile(path.join(agentRoot, "index.ts"), "export {};\n");
  return agentRoot;
}

describe("SystemGraphWatcherManager", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "system-graph-watch-"));
    scope = { workspaceKey: "workspace-test", root };
    onSourceChange = vi.fn();
    onInventoryChange = vi.fn();
    manager = new SystemGraphWatcherManager({
      onSourceChange,
      onInventoryChange,
    });
  });

  afterEach(async () => {
    manager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refreshes source relationships without reporting inventory churn", async () => {
    const agentRoot = await scaffoldAgent("research");
    manager.start(scope);
    await sleep(100);
    onInventoryChange.mockClear();

    await fs.writeFile(
      path.join(agentRoot, "index.ts"),
      'ctx.sapiom.agents.run({ definition: "growth" });\n',
    );
    await sleep(1_100);

    expect(onSourceChange).toHaveBeenCalled();
    expect(onSourceChange.mock.calls.at(-1)?.[0]).toEqual(scope);
    expect(onInventoryChange).not.toHaveBeenCalled();
  });

  it("reports agent inventory additions and removals", async () => {
    manager.start(scope);
    await sleep(100);
    const agentRoot = await scaffoldAgent("growth");
    await sleep(1_100);
    expect(onInventoryChange).toHaveBeenCalledWith(scope);

    onInventoryChange.mockClear();
    await fs.rm(agentRoot, { recursive: true, force: true });
    await sleep(1_100);
    expect(onInventoryChange).toHaveBeenCalledWith(scope);
  });

  it("retries a failed inventory refresh without another filesystem edit", async () => {
    onInventoryChange
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValue(undefined);
    manager.start(scope);
    await scaffoldAgent("growth");

    await vi.waitFor(() => expect(onInventoryChange).toHaveBeenCalledTimes(2), {
      timeout: 4_000,
      interval: 100,
    });
  });

  it("ignores non-source and generated-tree churn", async () => {
    manager.start(scope);
    await fs.writeFile(path.join(root, "README.md"), "notes\n");
    await fs.mkdir(path.join(root, "node_modules", "pkg"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "node_modules", "pkg", "index.ts"),
      "export {};\n",
    );
    await sleep(1_100);

    expect(onSourceChange).not.toHaveBeenCalled();
    expect(onInventoryChange).not.toHaveBeenCalled();
  });

  it("does not re-baseline an existing workspace on repeated opens", () => {
    manager.start(scope);
    manager.start(scope);
    expect(manager.size).toBe(1);
  });

  it("retires watchers for scopes no longer exposed by Studio", () => {
    manager.start(scope);
    manager.retain(new Set());
    expect(manager.size).toBe(0);
  });
});
