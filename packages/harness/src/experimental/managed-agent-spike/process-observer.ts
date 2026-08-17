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
  /** POSIX process state used only to confirm an issued group stop. */
  readonly state?: string;
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
  identity?: ManagedAgentKernelProcessRecord;
  containmentSupported: boolean;
  ownershipProven: boolean;
  stopIssued: boolean;
  forceKillIssued: boolean;
}

type ToolProcessRole = "parent" | "child";

interface ToolProcessRegistration {
  readonly role: ToolProcessRole;
  readonly pid: number;
  readonly socket: NetSocket;
  accepted: boolean;
  closed: boolean;
  identity?: ManagedAgentKernelProcessRecord;
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
    ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
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
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    entries.push([
      Number(match[1]),
      {
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        state: match[4]!,
        startedAt: match[5]!,
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
 * fixture parent and child additionally authenticate over separate private
 * Unix-socket connections outside the workspace and keep those connections
 * open for their complete lifetimes. A random capability, a primary exact-Bash
 * policy latch, stable role identities, and fresh kernel ancestry prove that
 * every member of their detached group remains below the active owned root.
 * A tool-reported or cached PID/PGID never grants signal authority by itself.
 *
 * This is not universal built-in Bash containment or a process-tree killer.
 * Windows, an unavailable process table, missing lifetime channels, or
 * identity/ancestry drift fail certification closed. The fallback stops the
 * owned root first, revalidates all authority, then stops and revalidates the
 * exact fixture group before killing it. POSIX `lstart` remains one component
 * of fresh identity evidence, not standalone authority. Workspace PID-file
 * contents never enter this class.
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
  readonly #toolProcessRegistrations = new Map<
    ToolProcessRole,
    ToolProcessRegistration
  >();
  #toolProcessGroupId: number | undefined;
  #toolProcessRootPid: number | undefined;
  #toolProcessObservationComplete = false;
  #toolProcessObservationInvalid = false;
  #toolProcessStopIssued = false;
  #toolProcessForceKillIssued = false;
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
    let registration: ToolProcessRegistration | undefined;
    socket.once("close", () => {
      this.#toolControlSockets.delete(socket);
      if (!registration) return;
      const current = this.#toolProcessRegistrations.get(registration.role);
      if (current !== registration) return;
      if (this.#toolProcessObservationComplete) {
        registration.closed = true;
      } else {
        // A connection that disappears before readiness cannot reserve its
        // role. Clearing it transactionally permits the trusted process to
        // retry instead of leaving an unfinishable stale pending state.
        this.#toolProcessRegistrations.delete(registration.role);
      }
      void this.observeProcessTree();
    });
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
      let payload: {
        capability?: unknown;
        pid?: unknown;
        role?: unknown;
      };
      try {
        payload = JSON.parse(body.slice(0, newline)) as typeof payload;
      } catch {
        socket.destroy();
        return;
      }
      if (
        !this.#toolProcessContainmentArmed ||
        this.#toolProcessObservationComplete ||
        typeof payload.capability !== "string" ||
        !sameCapability(payload.capability, this.#toolControlCapability) ||
        (payload.role !== "parent" && payload.role !== "child") ||
        this.#toolProcessRegistrations.has(payload.role) ||
        typeof payload.pid !== "number" ||
        !Number.isSafeInteger(payload.pid) ||
        payload.pid <= 1
      ) {
        socket.destroy();
        return;
      }
      registration = {
        role: payload.role,
        pid: payload.pid,
        socket,
        accepted: false,
        closed: false,
      };
      this.#toolProcessRegistrations.set(payload.role, registration);
      void this.observeProcessTree();
    });
  }

  public bindAbortSignal(signal: AbortSignal): void {
    if (this.#boundSignals.has(signal)) return;
    this.#boundSignals.add(signal);
    signal.addEventListener(
      "abort",
      () => {
        this.#requestFallbackCleanupSynchronously();
      },
      { once: true },
    );
    if (signal.aborted) {
      this.#requestFallbackCleanupSynchronously();
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
    if (!this.#toolProcessContainmentArmed) return;
    const parent = this.#toolProcessRegistrations.get("parent");
    const child = this.#toolProcessRegistrations.get("child");
    if (
      !this.#toolProcessObservationComplete &&
      parent &&
      child &&
      !parent.socket.destroyed &&
      !child.socket.destroyed
    ) {
      const parentIdentity = table.get(parent.pid);
      const childIdentity = table.get(child.pid);
      const processGroupId = parentIdentity?.processGroupId;
      const hostProcessGroupId = table.get(process.pid)?.processGroupId;
      const groupLeaderIdentity =
        typeof processGroupId === "number"
          ? table.get(processGroupId)
          : undefined;
      const root =
        this.#roots.size === 1 ? [...this.#roots.values()][0] : undefined;
      const rootDescendants = root
        ? descendantsOf(new Set([root.pid]), table)
        : new Set<number>();
      const groupMemberPids =
        typeof processGroupId === "number"
          ? [...table.entries()].flatMap(([pid, record]) =>
              record.processGroupId === processGroupId ? [pid] : [],
            )
          : [];
      if (
        root &&
        childActive(root.child) &&
        table.get(root.pid)?.processGroupId === root.pid &&
        parentIdentity &&
        childIdentity &&
        typeof processGroupId === "number" &&
        typeof hostProcessGroupId === "number" &&
        processGroupId > 1 &&
        processGroupId !== hostProcessGroupId &&
        !this.#roots.has(processGroupId) &&
        parent.pid !== child.pid &&
        childIdentity.parentPid === parent.pid &&
        childIdentity.processGroupId === processGroupId &&
        groupLeaderIdentity?.processGroupId === processGroupId &&
        groupMemberPids.length > 0 &&
        groupMemberPids.every((pid) => rootDescendants.has(pid))
      ) {
        parent.identity = parentIdentity;
        child.identity = childIdentity;
        this.#toolProcessGroupId = processGroupId;
        this.#toolProcessRootPid = root.pid;
        for (const registration of [parent, child]) {
          if (registration.accepted) continue;
          registration.accepted = true;
          registration.socket.write('{"registered":true}\n');
        }
      }
    }

    const processGroupId = this.#toolProcessGroupId;
    if (typeof processGroupId === "number") {
      for (const [pid, record] of table) {
        if (record.processGroupId === processGroupId) {
          this.#observedPids.add(pid);
        }
      }
    }
    if (!this.#toolProcessObservationComplete) return;
    for (const registration of this.#toolProcessRegistrations.values()) {
      const current = table.get(registration.pid);
      if (
        !registration.closed &&
        current &&
        (!sameProcess(registration.identity, current) ||
          current.processGroupId !== processGroupId)
      ) {
        this.#toolProcessObservationInvalid = true;
      }
    }
  }

  #hasFreshToolAuthority(
    table: ManagedAgentKernelProcessTable,
    options: {
      readonly requireRootStopped: boolean;
      readonly requireToolStopped: boolean;
    },
  ): boolean {
    const rootPid = this.#toolProcessRootPid;
    const processGroupId = this.#toolProcessGroupId;
    const root =
      typeof rootPid === "number" ? this.#roots.get(rootPid) : undefined;
    const parent = this.#toolProcessRegistrations.get("parent");
    const child = this.#toolProcessRegistrations.get("child");
    if (
      !root ||
      !childActive(root.child) ||
      this.#toolProcessObservationInvalid ||
      typeof processGroupId !== "number" ||
      !parent?.accepted ||
      !parent.identity ||
      !child?.accepted ||
      !child.identity ||
      ![parent, child].some(
        ({ closed, socket }) => !closed && !socket.destroyed,
      )
    ) {
      return false;
    }

    const currentRoot = table.get(root.pid);
    const currentParent = table.get(parent.pid);
    const currentChild = table.get(child.pid);
    if (
      !currentRoot ||
      !currentParent ||
      !currentChild ||
      currentRoot.processGroupId !== root.pid ||
      (root.identity && !sameProcess(root.identity, currentRoot)) ||
      (options.requireRootStopped && !currentRoot.state?.includes("T")) ||
      !sameProcess(parent.identity, currentParent) ||
      currentParent.processGroupId !== processGroupId ||
      !sameProcess(child.identity, currentChild) ||
      currentChild.parentPid !== parent.pid ||
      currentChild.processGroupId !== processGroupId
    ) {
      return false;
    }

    const rootDescendants = descendantsOf(new Set([root.pid]), table);
    const groupMembers = [...table.entries()].filter(
      ([, record]) => record.processGroupId === processGroupId,
    );
    return (
      groupMembers.length > 0 &&
      groupMembers.every(
        ([pid, record]) =>
          rootDescendants.has(pid) &&
          (!options.requireToolStopped || record.state?.includes("T")),
      )
    );
  }

  public async observeProcessTree(
    timeoutMs = MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
  ): Promise<boolean> {
    if (this.#roots.size === 0 && !this.#toolProcessContainmentArmed) {
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
          (this.#toolProcessRegistrations.size === 2 &&
            !this.#toolProcessObservationInvalid)),
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
    if (!root.containmentSupported) {
      return unsupported("containment_escaped");
    }
    if (!childActive(root.child)) {
      return unsupported("root_not_active");
    }
    const currentRoot = this.#lastTable!.get(root.pid);
    if (!currentRoot || currentRoot.processGroupId !== root.pid) {
      root.containmentSupported = false;
      return unsupported("root_not_group_leader");
    }
    root.identity = currentRoot;
    if (this.#toolProcessContainmentArmed) {
      const parent = this.#toolProcessRegistrations.get("parent");
      const child = this.#toolProcessRegistrations.get("child");
      if (
        !this.#toolControlAvailable ||
        !parent?.accepted ||
        parent.closed ||
        parent.socket.destroyed ||
        !child?.accepted ||
        child.closed ||
        child.socket.destroyed ||
        typeof this.#toolProcessGroupId !== "number"
      ) {
        return unsupported("tool_process_not_registered");
      }
      if (this.#toolProcessObservationInvalid) {
        return unsupported("tool_process_identity_invalid");
      }
      if (
        !this.#hasFreshToolAuthority(this.#lastTable!, {
          requireRootStopped: false,
          requireToolStopped: false,
        })
      ) {
        return unsupported("tool_process_identity_invalid");
      }
      this.#toolProcessObservationComplete = true;
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

  #stopOwnedRootsSynchronously(): void {
    if (this.#platform !== "darwin" && this.#platform !== "linux") return;
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
  }

  #killOwnedRootsSynchronously(): void {
    if (this.#platform !== "darwin" && this.#platform !== "linux") return;
    for (const root of this.#roots.values()) {
      if (root.forceKillIssued || !childActive(root.child)) continue;
      const killOutcome = this.#signalProcessGroup(root.pid, "SIGKILL");
      root.forceKillIssued = killOutcome === "sent";
      if (killOutcome === "failure") root.containmentSupported = false;
    }
  }

  #requestFallbackCleanupSynchronously(): void {
    this.#fallbackCleanupRequested = true;
    this.#stopOwnedRootsSynchronously();
    if (
      !this.#toolProcessContainmentArmed ||
      !this.#toolProcessObservationComplete
    ) {
      this.#killOwnedRootsSynchronously();
    }
  }

  #advanceFallbackCleanup(): void {
    if (
      !this.#fallbackCleanupRequested ||
      this.#platform === "win32" ||
      !this.#processTableAvailable
    ) {
      return;
    }
    if (
      !this.#toolProcessContainmentArmed ||
      !this.#toolProcessObservationComplete
    ) {
      this.#killOwnedRootsSynchronously();
      return;
    }

    const processGroupId = this.#toolProcessGroupId;
    if (typeof processGroupId !== "number") return;
    const groupLiveness = this.#processGroupLiveness(processGroupId);
    if (groupLiveness === "gone") {
      this.#killOwnedRootsSynchronously();
      return;
    }
    if (groupLiveness !== "alive") return;

    const table = this.#lastTable!;
    if (
      !this.#hasFreshToolAuthority(table, {
        requireRootStopped: true,
        requireToolStopped: this.#toolProcessStopIssued,
      })
    ) {
      return;
    }
    if (!this.#toolProcessStopIssued) {
      const stopOutcome = this.#signalProcessGroup(processGroupId, "SIGSTOP");
      this.#toolProcessStopIssued = stopOutcome === "sent";
      if (stopOutcome === "gone") this.#killOwnedRootsSynchronously();
      return;
    }
    if (!this.#toolProcessForceKillIssued) {
      const killOutcome = this.#signalProcessGroup(processGroupId, "SIGKILL");
      this.#toolProcessForceKillIssued = killOutcome === "sent";
      if (killOutcome === "sent" || killOutcome === "gone") {
        this.#killOwnedRootsSynchronously();
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
    const toolRegistrations = [...this.#toolProcessRegistrations.values()];
    const toolProcessGroupId = this.#toolProcessGroupId;
    for (const registration of toolRegistrations) {
      if (!registration.closed && !registration.socket.destroyed) {
        alive.add(registration.pid);
      }
    }
    if (this.#processTableAvailable) {
      const table = this.#lastTable!;
      if (typeof toolProcessGroupId === "number") {
        for (const [pid, record] of table) {
          if (record.processGroupId === toolProcessGroupId) {
            alive.add(pid);
          }
        }
        const groupLiveness = this.#processGroupLiveness(toolProcessGroupId);
        if (groupLiveness === "alive") alive.add(toolProcessGroupId);
        if (groupLiveness === "unknown") {
          this.#toolProcessObservationInvalid = true;
        }
      }
      for (const registration of toolRegistrations) {
        if (table.has(registration.pid)) {
          alive.add(registration.pid);
        }
      }
    }

    const processTableAvailable =
      roots.length === 0 || this.#processTableAvailable;
    const toolProcessObservationComplete =
      !this.#toolProcessContainmentArmed ||
      this.#toolProcessObservationComplete;
    const toolProcessChannelsClosed =
      !this.#toolProcessContainmentArmed ||
      (this.#toolProcessObservationComplete &&
        toolRegistrations.length === 2 &&
        toolRegistrations.every(
          ({ closed, socket }) => closed || socket.destroyed,
        ));
    const containmentSupported =
      roots.every(({ containmentSupported: supported }) => supported) &&
      (!this.#toolProcessContainmentArmed ||
        (this.#toolControlAvailable &&
          this.#toolProcessObservationComplete &&
          !this.#toolProcessObservationInvalid));
    const ownershipProven =
      roots.length > 0 &&
      roots.every(({ ownershipProven }) => ownershipProven) &&
      toolProcessObservationComplete;
    const forceKillIssued =
      roots.length > 0 && roots.every(({ forceKillIssued }) => forceKillIssued);
    const elapsedMs = Math.max(0, this.#now() - startedAt);
    const quiescent =
      processTableAvailable &&
      containmentSupported &&
      toolProcessChannelsClosed &&
      alive.size === 0;
    return {
      quiescent,
      deadlineMet: quiescent,
      processTableAvailable,
      containmentSupported,
      ownershipProven,
      forceKillIssued,
      toolProcessObservationComplete,
      toolProcessChannelsClosed,
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
      this.#advanceFallbackCleanup();
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
    this.#requestFallbackCleanupSynchronously();
    const confirmation = await this.waitForQuiescence(boundedTimeoutMs);
    if (!confirmation.quiescent) this.#killOwnedRootsSynchronously();
    const elapsedMs = Math.max(0, this.#now() - startedAt);
    const roots = [...this.#roots.values()];
    const forceKillIssued =
      roots.length > 0 && roots.every((root) => root.forceKillIssued);
    return {
      ...confirmation,
      forceKillIssued,
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
