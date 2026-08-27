import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { AppState, BusMessage, WorkflowInfo } from "../shared/types.js";
import type { SystemGraphSnapshot } from "../shared/system-graph.js";
import { startServer, type HarnessServer } from "./index.js";

async function scaffoldAgent(
  workspaceRoot: string,
  name: string,
  source = "export {};\n",
): Promise<string> {
  const agentRoot = path.join(workspaceRoot, name);
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "sapiom.json"),
    JSON.stringify({ name, definitionId: null }),
  );
  await fs.writeFile(path.join(agentRoot, "index.ts"), source);
  return agentRoot;
}

describe("workspace graph freshness wiring", () => {
  let tempRoot: string;
  let stateRoot: string;
  let workspaceRoot: string;
  let server: HarnessServer | undefined;
  let socket: WebSocket | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-freshness-"),
    );
    stateRoot = path.join(tempRoot, "state");
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [workspaceRoot] }),
    );
  });

  afterEach(async () => {
    socket?.close();
    await server?.close();
    server = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it(
    "refreshes source relationships and agent inventory without a session",
    { retry: 1, timeout: 30_000 },
    async () => {
      const researchRoot = await scaffoldAgent(workspaceRoot, "research");
      await scaffoldAgent(workspaceRoot, "growth");
      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: {},
        stateRoot,
        launchDir: workspaceRoot,
        autoCreateSession: false,
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = { "X-Harness-Token": "test-token" };

      await vi.waitFor(
        async () => {
          const response = await fetch(`${baseUrl}/api/workflows`, { headers });
          const workflows = (await response.json()) as WorkflowInfo[];
          expect(
            workflows.map((workflow) => workflow.definitionSlug).sort(),
          ).toEqual(["growth", "research"]);
        },
        { timeout: 8_000, interval: 150 },
      );

      const stateResponse = await fetch(`${baseUrl}/api/state`, { headers });
      const state = (await stateResponse.json()) as AppState;
      const workspaceKey = state.workspaceScopes?.find(
        (scope) => scope.cwd === workspaceRoot,
      )?.workspaceKey;
      expect(workspaceKey).toBeTruthy();
      const graphUrl = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;

      const graphEvents: Array<
        Extract<BusMessage, { type: "system-graph.changed" }>
      > = [];
      socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/events?token=test-token`,
      );
      await new Promise<void>((resolve, reject) => {
        socket!.once("open", resolve);
        socket!.once("error", reject);
      });
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as BusMessage;
        if (message.type === "system-graph.changed") graphEvents.push(message);
      });

      const readGraph = async (): Promise<SystemGraphSnapshot> => {
        const response = await fetch(graphUrl, { headers });
        expect(response.status).toBe(200);
        const raw = await response.text();
        expect(raw).not.toContain(workspaceRoot);
        return JSON.parse(raw) as SystemGraphSnapshot;
      };
      const initial = await readGraph();
      expect(initial).toMatchObject({ state: "ready" });
      expect(initial.graph?.edges).toEqual([]);
      graphEvents.length = 0;

      await fs.writeFile(
        path.join(researchRoot, "index.ts"),
        'ctx.sapiom.agents.run({ definition: "growth" });\n',
      );
      let sourceRefresh!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          sourceRefresh = await readGraph();
          expect(sourceRefresh.revision).toBeGreaterThan(initial.revision);
          expect(sourceRefresh.state).toBe("ready");
          expect(sourceRefresh.graph?.edges).toEqual([
            expect.objectContaining({
              from: "agent:research",
              to: "agent:growth",
              mode: "blocking",
            }),
          ]);
        },
        { timeout: 8_000, interval: 150 },
      );
      expect(graphEvents.some((event) => event.state === "stale")).toBe(true);
      expect(graphEvents.some((event) => event.state === "ready")).toBe(true);

      await fs.writeFile(path.join(researchRoot, "index.ts"), "export {};\n");
      let sourceRemoved!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          sourceRemoved = await readGraph();
          expect(sourceRemoved.revision).toBeGreaterThan(
            sourceRefresh.revision,
          );
          expect(sourceRemoved.graph?.edges).toEqual([]);
        },
        { timeout: 8_000, interval: 150 },
      );

      const reportingRoot = await scaffoldAgent(workspaceRoot, "reporting");
      let added!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          added = await readGraph();
          expect(added.revision).toBeGreaterThan(sourceRemoved.revision);
          expect(
            added.graph?.nodes.some((node) => node.agentKey === "reporting"),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 150 },
      );

      const insightsRoot = path.join(workspaceRoot, "insights");
      await fs.rename(reportingRoot, insightsRoot);
      await fs.writeFile(
        path.join(insightsRoot, "sapiom.json"),
        JSON.stringify({ name: "insights", definitionId: null }),
      );
      await fs.writeFile(
        path.join(insightsRoot, "index.ts"),
        'ctx.sapiom.agents.run({ definition: "growth" });\n',
      );
      let renamed!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          renamed = await readGraph();
          expect(renamed.revision).toBeGreaterThan(added.revision);
          expect(
            renamed.graph?.nodes.some((node) => node.agentKey === "reporting"),
          ).toBe(false);
          expect(
            renamed.graph?.edges.some(
              (edge) =>
                edge.from === "agent:insights" && edge.to === "agent:growth",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 150 },
      );

      await fs.writeFile(
        path.join(insightsRoot, "sapiom.json"),
        JSON.stringify({ name: "insights-v2", definitionId: null }),
      );
      let renamedSlug!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          renamedSlug = await readGraph();
          expect(renamedSlug.revision).toBeGreaterThan(renamed.revision);
          expect(
            renamedSlug.graph?.edges.some(
              (edge) =>
                edge.from === "agent:insights-v2" && edge.to === "agent:growth",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 150 },
      );

      await fs.rm(insightsRoot, { recursive: true, force: true });
      await vi.waitFor(
        async () => {
          const removed = await readGraph();
          expect(removed.revision).toBeGreaterThan(renamedSlug.revision);
          expect(
            removed.graph?.nodes.some(
              (node) => node.agentKey === "insights-v2",
            ),
          ).toBe(false);
        },
        { timeout: 8_000, interval: 150 },
      );
    },
  );
});
