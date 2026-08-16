import { describe, expect, it } from "vitest";

import { ManagedAgentEventRecorder } from "./events.js";

describe("ManagedAgentEventRecorder", () => {
  it("retains structural evidence while redacting message and tool content", () => {
    const recorder = new ManagedAgentEventRecorder("run-1");
    recorder.observeSdkEvent({
      type: "system",
      subtype: "init",
      session_id: "session-1",
      model: "model-secret-must-not-be-copied",
    });
    recorder.observeSdkEvent({
      type: "assistant",
      session_id: "session-1",
      message: {
        id: "message-1",
        content: [
          { type: "text", text: "prompt-secret" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/private/secret-path", token: "tool-secret" },
          },
        ],
      },
    });
    recorder.observeSdkEvent({
      type: "user",
      session_id: "session-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "private-file-contents",
            is_error: false,
          },
        ],
      },
    });
    recorder.observeSdkEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-1",
      result: "private-final-answer",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
      },
      total_cost_usd: 0.001,
    });
    expect(recorder.recordTerminal("success")).toBe(true);
    expect(recorder.recordTerminal("query_error")).toBe(false);

    expect(recorder.sessionId).toBe("session-1");
    expect(recorder.usage).toEqual({
      authority: "sdk_non_authoritative",
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 1,
      estimatedCostUsd: 0.001,
    });
    expect(recorder.toolEvidence).toEqual([
      { toolUseId: "tool-1", toolName: "Read", status: "requested" },
      { toolUseId: "tool-1", toolName: "Read", status: "success" },
    ]);
    expect(
      recorder.events.filter(({ type }) => type === "terminal"),
    ).toHaveLength(1);
    const serialized = JSON.stringify(recorder.events);
    for (const secret of [
      "model-secret",
      "prompt-secret",
      "/private/secret-path",
      "tool-secret",
      "private-file-contents",
      "private-final-answer",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("normalizes an attacker-controlled tool name instead of persisting it", () => {
    const recorder = new ManagedAgentEventRecorder("run-2");
    recorder.observeSdkEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "Read secret=credential.value",
            input: {},
          },
        ],
      },
    });
    expect(recorder.toolEvidence[0]?.toolName).toBe("unknown");
    expect(JSON.stringify(recorder.events)).not.toContain("credential.value");
  });
});
