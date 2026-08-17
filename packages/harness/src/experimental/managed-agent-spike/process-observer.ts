import {
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const MANAGED_AGENT_SUPERVISOR_PAYLOAD_ENV =
  "SAPIOM_MANAGED_AGENT_SUPERVISOR_PAYLOAD";
export const MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV =
  "SAPIOM_MANAGED_AGENT_TOOL_CONTROL_SOCKET";
export const MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV =
  "SAPIOM_MANAGED_AGENT_TOOL_CONTROL_CAPABILITY";
const TOOL_REGISTRATION_MAX_BYTES = 1_024;

/**
 * The POSIX supervisor is the observer-owned process-group leader. The real
 * SDK command runs inside its group, while the supervisor stays alive after
 * an inner-root exit whenever another group member survives. Its own bounded
 * `ps` helper remains in the group so abort and parent-disconnect cleanup
 * contain it too; the known helper PID is excluded only from the membership
 * decision that determines whether the anchor may exit.
 */
const MANAGED_AGENT_POSIX_SUPERVISOR_SOURCE = String.raw`
import { spawn } from "node:child_process";

const PAYLOAD_ENV = "SAPIOM_MANAGED_AGENT_SUPERVISOR_PAYLOAD";
const HELPER_TIMEOUT_MS = 200;
const POLL_INTERVAL_MS = 25;
const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024;

function fail(message) {
  try { process.stderr.write(message + "\n"); } catch {}
  process.exit(1);
}

const encodedPayload = process.env[PAYLOAD_ENV];
delete process.env[PAYLOAD_ENV];
if (!encodedPayload) fail("managed-agent supervisor payload missing");

let payload;
try {
  payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
} catch {
  fail("managed-agent supervisor payload invalid");
}
if (
  !payload ||
  typeof payload.command !== "string" ||
  payload.command.length === 0 ||
  !Array.isArray(payload.args) ||
  !payload.args.every((argument) => typeof argument === "string")
) {
  fail("managed-agent supervisor command invalid");
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {});
}

function killOwnedGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}

process.on("disconnect", killOwnedGroup);

function readOtherGroupMembers() {
  return new Promise((resolveMembers) => {
    let helper;
    try {
      // Intentionally non-detached: the helper is synchronously contained by
      // the same group. Its known PID is excluded from this one snapshot.
      helper = spawn("/bin/ps", ["-axo", "pid=,pgid="], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolveMembers(undefined);
      return;
    }
    const helperPid = helper.pid;
    let output = "";
    let settled = false;
    let overflowed = false;
    const finish = (members) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveMembers(members);
    };
    const timeout = setTimeout(() => {
      try { helper.kill("SIGKILL"); } catch {}
      finish(undefined);
    }, HELPER_TIMEOUT_MS);
    helper.stdout.on("data", (chunk) => {
      if (overflowed) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_PROCESS_TABLE_BYTES) {
        overflowed = true;
        try { helper.kill("SIGKILL"); } catch {}
      }
    });
    helper.once("error", () => finish(undefined));
    helper.once("close", (code) => {
      if (code !== 0 || overflowed || typeof helperPid !== "number") {
        finish(undefined);
        return;
      }
      const records = new Map();
      for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) continue;
        records.set(Number(match[1]), Number(match[2]));
      }
      if (
        records.get(process.pid) !== process.pid ||
        records.get(helperPid) !== process.pid
      ) {
        finish(undefined);
        return;
      }
      finish(
        [...records.entries()]
          .filter(
            ([pid, processGroupId]) =>
              processGroupId === process.pid &&
              pid !== process.pid &&
              pid !== helperPid,
          )
          .map(([pid]) => pid),
      );
    });
  });
}

let innerClosed = false;
let innerExitCode = 1;
let membershipCheckRunning = false;
let pollTimer;

function scheduleMembershipCheck(delayMs = 0) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(checkMembership, delayMs);
}

async function checkMembership() {
  pollTimer = undefined;
  if (!innerClosed || membershipCheckRunning) return;
  membershipCheckRunning = true;
  const members = await readOtherGroupMembers();
  membershipCheckRunning = false;
  if (members && members.length === 0) {
    process.stdin.unpipe();
    process.stdin.destroy();
    if (process.connected) {
      process.off("disconnect", killOwnedGroup);
      process.disconnect();
    }
    process.exitCode = innerExitCode;
    return;
  }
  scheduleMembershipCheck(POLL_INTERVAL_MS);
}

let inner;
try {
  inner = spawn(payload.command, payload.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
} catch {
  innerClosed = true;
  scheduleMembershipCheck();
}

if (inner) {
  process.stdin.on("error", () => {});
  inner.stdin.on("error", () => {});
  inner.stdout.on("error", () => {});
  inner.stderr.on("error", () => {});
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.stdin.pipe(inner.stdin);
  inner.stdout.pipe(process.stdout, { end: false });
  inner.stderr.pipe(process.stderr, { end: false });
  inner.once("error", () => {
    innerExitCode = 1;
  });
  inner.once("close", (code) => {
    innerClosed = true;
    innerExitCode = Number.isInteger(code) ? code : 1;
    scheduleMembershipCheck();
  });
}
`;

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

interface PendingToolRegistration {
  readonly pid: number;
  readonly socket: NetSocket;
}

interface OwnedToolGroup {
  readonly registeredPid: number;
  readonly registeredIdentity: ManagedAgentKernelProcessRecord;
  readonly processGroupId: number;
  readonly groupLeaderIdentity?: ManagedAgentKernelProcessRecord;
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

function sameCapability(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
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
 * E0.4 deliberately certifies one narrow containment model. The SDK command
 * runs in an observer-owned POSIX process group. The exact host-created L2
 * fixture additionally authenticates over a private one-shot Unix socket
 * outside the workspace and keeps that connection open. A random capability,
 * a primary exact-Bash policy latch, and a fresh kernel table jointly grant
 * fallback signal authority for the fixture's distinct PGID. The capability
 * remains sufficient if SDK cleanup has already reparented the live fixture;
 * this exception is safe only because L2 permits one immutable trusted command.
 *
 * This is not universal built-in Bash containment or a process-tree killer.
 * Windows, an unavailable process table, an unauthenticated tool process, or
 * identity drift fail certification closed. POSIX `lstart` remains evidence,
 * not authority. Workspace PID-file contents never enter this class and can
 * never become signal authority.
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
  readonly #toolControlCapability = randomBytes(32).toString("base64url");
  readonly #toolControlSockets = new Set<NetSocket>();
  #toolControlDirectory: string | undefined;
  #toolControlSocketPath: string | undefined;
  #toolControlServer: NetServer | undefined;
  #toolControlAvailable = false;
  #toolControlFailed = false;
  #toolProcessContainmentArmed = false;
  #pendingToolRegistration: PendingToolRegistration | undefined;
  #ownedToolGroup: OwnedToolGroup | undefined;
  #fallbackCleanupRequested = false;
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
    if (this.#platform === "darwin" || this.#platform === "linux") {
      this.#startToolControlServer();
    }
    this.#sampler = setInterval(
      () => void this.observeProcessTree(),
      SAMPLE_INTERVAL_MS,
    );
    this.#sampler.unref();
  }

  #startToolControlServer(): void {
    try {
      const directory = mkdtempSync(
        join(tmpdir(), "sapiom-managed-agent-control-"),
      );
      chmodSync(directory, 0o700);
      const socketPath = join(directory, "tool.sock");
      const server = createServer((socket) =>
        this.#receiveToolRegistration(socket),
      );
      this.#toolControlDirectory = directory;
      this.#toolControlSocketPath = socketPath;
      this.#toolControlServer = server;
      server.once("listening", () => {
        this.#toolControlAvailable = true;
      });
      server.on("error", () => {
        this.#toolControlAvailable = false;
        this.#toolControlFailed = true;
      });
      server.listen(socketPath);
      server.unref();
    } catch {
      this.#toolControlAvailable = false;
      this.#toolControlFailed = true;
    }
  }

  #receiveToolRegistration(socket: NetSocket): void {
    this.#toolControlSockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => this.#toolControlSockets.delete(socket));
    let body = "";
    let handled = false;
    const reject = (): void => {
      handled = true;
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > TOOL_REGISTRATION_MAX_BYTES) {
        reject();
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let payload: { capability?: unknown; pid?: unknown };
      try {
        payload = JSON.parse(body.slice(0, newline)) as typeof payload;
      } catch {
        socket.destroy();
        return;
      }
      if (
        !this.#toolProcessContainmentArmed ||
        this.#pendingToolRegistration ||
        this.#ownedToolGroup ||
        typeof payload.capability !== "string" ||
        !sameCapability(payload.capability, this.#toolControlCapability) ||
        typeof payload.pid !== "number" ||
        !Number.isSafeInteger(payload.pid) ||
        payload.pid <= 1
      ) {
        socket.destroy();
        return;
      }
      this.#pendingToolRegistration = { pid: payload.pid, socket };
      void this.observeProcessTree();
    });
  }

  public bindAbortSignal(signal: AbortSignal): void {
    if (this.#boundSignals.has(signal)) return;
    this.#boundSignals.add(signal);
    signal.addEventListener(
      "abort",
      () => {
        this.#fallbackCleanupRequested = true;
        this.#forceStopKillSynchronously();
      },
      { once: true },
    );
    if (signal.aborted) {
      this.#fallbackCleanupRequested = true;
      this.#forceStopKillSynchronously();
    }
  }

  public armToolProcessContainment(): void {
    if (this.#toolProcessContainmentArmed) return;
    this.#toolProcessContainmentArmed = true;
    if (this.#toolControlFailed) {
      for (const root of this.#roots.values()) {
        root.containmentSupported = false;
      }
    }
  }

  public spawn(options: SpawnOptions): SpawnedProcess {
    const usePosixSupervisor =
      this.#platform === "darwin" || this.#platform === "linux";
    const child = (
      usePosixSupervisor
        ? spawnChild(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              MANAGED_AGENT_POSIX_SUPERVISOR_SOURCE,
            ],
            {
              cwd: options.cwd,
              env: {
                ...options.env,
                [MANAGED_AGENT_SUPERVISOR_PAYLOAD_ENV]: Buffer.from(
                  JSON.stringify({
                    command: options.command,
                    args: options.args,
                  }),
                  "utf8",
                ).toString("base64url"),
                ...(this.#toolControlSocketPath
                  ? {
                      [MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV]:
                        this.#toolControlSocketPath,
                      [MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV]:
                        this.#toolControlCapability,
                    }
                  : {}),
              },
              detached: true,
              stdio: ["pipe", "pipe", "pipe", "ipc"],
              windowsHide: true,
            },
          )
        : spawnChild(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            detached: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
    ) as ChildProcessWithoutNullStreams;
    // SpawnedProcess does not expose stderr to the SDK transport. Drain it
    // here without retaining or printing content so a noisy inner command
    // cannot deadlock the supervisor on pipe backpressure.
    child.stderr.on("data", () => undefined);
    child.stderr.on("error", () => undefined);
    if (typeof child.pid === "number") {
      const pid = child.pid;
      if (usePosixSupervisor) {
        let groupKillRequested = false;
        Object.defineProperty(child, "killed", {
          configurable: true,
          enumerable: true,
          get: () => groupKillRequested,
        });
        child.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
          try {
            process.kill(-pid, signal);
            groupKillRequested = true;
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              return false;
            }
            throw error;
          }
        }) as typeof child.kill;
      }
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
      // graceful close. Keep it as an idempotent fallback; runtime deliberately
      // does not bind the raw Options.abortController to host process signals.
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

  #observeToolProcessContainment(table: ManagedAgentKernelProcessTable): void {
    const pending = this.#pendingToolRegistration;
    if (pending && !pending.socket.destroyed && !this.#ownedToolGroup) {
      const registeredIdentity = table.get(pending.pid);
      const processGroupId = registeredIdentity?.processGroupId;
      const hostProcessGroupId = table.get(process.pid)?.processGroupId;
      if (
        registeredIdentity &&
        typeof processGroupId === "number" &&
        typeof hostProcessGroupId === "number" &&
        processGroupId > 1 &&
        processGroupId !== hostProcessGroupId &&
        !this.#roots.has(processGroupId)
      ) {
        const groupLeaderIdentity = table.get(processGroupId);
        if (
          !groupLeaderIdentity ||
          groupLeaderIdentity.processGroupId === processGroupId
        ) {
          this.#ownedToolGroup = {
            registeredPid: pending.pid,
            registeredIdentity,
            processGroupId,
            ...(groupLeaderIdentity ? { groupLeaderIdentity } : {}),
            containmentSupported: true,
            ownershipProven: true,
            stopIssued: false,
            forceKillIssued: false,
          };
          this.#pendingToolRegistration = undefined;
          pending.socket.write('{"registered":true}\n');
        }
      }
    }

    const owned = this.#ownedToolGroup;
    if (!owned) return;
    const currentRegistered = table.get(owned.registeredPid);
    if (
      currentRegistered &&
      (!sameProcess(owned.registeredIdentity, currentRegistered) ||
        currentRegistered.processGroupId !== owned.processGroupId)
    ) {
      owned.containmentSupported = false;
    }
    if (owned.groupLeaderIdentity) {
      const currentLeader = table.get(owned.processGroupId);
      if (
        currentLeader &&
        !sameProcess(owned.groupLeaderIdentity, currentLeader)
      ) {
        owned.containmentSupported = false;
      }
    }
    for (const [pid, record] of table) {
      if (record.processGroupId === owned.processGroupId) {
        this.#observedPids.add(pid);
      }
    }
    if (this.#fallbackCleanupRequested) this.#forceStopKillSynchronously();
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
        this.#observeToolProcessContainment(table);
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
      containmentSupported:
        [...this.#roots.values()].every(
          ({ containmentSupported }) => containmentSupported,
        ) &&
        (!this.#toolProcessContainmentArmed ||
          Boolean(this.#ownedToolGroup?.containmentSupported)),
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
    if (this.#toolProcessContainmentArmed) {
      if (
        !this.#toolControlAvailable ||
        !this.#ownedToolGroup ||
        !this.#ownedToolGroup.ownershipProven
      ) {
        return unsupported("tool_process_not_registered");
      }
      if (!this.#ownedToolGroup.containmentSupported) {
        return unsupported("tool_process_identity_invalid");
      }
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
    this.#fallbackCleanupRequested = true;
    for (const root of this.#roots.values()) {
      if (root.forceKillIssued || !childActive(root.child)) continue;
      if (!root.stopIssued) {
        const stopOutcome = this.#signalProcessGroup(root.pid, "SIGSTOP");
        root.stopIssued = stopOutcome === "sent";
        if (stopOutcome === "failure") {
          root.containmentSupported = false;
        }
      }
    }
    const toolGroup = this.#ownedToolGroup;
    if (
      toolGroup &&
      toolGroup.containmentSupported &&
      !toolGroup.forceKillIssued &&
      !toolGroup.stopIssued
    ) {
      const stopOutcome = this.#signalProcessGroup(
        toolGroup.processGroupId,
        "SIGSTOP",
      );
      toolGroup.stopIssued = stopOutcome === "sent";
      if (stopOutcome === "failure") {
        toolGroup.containmentSupported = false;
      }
    }
    if (
      toolGroup &&
      toolGroup.containmentSupported &&
      !toolGroup.forceKillIssued
    ) {
      const killOutcome = this.#signalProcessGroup(
        toolGroup.processGroupId,
        "SIGKILL",
      );
      toolGroup.forceKillIssued = killOutcome === "sent";
      if (killOutcome === "failure") {
        toolGroup.containmentSupported = false;
      }
    }
    for (const root of this.#roots.values()) {
      if (root.forceKillIssued || !childActive(root.child)) continue;
      const killOutcome = this.#signalProcessGroup(root.pid, "SIGKILL");
      root.forceKillIssued = killOutcome === "sent";
      if (killOutcome === "failure") root.containmentSupported = false;
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
    const toolGroup = this.#ownedToolGroup;
    if (this.#processTableAvailable) {
      const table = this.#lastTable!;
      if (toolGroup) {
        for (const [pid, record] of table) {
          if (record.processGroupId === toolGroup.processGroupId)
            alive.add(pid);
        }
        const groupLiveness = this.#processGroupLiveness(
          toolGroup.processGroupId,
        );
        if (groupLiveness === "alive") alive.add(toolGroup.processGroupId);
        if (groupLiveness === "unknown") {
          toolGroup.containmentSupported = false;
        }
      } else if (this.#pendingToolRegistration) {
        if (table.has(this.#pendingToolRegistration.pid)) {
          alive.add(this.#pendingToolRegistration.pid);
        }
      }
    }

    const processTableAvailable =
      roots.length === 0 || this.#processTableAvailable;
    const containmentSupported =
      roots.every(({ containmentSupported: supported }) => supported) &&
      (!this.#toolProcessContainmentArmed ||
        (this.#toolControlAvailable &&
          Boolean(toolGroup?.containmentSupported)));
    const ownershipProven =
      roots.length > 0 &&
      roots.every(({ ownershipProven }) => ownershipProven) &&
      (!this.#toolProcessContainmentArmed ||
        Boolean(toolGroup?.ownershipProven));
    const forceKillIssued =
      roots.length > 0 &&
      roots.every(({ forceKillIssued }) => forceKillIssued) &&
      (!this.#toolProcessContainmentArmed ||
        Boolean(toolGroup?.forceKillIssued));
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
    for (const socket of this.#toolControlSockets) socket.destroy();
    this.#toolControlSockets.clear();
    this.#toolControlServer?.close();
    if (this.#toolControlDirectory) {
      try {
        rmSync(this.#toolControlDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort removal after the private listener and clients close.
      }
    }
  }
}

export function createLocalManagedAgentProcessObserver(): ManagedAgentProcessObserver {
  return new LocalManagedAgentProcessObserver();
}
