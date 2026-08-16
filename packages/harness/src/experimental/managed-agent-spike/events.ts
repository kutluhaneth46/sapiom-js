import type {
  ManagedAgentPermissionEvidence,
  ManagedAgentProbeEvent,
  ManagedAgentSdkUsageEstimate,
  ManagedAgentTerminalClassification,
  ManagedAgentToolEvidence,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeSubtype(value: unknown): string | undefined {
  const subtype = optionalString(value);
  return subtype && /^[a-z0-9_-]{1,80}$/i.test(subtype) ? subtype : undefined;
}

function safeToolName(value: unknown): string {
  const toolName = optionalString(value);
  return toolName && /^[a-z0-9_-]{1,128}$/i.test(toolName)
    ? toolName
    : "unknown";
}

function contentBlocks(message: JsonRecord | undefined): readonly JsonRecord[] {
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((value) => {
    const block = asRecord(value);
    return block ? [block] : [];
  });
}

function sdkUsage(event: JsonRecord): ManagedAgentSdkUsageEstimate | undefined {
  const usage = asRecord(event.usage);
  const inputTokens = optionalNumber(usage?.input_tokens);
  const outputTokens = optionalNumber(usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const estimatedCostUsd = optionalNumber(event.total_cost_usd);
  return {
    authority: "sdk_non_authoritative",
    inputTokens,
    outputTokens,
    cacheCreationInputTokens:
      optionalNumber(usage?.cache_creation_input_tokens) ?? 0,
    cacheReadInputTokens: optionalNumber(usage?.cache_read_input_tokens) ?? 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

export class ManagedAgentEventRecorder {
  readonly #events: ManagedAgentProbeEvent[] = [];
  readonly #toolEvidence: ManagedAgentToolEvidence[] = [];
  readonly #permissionEvidence: ManagedAgentPermissionEvidence[] = [];
  readonly #runId: string;
  #terminalRecorded = false;
  #sessionId: string | undefined;
  #usage: ManagedAgentSdkUsageEstimate | undefined;
  #sdkResult:
    | { readonly isError: boolean; readonly subtype?: string }
    | undefined;

  public constructor(runId: string) {
    this.#runId = runId;
  }

  public get events(): readonly ManagedAgentProbeEvent[] {
    return this.#events;
  }

  public get toolEvidence(): readonly ManagedAgentToolEvidence[] {
    return this.#toolEvidence;
  }

  public get permissionEvidence(): readonly ManagedAgentPermissionEvidence[] {
    return this.#permissionEvidence;
  }

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public get usage(): ManagedAgentSdkUsageEstimate | undefined {
    return this.#usage;
  }

  public get result():
    | { readonly isError: boolean; readonly subtype?: string }
    | undefined {
    return this.#sdkResult;
  }

  #append(event: Omit<ManagedAgentProbeEvent, "sequence" | "runId">): void {
    this.#events.push({
      sequence: this.#events.length + 1,
      runId: this.#runId,
      ...event,
    });
  }

  public recordLifecycle(subtype: string): void {
    this.#append({
      type: "lifecycle",
      subtype: safeSubtype(subtype) ?? "unknown",
    });
  }

  public recordPermission(evidence: ManagedAgentPermissionEvidence): void {
    this.#permissionEvidence.push(evidence);
    this.#append({
      type: "permission",
      toolUseId: evidence.toolUseId,
      toolName: safeToolName(evidence.toolName),
      permissionDecision: evidence.decision,
      permissionReason: evidence.reason,
    });
  }

  public observeSdkEvent(rawEvent: unknown): void {
    const event = asRecord(rawEvent);
    const type = optionalString(event?.type);
    if (!event || !type) return;
    const subtype = safeSubtype(event.subtype);
    const sessionId = optionalString(event.session_id);
    if (sessionId) this.#sessionId = sessionId;

    if (type === "system" && subtype === "init") {
      this.#append({ type: "lifecycle", subtype: "sdk_init", sessionId });
      return;
    }

    const message = asRecord(event.message);
    const blocks = contentBlocks(message);
    if (type === "assistant" || type === "user") {
      this.#append({ type: "message", subtype: type, sessionId });
    }
    if (type === "assistant") {
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const toolUseId = optionalString(block.id);
        const toolName = safeToolName(block.name);
        this.#toolEvidence.push({ toolUseId, toolName, status: "requested" });
        this.#append({
          type: "tool_requested",
          toolUseId,
          toolName,
          sessionId,
        });
      }
    }
    if (type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const toolUseId = optionalString(block.tool_use_id);
        const isError = block.is_error === true;
        const matchingTool = [...this.#toolEvidence]
          .reverse()
          .find((tool) => tool.toolUseId === toolUseId);
        const toolName = matchingTool?.toolName ?? "unknown";
        this.#toolEvidence.push({
          toolUseId,
          toolName,
          status: isError ? "error" : "success",
        });
        this.#append({
          type: "tool_completed",
          toolUseId,
          toolName,
          isError,
          sessionId,
        });
      }
    }
    if (type === "result") {
      const isError = event.is_error === true || subtype !== "success";
      this.#sdkResult = { isError, ...(subtype ? { subtype } : {}) };
      this.#usage = sdkUsage(event);
      this.#append({
        type: "sdk_result",
        subtype,
        isError,
        sessionId,
      });
    }
  }

  public recordTerminal(terminal: ManagedAgentTerminalClassification): boolean {
    if (this.#terminalRecorded) return false;
    this.#terminalRecorded = true;
    this.#append({ type: "terminal", terminal, sessionId: this.#sessionId });
    return true;
  }
}
