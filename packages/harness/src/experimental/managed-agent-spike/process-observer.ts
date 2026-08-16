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

type ProcessTable = ReadonlyMap<number, number>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function windowsProcessTable(): Promise<ProcessTable> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as
    | { ProcessId?: unknown; ParentProcessId?: unknown }
    | Array<{ ProcessId?: unknown; ParentProcessId?: unknown }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(
    rows.flatMap((row) =>
      typeof row.ProcessId === "number" &&
      typeof row.ParentProcessId === "number"
        ? [[row.ProcessId, row.ParentProcessId] as const]
        : [],
    ),
  );
}

async function posixProcessTable(): Promise<ProcessTable> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid="], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries: Array<readonly [number, number]> = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    entries.push([Number(match[1]), Number(match[2])]);
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
    for (const [pid, parentPid] of table) {
      if (
        !descendants.has(pid) &&
        (roots.has(parentPid) || descendants.has(parentPid))
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
    // A process that exited between observation and cleanup is already safe.
  }
}

/**
 * Tracks the actual SDK subprocess plus descendants sampled from the kernel.
 * POSIX children are placed in their own process group so the forwarded SDK
 * abort signal can terminate Bash descendants rather than only their parent.
 */
export class LocalManagedAgentProcessObserver implements ManagedAgentProcessObserver {
  readonly #roots = new Set<number>();
  readonly #observed = new Set<number>();
  readonly #children = new Map<number, ChildProcessWithoutNullStreams>();
  readonly #sampler: NodeJS.Timeout;
  #samplePending = false;

  public constructor() {
    this.#sampler = setInterval(() => void this.#sample(), SAMPLE_INTERVAL_MS);
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
      this.#roots.add(pid);
      this.#observed.add(pid);
      this.#children.set(pid, child);
      const terminateTree = (): void => {
        if (process.platform === "win32") {
          void taskkill(pid, false);
          return;
        }
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };
      options.signal.addEventListener("abort", terminateTree, { once: true });
      child.once("exit", () => {
        options.signal.removeEventListener("abort", terminateTree);
        this.#children.delete(pid);
      });
    }
    return child;
  }

  public trackPids(pids: readonly number[]): void {
    for (const pid of pids) {
      if (Number.isInteger(pid) && pid > 0) this.#observed.add(pid);
    }
  }

  async #sample(): Promise<void> {
    if (this.#samplePending || this.#roots.size === 0) return;
    this.#samplePending = true;
    try {
      const table = await readProcessTable();
      for (const pid of descendantsOf(this.#roots, table))
        this.#observed.add(pid);
    } finally {
      this.#samplePending = false;
    }
  }

  public async waitForQuiescence(
    timeoutMs: number,
  ): Promise<ManagedAgentTeardownObservation> {
    const startedAt = Date.now();
    let alivePids: number[] = [];
    do {
      await this.#sample();
      alivePids = [...this.#observed].filter(pidAlive).sort((a, b) => a - b);
      if (alivePids.length === 0) {
        return {
          quiescent: true,
          deadlineMet: true,
          elapsedMs: Date.now() - startedAt,
          observedPids: [...this.#observed].sort((a, b) => a - b),
          alivePidsAtDeadline: [],
          emergencyCleanupAttempted: false,
        };
      }
      await delay(QUIESCENCE_POLL_MS);
    } while (Date.now() - startedAt < timeoutMs);

    await this.#sample();
    alivePids = [...this.#observed].filter(pidAlive).sort((a, b) => a - b);
    return {
      quiescent: alivePids.length === 0,
      deadlineMet: alivePids.length === 0,
      elapsedMs: Date.now() - startedAt,
      observedPids: [...this.#observed].sort((a, b) => a - b),
      alivePidsAtDeadline: alivePids,
      emergencyCleanupAttempted: false,
    };
  }

  public async emergencyCleanup(pids: readonly number[]): Promise<void> {
    if (process.platform === "win32") {
      await Promise.all([...this.#roots].map((pid) => taskkill(pid, true)));
      await Promise.all(pids.map((pid) => taskkill(pid, true)));
      return;
    }
    for (const root of this.#roots) {
      try {
        process.kill(-root, "SIGKILL");
      } catch {
        // Fall through to individual PID cleanup below.
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // A process that already exited needs no cleanup.
      }
    }
  }

  public dispose(): void {
    clearInterval(this.#sampler);
  }
}

export function createLocalManagedAgentProcessObserver(): ManagedAgentProcessObserver {
  return new LocalManagedAgentProcessObserver();
}
