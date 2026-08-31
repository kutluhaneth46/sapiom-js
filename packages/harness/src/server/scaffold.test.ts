/**
 * The scaffold endpoint, on a real filesystem (SAP-2981).
 *
 * Every test here goes STRAIGHT AT THE ROUTE — no dialog, no client. The whole
 * point of the endpoint is that it refuses on its own findings: a name field
 * that disables its own submit button proves nothing about a macro, a curl, or
 * a future keyboard path that reaches the route another way. So the refusals
 * are posted directly, and the filesystem is inspected afterwards, because
 * "refused" and "refused without leaving a half-created agent behind" are
 * different claims and only the second one is worth having.
 *
 * The scaffold routine itself is injected: what is under test is the guard set
 * and the ordering, not `@sapiom/agent-core`'s template copy. The one test that
 * cares about disk state stubs a scaffold that creates the directory and then
 * throws, which is exactly the failure the cleanup exists for.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentScaffoldResponse } from "../shared/types.js";
import { createAgentScaffoldRouter, refuseScaffoldOnDisk } from "./scaffold.js";

let tmp: string;

beforeEach(async () => {
  // realpath: macOS hands out `/var/folders/…`, a symlink to `/private/var/…`,
  // and the route compares the request's resolved root against the list's.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-scaffold-")));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

interface ScaffoldCall {
  targetDir: string;
  template: string;
}

/** A live express app over the router, so the route is exercised as a route. */
async function serve(
  options: {
    agents?: string[];
    projectDirs?: string[];
    scaffoldAgent?: (call: ScaffoldCall) => Promise<{ dependenciesInstalled: boolean }>;
    onScaffolded?: (dir: string) => Promise<void>;
  } = {},
): Promise<{
  calls: ScaffoldCall[];
  scaffolded: string[];
  post: (body: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}> {
  const calls: ScaffoldCall[] = [];
  const scaffolded: string[] = [];
  const agents = options.agents ?? [];
  const app = express();
  app.use(express.json());
  app.use(
    createAgentScaffoldRouter({
      listProjectDirs: () => options.projectDirs ?? [tmp],
      resolveAgent: (agentPath) =>
        agents.includes(agentPath)
          ? { name: path.basename(agentPath), path: agentPath }
          : null,
      scaffoldAgent: async (call) => {
        calls.push(call);
        if (options.scaffoldAgent) return await options.scaffoldAgent(call);
        // The default stand-in does what the real one does first: make the
        // directory. A guard that only looks like it fired because nothing was
        // ever created is not a guard.
        await fs.mkdir(call.targetDir, { recursive: true });
        await fs.writeFile(
          path.join(call.targetDir, "sapiom.json"),
          JSON.stringify({ name: path.basename(call.targetDir) }),
        );
        return { dependenciesInstalled: false };
      },
      onScaffolded: async (dir) => {
        scaffolded.push(dir);
        await options.onScaffolded?.(dir);
      },
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    calls,
    scaffolded,
    post: async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents/scaffold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const exists = async (p: string): Promise<boolean> =>
  await fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);

describe("refuseScaffoldOnDisk", () => {
  it("passes an absent destination and refuses anything already there", async () => {
    expect(await refuseScaffoldOnDisk(path.join(tmp, "fresh"), "proj")).toBeNull();
    await fs.mkdir(path.join(tmp, "taken"));
    expect(await refuseScaffoldOnDisk(path.join(tmp, "taken"), "proj")).toMatch(
      /already contains taken/,
    );
  });

  it("refuses a DANGLING symlink — lstat, not stat", async () => {
    // `stat` follows the link, finds nothing, and would report the destination
    // as free; the scaffold would then write through a link the user placed.
    await fs.symlink(path.join(tmp, "nowhere"), path.join(tmp, "link"));
    expect(await refuseScaffoldOnDisk(path.join(tmp, "link"), "proj")).toMatch(
      /already contains link/,
    );
  });
});

describe("POST /api/agents/scaffold", () => {
  it("creates the agent inside the project and reports its path", async () => {
    const srv = await serve();
    try {
      const res = await srv.post({ root: tmp, name: "billing-bot" });
      expect(res.status).toBe(200);
      const body = res.body as AgentScaffoldResponse;
      expect(body.path).toBe(path.join(tmp, "billing-bot"));
      expect(body.name).toBe("billing-bot");
      expect(body.template).toBe("default");
      expect(srv.calls).toEqual([
        { targetDir: path.join(tmp, "billing-bot"), template: "default" },
      ]);
      expect(await exists(path.join(tmp, "billing-bot", "sapiom.json"))).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("rescans BEFORE it answers, so the rail has the agent before the caller acts", async () => {
    const order: string[] = [];
    const srv = await serve({
      onScaffolded: async (dir) => {
        // A REAL tick before the push, deliberately: a synchronous stub records
        // "scanned" first even when the route forgets to await, so the
        // assertion would survive the very mutation it exists to catch.
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`scanned:${path.basename(dir)}`);
      },
    });
    try {
      const res = await srv.post({ root: tmp, name: "late" });
      order.push(`answered:${res.status}`);
      expect(order).toEqual(["scanned:late", "answered:200"]);
    } finally {
      await srv.close();
    }
  });

  it("passes the chosen template through", async () => {
    const srv = await serve();
    try {
      const res = await srv.post({ root: tmp, name: "paused", template: "coding-pause" });
      expect(res.status).toBe(200);
      expect(srv.calls[0].template).toBe("coding-pause");
    } finally {
      await srv.close();
    }
  });

  it("refuses a name that is not one folder segment — and never calls scaffold", async () => {
    const srv = await serve();
    try {
      for (const name of ["../evil", "a/b", "", "..", ".hidden"]) {
        const res = await srv.post({ root: tmp, name });
        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe("string");
      }
      // The escape the name guard exists for: nothing landed outside the root.
      expect(await exists(path.join(path.dirname(tmp), "evil"))).toBe(false);
      expect(srv.calls).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("refuses a template that is not a plain segment", async () => {
    // `resolveTemplate` JOINS this onto the bundled templates dir, so an
    // unguarded value names any directory on the machine as the thing to copy.
    const srv = await serve();
    try {
      for (const template of ["../../../etc", "a/b", "", 7]) {
        const res = await srv.post({ root: tmp, name: "agent", template });
        expect(res.status).toBe(400);
      }
      expect(srv.calls).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("refuses a root the studio does not show as a project", async () => {
    // The barrier is the LIST, not the string: an absolute, traversal-free,
    // perfectly real directory is still refused when the rail can't show it.
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    const srv = await serve({ projectDirs: [path.join(tmp, "known")] });
    try {
      const res = await srv.post({ root: outside, name: "sneaky" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/doesn't show that folder as a project/);
      expect(await exists(path.join(outside, "sneaky"))).toBe(false);
      expect(srv.calls).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("refuses a relative or traversing root", async () => {
    const srv = await serve();
    try {
      for (const root of ["relative/path", `${tmp}/../${path.basename(tmp)}`, 5, null]) {
        const res = await srv.post({ root, name: "agent" });
        expect(res.status).toBe(400);
      }
      expect(srv.calls).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("refuses a duplicate name — and leaves the existing agent untouched", async () => {
    const existing = path.join(tmp, "twin");
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, "index.ts"), "// the original\n");
    const srv = await serve({ agents: [existing] });
    try {
      const res = await srv.post({ root: tmp, name: "twin" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has an agent called twin/);
      expect(srv.calls).toEqual([]);
      expect(await fs.readFile(path.join(existing, "index.ts"), "utf8")).toBe(
        "// the original\n",
      );
    } finally {
      await srv.close();
    }
  });

  it("refuses a plain directory in the way, which the registry cannot see", async () => {
    // The registry knows nothing about a folder with no agent in it, so only a
    // real `lstat` answers this one — and scaffolding into it would fail deep
    // inside agent-core instead of here, with a directory the user then owns.
    await fs.mkdir(path.join(tmp, "notes"));
    const srv = await serve();
    try {
      const res = await srv.post({ root: tmp, name: "notes" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already contains notes/);
      expect(srv.calls).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("leaves NOTHING on disk when the scaffold fails part-way", async () => {
    // The real `scaffold` makes the directory and then copies into it, so a
    // template failure mid-copy leaves a folder the user never made — and the
    // retry then dies on "already contains", which is the worse of the two
    // failures.
    const srv = await serve({
      scaffoldAgent: async ({ targetDir }) => {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "half"), "written");
        throw new Error("template copy blew up");
      },
    });
    try {
      const res = await srv.post({ root: tmp, name: "doomed" });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/template copy blew up/);
      expect(await exists(path.join(tmp, "doomed"))).toBe(false);
      // Nothing was announced either: the rail must not be told about an agent
      // that does not exist.
      expect(srv.scaffolded).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("two simultaneous creates of the same name: one wins, and the loser deletes nothing", async () => {
    // THE RACE THE CLEANUP MADE DANGEROUS. Both requests pass the `lstat` —
    // nothing is there when either looks — and then one of them scaffolds while
    // the other's scaffold refuses a non-empty directory. Without the atomic
    // claim, the loser's cleanup recursively deleted the WINNER's freshly
    // installed agent, while the winner's caller had already been told it
    // exists.
    const srv = await serve({
      scaffoldAgent: async ({ targetDir }) => {
        const entries = await fs.readdir(targetDir);
        if (entries.length > 0)
          throw new Error(`Target directory '${targetDir}' already exists and is not empty.`);
        await fs.writeFile(path.join(targetDir, "index.ts"), "// the winner\n");
        return { dependenciesInstalled: false };
      },
    });
    try {
      const [a, b] = await Promise.all([
        srv.post({ root: tmp, name: "contested" }),
        srv.post({ root: tmp, name: "contested" }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      // The winner's work is intact — this is the assertion the old cleanup
      // failed: it deleted the directory it had just been told was occupied.
      expect(await fs.readFile(path.join(tmp, "contested", "index.ts"), "utf8")).toBe(
        "// the winner\n",
      );
    } finally {
      await srv.close();
    }
  });

  it("creates the project directory when it does not exist yet", async () => {
    // THE FRESH-INSTALL CASE. `<launchDir>/projects` is the desktop host's
    // default parent for new projects and nothing creates it — the scaffold's
    // own recursive mkdir used to, until the atomic claim started running ahead
    // of it, and the first template a new user ever picked was refused at its
    // own suggested destination.
    const unmade = path.join(tmp, "projects");
    const srv = await serve({ projectDirs: [unmade] });
    try {
      const res = await srv.post({ root: unmade, name: "first-ever" });
      expect(res.status).toBe(200);
      expect((res.body as AgentScaffoldResponse).path).toBe(
        path.join(unmade, "first-ever"),
      );
      expect(await exists(path.join(unmade, "first-ever", "sapiom.json"))).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("creates in a nested project directory the rail shows, using the LIST's spelling", async () => {
    // The move route's rule, applied here: the directory that gets written into
    // is the one from the list, so a request may not smuggle a different
    // spelling of it past the match.
    const nested = path.join(tmp, "systems", "payments");
    await fs.mkdir(nested, { recursive: true });
    const srv = await serve({ projectDirs: [nested] });
    try {
      const res = await srv.post({ root: `${nested}/`, name: "refunds" });
      expect(res.status).toBe(200);
      expect((res.body as AgentScaffoldResponse).path).toBe(path.join(nested, "refunds"));
    } finally {
      await srv.close();
    }
  });
});
