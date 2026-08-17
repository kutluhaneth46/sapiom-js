import {
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ManagedAgentProcessObserver,
  ManagedAgentTeardownObservation,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 100;
const QUIESCENCE_POLL_MS = 25;

interface ProcessRecord {
  readonly parentPid: number;
  readonly processGroupId?: number;
  /** Kernel-reported creation time, used to reject PID reuse. */
  readonly startedAt: string;
}

type ProcessTable = ReadonlyMap<number, ProcessRecord>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sameProcess(
  left: ProcessRecord | undefined,
  right: ProcessRecord | undefined,
): boolean {
  return Boolean(left && right && left.startedAt === right.startedAt);
}

async function windowsProcessTable(): Promise<ProcessTable> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as
    | {
        ProcessId?: unknown;
        ParentProcessId?: unknown;
        CreationDate?: unknown;
      }
    | Array<{
        ProcessId?: unknown;
        ParentProcessId?: unknown;
        CreationDate?: unknown;
      }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(
    rows.flatMap((row) =>
      typeof row.ProcessId === "number" &&
      typeof row.ParentProcessId === "number" &&
      typeof row.CreationDate === "string"
        ? [
            [
              row.ProcessId,
              {
                parentPid: row.ParentProcessId,
                startedAt: row.CreationDate,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

async function posixProcessTable(): Promise<ProcessTable> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,lstart="],
    {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const entries: Array<readonly [number, ProcessRecord]> = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    entries.push([
      Number(match[1]),
      {
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        startedAt: match[4]!,
      },
    ]);
  }
  return new Map(entries);
}

async function readProcessTable(): Promise<ProcessTable> {
  try {
    return process.platform === "win32"
      ? await windowsProcessTable()
      : await posixProcessTable();
  } catch {
    return new Map();
  }
}

function descendantsOf(
  roots: ReadonlySet<number>,
  table: ProcessTable,
): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, record] of table) {
      if (
        !descendants.has(pid) &&
        (roots.has(record.parentPid) || descendants.has(record.parentPid))
      ) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  try {
    await execFileAsync(
      "taskkill.exe",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true },
    );
  } catch {
    // A process that exited between validation and cleanup is already safe.
  }
}

/**
 * Tracks only SDK roots created by this observer and descendants discovered
 * from the host kernel. PID-file contents are deliberately outside this API:
 * model-writable fixture evidence must never become signal authority.
 *
 * POSIX children are placed in their own process group. Before group cleanup,
 * the observer revalidates a kernel creation timestamp for the root or a known
 * group member, preventing a recycled numeric PID from becoming a kill target.
 */
export class LocalManagedAgentProcessObserver implements ManagedAgentProcessObserver {
  readonly #rootPids = new Set<number>();
  readonly #rootIdentities = new Map<number, ProcessRecord>();
  readonly #observedIdentities = new Map<number, ProcessRecord>();
  readonly #observedPids = new Set<number>();
  readonly #children = new Map<number, ChildProcessWithoutNullStreams>();
  readonly #sampler: NodeJS.Timeout;
  #sampleTask: Promise<void> | undefined;

  public constructor() {
    this.#sampler = setInterval(
      () => void this.observeProcessTree(),
      SAMPLE_INTERVAL_MS,
    );
    this.#sampler.unref();
  }

  public spawn(options: SpawnOptions): SpawnedProcess {
    const child = spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (typeof child.pid === "number") {
      const pid = child.pid;
      this.#rootPids.add(pid);
      this.#observedPids.add(pid);
      this.#children.set(pid, child);
      const terminateTree = (): void => {
        void this.#terminateRoot(pid, false);
      };
      options.signal.addEventListener("abort", terminateTree, { once: true });
      child.once("exit", () => {
        options.signal.removeEventListener("abort", terminateTree);
        this.#children.delete(pid);
      });
      void this.observeProcessTree();
    }
    return child;
  }

  public observeProcessTree(): Promise<void> {
    if (this.#sampleTask) return this.#sampleTask;
    if (this.#rootPids.size === 0) return Promise.resolve();
    this.#sampleTask = (async () => {
      const table = await readProcessTable();
      const validatedRoots = new Set<number>();
      for (const pid of this.#rootPids) {
        const current = table.get(pid);
        const known = this.#rootIdentities.get(pid);
        const child = this.#children.get(pid);
        const childActive =
          child !== undefined &&
          child.exitCode === null &&
          child.signalCode === null;
        if (!current || (known ? !sameProcess(known, current) : !childActive)) {
          continue;
        }
        if (!known) this.#rootIdentities.set(pid, current);
        this.#observedIdentities.set(pid, current);
        this.#observedPids.add(pid);
        validatedRoots.add(pid);
      }
      for (const pid of descendantsOf(validatedRoots, table)) {
        const current = table.get(pid);
        if (!current) continue;
        this.#observedIdentities.set(pid, current);
        this.#observedPids.add(pid);
      }
    })().finally(() => {
      this.#sampleTask = undefined;
    });
    return this.#sampleTask;
  }

  async #aliveObservedPids(): Promise<number[]> {
    const table = await readProcessTable();
    const alive = new Set(
      [...this.#observedIdentities].flatMap(([pid, identity]) =>
        sameProcess(identity, table.get(pid)) ? [pid] : [],
      ),
    );
    // If kernel enumeration is unavailable, a still-active ChildProcess handle
    // must keep teardown fail-closed instead of producing false quiescence.
    for (const [pid, child] of this.#children) {
      if (child.exitCode === null && child.signalCode === null) alive.add(pid);
    }
    return [...alive].sort((left, right) => left - right);
  }

  async #terminateRoot(rootPid: number, force: boolean): Promise<void> {
    await this.observeProcessTree();
    const table = await readProcessTable();
    const rootIdentity = this.#rootIdentities.get(rootPid);
    const rootMatches = sameProcess(rootIdentity, table.get(rootPid));
    const child = this.#children.get(rootPid);
    const childActive =
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null;

    if (process.platform === "win32") {
      if (rootMatches) {
        await taskkill(rootPid, force);
      } else if (!rootIdentity && childActive) {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      }
      return;
    }

    const hasValidatedGroupMember = [...this.#observedIdentities].some(
      ([pid, identity]) => {
        const current = table.get(pid);
        return (
          current?.processGroupId === rootPid && sameProcess(identity, current)
        );
      },
    );
    if (rootMatches || hasValidatedGroupMember) {
      try {
        process.kill(-rootPid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // A validated group that exited before the signal is already safe.
      }
    } else if (!rootIdentity && childActive) {
      // The kernel sampler can be unavailable. The trusted ChildProcess handle
      // remains safe for root-only termination, but we never guess descendants.
      child.kill(force ? "SIGKILL" : "SIGTERM");
    }
  }

  public async waitForQuiescence(
    timeoutMs: number,
  ): Promise<ManagedAgentTeardownObservation> {
    const startedAt = Date.now();
    let alivePids: number[] = [];
    do {
      await this.observeProcessTree();
      alivePids = await this.#aliveObservedPids();
      if (alivePids.length === 0) {
        return {
          quiescent: true,
          deadlineMet: true,
          elapsedMs: Date.now() - startedAt,
          observedPids: [...this.#observedPids].sort(
            (left, right) => left - right,
          ),
          alivePidsAtDeadline: [],
          emergencyCleanupAttempted: false,
        };
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await delay(QUIESCENCE_POLL_MS);
    } while (Date.now() - startedAt < timeoutMs);

    await this.observeProcessTree();
    alivePids = await this.#aliveObservedPids();
    return {
      quiescent: alivePids.length === 0,
      deadlineMet: alivePids.length === 0,
      elapsedMs: Date.now() - startedAt,
      observedPids: [...this.#observedPids].sort((left, right) => left - right),
      alivePidsAtDeadline: alivePids,
      emergencyCleanupAttempted: false,
    };
  }

  public async emergencyCleanup(): Promise<void> {
    await this.observeProcessTree();
    await Promise.all(
      [...this.#rootPids].map((pid) => this.#terminateRoot(pid, true)),
    );
  }

  public dispose(): void {
    clearInterval(this.#sampler);
  }
}

export function createLocalManagedAgentProcessObserver(): ManagedAgentProcessObserver {
  return new LocalManagedAgentProcessObserver();
}
