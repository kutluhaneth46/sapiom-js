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
  ManagedAgentCancellationReadiness,
  ManagedAgentProcessObserver,
  ManagedAgentTeardownObservation,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 100;
const QUIESCENCE_POLL_MS = 25;
export const MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS = 200;

export interface ManagedAgentKernelProcessRecord {
  readonly parentPid: number;
  readonly processGroupId?: number;
  /** Kernel-reported creation time used for evidence, never POSIX authority. */
  readonly startedAt: string;
}

export type ManagedAgentKernelProcessTable = ReadonlyMap<
  number,
  ManagedAgentKernelProcessRecord
>;

export type ManagedAgentProcessTableObservation =
  | {
      readonly available: true;
      readonly processes: ManagedAgentKernelProcessTable;
    }
  | { readonly available: false };

export type ManagedAgentProcessGroupLiveness = "alive" | "gone" | "unknown";
export type ManagedAgentProcessSignalOutcome = "sent" | "gone" | "failure";

export interface LocalManagedAgentProcessObserverOptions {
  readonly platform?: NodeJS.Platform;
  readonly readProcessTable?: () => Promise<ManagedAgentProcessTableObservation>;
  readonly processGroupLiveness?: (
    processGroupId: number,
  ) => ManagedAgentProcessGroupLiveness;
  readonly signalProcessGroup?: (
    processGroupId: number,
    signal: "SIGSTOP" | "SIGKILL",
  ) => ManagedAgentProcessSignalOutcome;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

interface OwnedRoot {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  containmentSupported: boolean;
  ownershipProven: boolean;
  stopIssued: boolean;
  forceKillIssued: boolean;
}

interface ObservedIdentity {
  readonly rootPid: number;
  readonly record: ManagedAgentKernelProcessRecord;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sameProcess(
  left: ManagedAgentKernelProcessRecord | undefined,
  right: ManagedAgentKernelProcessRecord | undefined,
): boolean {
  return Boolean(left && right && left.startedAt === right.startedAt);
}

async function windowsProcessTable(): Promise<ManagedAgentKernelProcessTable> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
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

async function posixProcessTable(): Promise<ManagedAgentKernelProcessTable> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,lstart="],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const entries: Array<readonly [number, ManagedAgentKernelProcessRecord]> = [];
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

async function defaultReadProcessTable(
  platform: NodeJS.Platform,
): Promise<ManagedAgentProcessTableObservation> {
  try {
    return {
      available: true,
      processes:
        platform === "win32"
          ? await windowsProcessTable()
          : await posixProcessTable(),
    };
  } catch {
    return { available: false };
  }
}

function defaultProcessGroupLiveness(
  processGroupId: number,
): ManagedAgentProcessGroupLiveness {
  try {
    process.kill(-processGroupId, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function defaultSignalProcessGroup(
  processGroupId: number,
  signal: "SIGSTOP" | "SIGKILL",
): ManagedAgentProcessSignalOutcome {
  try {
    process.kill(-processGroupId, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : "failure";
  }
}

function childActive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function descendantsOf(
  roots: ReadonlySet<number>,
  table: ManagedAgentKernelProcessTable,
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

/**
 * E0.4 deliberately certifies one narrow containment model: the exact local
 * L2 fixture running inside a detached POSIX SDK process group. Before abort,
 * bounded host enumeration must observe an active trusted ChildProcess as its
 * PGID leader and observe the fixture PIDs in that group. Independently, the
 * detached spawn plus an active trusted root handle are safe signal authority,
 * so even a failed evidence preflight can synchronously stop and kill the
 * owned group without leaking it. Such a run still fails certification.
 *
 * This is not a universal sandbox or process-tree killer. Windows, a fast root
 * that exits before preparation, unavailable enumeration, and an observed
 * setsid/group escape all fail certification closed. POSIX `lstart` is evidence
 * only and never authorizes an individual or group signal. Workspace PID-file
 * contents never enter this class and can never become signal authority.
 */
export class LocalManagedAgentProcessObserver implements ManagedAgentProcessObserver {
  readonly #platform: NodeJS.Platform;
  readonly #readProcessTable: () => Promise<ManagedAgentProcessTableObservation>;
  readonly #processGroupLiveness: (
    processGroupId: number,
  ) => ManagedAgentProcessGroupLiveness;
  readonly #signalProcessGroup: (
    processGroupId: number,
    signal: "SIGSTOP" | "SIGKILL",
  ) => ManagedAgentProcessSignalOutcome;
  readonly #now: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #roots = new Map<number, OwnedRoot>();
  readonly #observedIdentities = new Map<number, ObservedIdentity>();
  readonly #observedPids = new Set<number>();
  readonly #sampler: NodeJS.Timeout;
  readonly #boundSignals = new WeakSet<AbortSignal>();
  #lastTable: ManagedAgentKernelProcessTable | undefined;
  #processTableAvailable = false;
  #sampleTask: Promise<boolean> | undefined;

  public constructor(options: LocalManagedAgentProcessObserverOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#readProcessTable =
      options.readProcessTable ??
      (() => defaultReadProcessTable(this.#platform));
    this.#processGroupLiveness =
      options.processGroupLiveness ?? defaultProcessGroupLiveness;
    this.#signalProcessGroup =
      options.signalProcessGroup ?? defaultSignalProcessGroup;
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? defaultDelay;
    this.#sampler = setInterval(
      () => void this.observeProcessTree(),
      SAMPLE_INTERVAL_MS,
    );
    this.#sampler.unref();
  }

  public bindAbortSignal(signal: AbortSignal): void {
    if (this.#boundSignals.has(signal)) return;
    this.#boundSignals.add(signal);
    signal.addEventListener("abort", () => this.#forceStopKillSynchronously(), {
      once: true,
    });
    if (signal.aborted) this.#forceStopKillSynchronously();
  }

  public spawn(options: SpawnOptions): SpawnedProcess {
    const child = spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: this.#platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (typeof child.pid === "number") {
      const pid = child.pid;
      this.#roots.set(pid, {
        pid,
        child,
        containmentSupported: true,
        ownershipProven: false,
        stopIssued: false,
        forceKillIssued: false,
      });
      this.#observedPids.add(pid);
      // The SDK's forwarded SpawnOptions.signal arrives only after its own
      // graceful close. Keep it as an idempotent fallback; runtime binds the
      // raw Options.abortController signal before query construction.
      this.bindAbortSignal(options.signal);
      void this.observeProcessTree();
    }
    return child;
  }

  async #boundedProcessTableRead(
    timeoutMs: number,
  ): Promise<ManagedAgentProcessTableObservation> {
    let timeout: NodeJS.Timeout | undefined;
    const read = Promise.resolve()
      .then(() => this.#readProcessTable())
      .catch(
        (): ManagedAgentProcessTableObservation => ({
          available: false,
        }),
      );
    try {
      return await Promise.race([
        read,
        new Promise<ManagedAgentProcessTableObservation>((resolveTimeout) => {
          timeout = setTimeout(
            () => resolveTimeout({ available: false }),
            Math.max(0, timeoutMs),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  public async observeProcessTree(
    timeoutMs = MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
  ): Promise<boolean> {
    if (this.#roots.size === 0) {
      this.#lastTable = new Map();
      this.#processTableAvailable = true;
      return true;
    }
    const boundedTimeoutMs = Math.max(
      0,
      Math.min(MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS, timeoutMs),
    );
    if (!this.#sampleTask) {
      this.#sampleTask = (async () => {
        const observation =
          await this.#boundedProcessTableRead(boundedTimeoutMs);
        if (!observation.available) {
          this.#lastTable = undefined;
          this.#processTableAvailable = false;
          return false;
        }

        const table = observation.processes;
        this.#lastTable = table;
        this.#processTableAvailable = true;
        for (const root of this.#roots.values()) {
          if (this.#platform !== "win32") {
            for (const [pid, observed] of this.#observedIdentities) {
              if (observed.rootPid !== root.pid) continue;
              const current = table.get(pid);
              if (
                sameProcess(observed.record, current) &&
                current?.processGroupId !== root.pid
              ) {
                root.containmentSupported = false;
              }
            }
            const currentRoot = table.get(root.pid);
            if (
              currentRoot &&
              childActive(root.child) &&
              currentRoot.processGroupId !== root.pid
            ) {
              root.containmentSupported = false;
            }
            for (const [pid, record] of table) {
              if (record.processGroupId !== root.pid) continue;
              this.#observedIdentities.set(pid, {
                rootPid: root.pid,
                record,
              });
              this.#observedPids.add(pid);
            }
            continue;
          }

          const currentRoot = table.get(root.pid);
          const seeds = new Set<number>();
          if (currentRoot && childActive(root.child)) {
            seeds.add(root.pid);
            this.#observedIdentities.set(root.pid, {
              rootPid: root.pid,
              record: currentRoot,
            });
            this.#observedPids.add(root.pid);
          }
          for (const [pid, observed] of this.#observedIdentities) {
            if (
              observed.rootPid === root.pid &&
              sameProcess(observed.record, table.get(pid))
            ) {
              seeds.add(pid);
            }
          }
          for (const pid of descendantsOf(seeds, table)) {
            const current = table.get(pid);
            if (!current) continue;
            this.#observedIdentities.set(pid, {
              rootPid: root.pid,
              record: current,
            });
            this.#observedPids.add(pid);
          }
        }
        return true;
      })().finally(() => {
        this.#sampleTask = undefined;
      });
    }

    const sample = this.#sampleTask;
    let timeout: NodeJS.Timeout | undefined;
    const available = await Promise.race([
      sample,
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), boundedTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!available) {
      // A caller with a shorter absolute deadline must not reuse a stale table
      // while a longer background sample is still pending.
      this.#lastTable = undefined;
      this.#processTableAvailable = false;
    }
    return available;
  }

  public async prepareCancellation(): Promise<ManagedAgentCancellationReadiness> {
    const observedPids = (): number[] =>
      [...this.#observedPids].sort((left, right) => left - right);
    const unsupported = (
      reason: Exclude<ManagedAgentCancellationReadiness["reason"], "ready">,
    ): ManagedAgentCancellationReadiness => ({
      supported: false,
      reason,
      processTableAvailable: this.#processTableAvailable,
      containmentSupported: [...this.#roots.values()].every(
        ({ containmentSupported }) => containmentSupported,
      ),
      ownershipProven: false,
      observedPids: observedPids(),
    });

    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      for (const root of this.#roots.values()) {
        root.containmentSupported = false;
      }
      return unsupported("platform_unsupported");
    }
    if (!(await this.observeProcessTree())) {
      return unsupported("process_table_unavailable");
    }
    if (this.#roots.size !== 1) return unsupported("root_count_invalid");
    const root = [...this.#roots.values()][0]!;
    if (!childActive(root.child)) {
      root.containmentSupported = false;
      return unsupported("root_not_active");
    }
    if (!root.containmentSupported) {
      return unsupported("containment_escaped");
    }
    const currentRoot = this.#lastTable!.get(root.pid);
    if (!currentRoot || currentRoot.processGroupId !== root.pid) {
      root.containmentSupported = false;
      return unsupported("root_not_group_leader");
    }

    root.ownershipProven = true;
    return {
      supported: true,
      reason: "ready",
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: true,
      observedPids: observedPids(),
    };
  }

  #forceStopKillSynchronously(): void {
    if (this.#platform !== "darwin" && this.#platform !== "linux") return;
    for (const root of this.#roots.values()) {
      if (root.forceKillIssued || !childActive(root.child)) {
        continue;
      }
      // detached:true plus the still-active trusted ChildProcess handle are
      // sufficient signal authority even when ps evidence is unavailable.
      // Certification readiness remains false in that case. Second-resolution
      // lstart and workspace PIDs are never signal authority.
      if (!root.stopIssued) {
        const stopOutcome = this.#signalProcessGroup(root.pid, "SIGSTOP");
        root.stopIssued = stopOutcome === "sent";
        if (stopOutcome === "failure") {
          root.containmentSupported = false;
        }
      }
      const killOutcome = this.#signalProcessGroup(root.pid, "SIGKILL");
      root.forceKillIssued = killOutcome === "sent";
      if (killOutcome === "failure") {
        // Keep the active/stopped group anchored so emergencyCleanup can retry
        // SIGKILL safely, but certification evidence remains failed.
        root.containmentSupported = false;
      }
    }
  }

  async #currentObservation(
    startedAt: number,
    emergencyCleanupAttempted: boolean,
  ): Promise<ManagedAgentTeardownObservation> {
    const roots = [...this.#roots.values()];
    const alive = new Set<number>();
    for (const root of roots) {
      if (childActive(root.child)) alive.add(root.pid);
      if (!this.#processTableAvailable) continue;
      const table = this.#lastTable!;
      if (this.#platform !== "win32") {
        for (const [pid, record] of table) {
          if (record.processGroupId === root.pid) alive.add(pid);
        }
        const groupLiveness = this.#processGroupLiveness(root.pid);
        if (groupLiveness === "alive") alive.add(root.pid);
        if (groupLiveness === "unknown") {
          root.containmentSupported = false;
        }
      } else {
        for (const [pid, observed] of this.#observedIdentities) {
          if (
            observed.rootPid === root.pid &&
            sameProcess(observed.record, table.get(pid))
          ) {
            alive.add(pid);
          }
        }
      }
    }

    const processTableAvailable =
      roots.length === 0 || this.#processTableAvailable;
    const containmentSupported = roots.every(
      ({ containmentSupported: supported }) => supported,
    );
    const ownershipProven =
      roots.length > 0 && roots.every(({ ownershipProven }) => ownershipProven);
    const forceKillIssued =
      roots.length > 0 && roots.every(({ forceKillIssued }) => forceKillIssued);
    const elapsedMs = Math.max(0, this.#now() - startedAt);
    const quiescent =
      processTableAvailable && containmentSupported && alive.size === 0;
    return {
      quiescent,
      deadlineMet: quiescent,
      processTableAvailable,
      containmentSupported,
      ownershipProven,
      forceKillIssued,
      elapsedMs,
      observedPids: [...this.#observedPids].sort((left, right) => left - right),
      alivePidsAtDeadline: [...alive].sort((left, right) => left - right),
      emergencyCleanupAttempted,
    };
  }

  public async waitForQuiescence(
    timeoutMs: number,
  ): Promise<ManagedAgentTeardownObservation> {
    const startedAt = this.#now();
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    for (;;) {
      const elapsedBeforeSample = Math.max(0, this.#now() - startedAt);
      await this.observeProcessTree(
        Math.max(0, boundedTimeoutMs - elapsedBeforeSample),
      );
      const observation = await this.#currentObservation(startedAt, false);
      if (observation.quiescent) {
        return {
          ...observation,
          deadlineMet: observation.elapsedMs <= boundedTimeoutMs,
        };
      }
      if (observation.elapsedMs >= boundedTimeoutMs) {
        return { ...observation, deadlineMet: false };
      }
      await this.#delay(
        Math.min(QUIESCENCE_POLL_MS, boundedTimeoutMs - observation.elapsedMs),
      );
    }
  }

  public async emergencyCleanup(
    timeoutMs: number,
  ): Promise<ManagedAgentTeardownObservation> {
    const startedAt = this.#now();
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    this.#forceStopKillSynchronously();
    const confirmation = await this.waitForQuiescence(boundedTimeoutMs);
    const elapsedMs = Math.max(0, this.#now() - startedAt);
    return {
      ...confirmation,
      elapsedMs,
      deadlineMet: confirmation.quiescent && elapsedMs <= boundedTimeoutMs,
      emergencyCleanupAttempted: true,
    };
  }

  public dispose(): void {
    clearInterval(this.#sampler);
  }
}

export function createLocalManagedAgentProcessObserver(): ManagedAgentProcessObserver {
  return new LocalManagedAgentProcessObserver();
}
