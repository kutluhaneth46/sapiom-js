import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { query as agentSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  fixturePathExists,
} from "./fixture.js";
import {
  qualifiedManagedAgentMcpToolName,
  runManagedAgentProbe,
} from "./runtime.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXECUTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL_ALIAS = "claude-sonnet-5-anthropic-anthropic-eval";
const EVAL_SOURCE =
  "studio-managed-agent-e0-l1-sonnet-5-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CORRELATION_MARKER = `SAPIOM_CERTIFICATION_CORRELATION_V1;eval_source=${EVAL_SOURCE};execution_id=${EXECUTION_ID}`;
const ALLOWED_BASH_COMMAND = "git status --short";
const DENIED_BASH_COMMAND = "touch denied-side-effect.txt";
const ECHO_NONCE_TOOL = qualifiedManagedAgentMcpToolName("echo_nonce");

interface LoopbackObservation {
  readonly headerNames: readonly string[];
  readonly evalSourceMatches: boolean;
  readonly executionIdMatches: boolean;
  readonly promptMarkerPresent: boolean;
  readonly mcpResultMatches: boolean;
}

function containsExactText(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsExactText(entry, expected));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) =>
    containsExactText(entry, expected),
  );
}

function hasSuccessfulMcpResult(body: string, expectedNonce: string): boolean {
  try {
    const payload = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(payload.messages)) return false;
    return payload.messages.some((message) => {
      if (typeof message !== "object" || message === null) return false;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) return false;
      return content.some((block) => {
        if (typeof block !== "object" || block === null) return false;
        const result = block as Record<string, unknown>;
        return (
          result.type === "tool_result" &&
          result.tool_use_id === "toolu_loopback_mcp_echo" &&
          result.is_error !== true &&
          containsExactText(result.content, expectedNonce)
        );
      });
    });
  } catch {
    return false;
  }
}

function writeSseEvent(
  response: ServerResponse,
  event: string,
  data: Record<string, unknown>,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeToolUseResponse(
  response: ServerResponse,
  turn: number,
  toolUse: {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  },
): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    "request-id": `req_loopback_${turn}`,
  });
  writeSseEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: `msg_loopback_${turn}`,
      type: "message",
      role: "assistant",
      model: MODEL_ALIAS,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  writeSseEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: {},
    },
  });
  writeSseEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify(toolUse.input),
    },
  });
  writeSseEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSseEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSseEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function writeFinalResponse(response: ServerResponse, turn: number): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    "request-id": `req_loopback_${turn}`,
  });
  writeSseEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: `msg_loopback_${turn}`,
      type: "message",
      role: "assistant",
      model: MODEL_ALIAS,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  writeSseEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeSseEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "done" },
  });
  writeSseEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSseEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSseEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

it("enforces real-SDK built-in and in-process MCP calls with exact loopback correlation", async () => {
  const fixture = await createManagedAgentFixture(() => "loopback-nonce");
  const observations: LoopbackObservation[] = [];
  let helloCount = 0;
  let inferenceTurn = 0;
  const server = createServer((request, response) => {
    if (request.method === "HEAD" && request.url === "/api/hello") {
      helloCount += 1;
      response.writeHead(200).end();
      return;
    }
    if (
      request.method !== "POST" ||
      request.url?.split("?")[0] !== "/v1/messages"
    ) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on("end", () => {
      inferenceTurn += 1;
      const headerNames = Object.keys(request.headers).sort();
      observations.push({
        headerNames,
        evalSourceMatches:
          request.headers["x-sapiom-eval-source"] === EVAL_SOURCE,
        executionIdMatches:
          request.headers["x-sapiom-execution-id"] === EXECUTION_ID,
        promptMarkerPresent: body.includes(CORRELATION_MARKER),
        mcpResultMatches: hasSuccessfulMcpResult(body, fixture.nonce),
      });
      if (inferenceTurn === 1) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_read",
          name: "Read",
          input: { file_path: FIXTURE_PATHS.cleanTarget },
        });
      } else if (inferenceTurn === 2) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_bash_allow",
          name: "Bash",
          input: { command: ALLOWED_BASH_COMMAND },
        });
      } else if (inferenceTurn === 3) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_bash_deny",
          name: "Bash",
          input: { command: DENIED_BASH_COMMAND },
        });
      } else if (inferenceTurn === 4) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_mcp_echo",
          name: ECHO_NONCE_TOOL,
          input: { nonce: fixture.nonce },
        });
      } else {
        writeFinalResponse(response, inferenceTurn);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const ids = [RUN_ID, EXECUTION_ID];
    const result = await runManagedAgentProbe(
      {
        scenario: "L1",
        workspaceRoot: fixture.workspaceRoot,
        configRoot: fixture.configRoot,
        target: "sonnet-5",
        gatewayOrigin: `http://127.0.0.1:${address.port}`,
        gatewayCredential: "sk-ant-api03-local-loopback-only",
        prompt: fixture.prompt("L1"),
        maxTurns: 6,
        maxBudgetUsd: 0.25,
        allowedBashCommands: [ALLOWED_BASH_COMMAND],
        expectedMcpNonce: fixture.nonce,
        preservePaths: [
          FIXTURE_PATHS.dirtySentinel,
          FIXTURE_PATHS.untrackedSentinel,
        ],
      },
      {
        hermeticGatewayOrigin: `http://127.0.0.1:${address.port}`,
        queryFactory: ({ prompt, options }) =>
          agentSdkQuery({ prompt, options }),
        uuid: () => {
          const id = ids.shift();
          if (!id) throw new Error("unexpected UUID request");
          return id;
        },
      },
    );

    expect(helloCount).toBeGreaterThanOrEqual(1);
    expect(observations).toHaveLength(5);
    expect(
      observations.every(
        ({ headerNames, evalSourceMatches, executionIdMatches }) =>
          headerNames.includes("x-sapiom-eval-source") &&
          headerNames.includes("x-sapiom-execution-id") &&
          evalSourceMatches &&
          executionIdMatches,
      ),
    ).toBe(true);
    expect(
      observations.every(({ promptMarkerPresent }) => promptMarkerPresent),
    ).toBe(true);
    expect(
      observations.map(({ mcpResultMatches }) => mcpResultMatches),
    ).toEqual([false, false, false, false, true]);
    expect(result.terminal).toBe("success");

    const requested = result.toolEvidence.filter(
      ({ status }) => status === "requested",
    );
    expect(requested.map(({ toolName }) => toolName)).toEqual([
      "Read",
      "Bash",
      "Bash",
      ECHO_NONCE_TOOL,
    ]);
    for (const tool of requested) {
      expect(
        result.permissionEvidence.filter(
          ({ toolUseId, source }) =>
            toolUseId === tool.toolUseId && source === "pre_tool_use",
        ),
      ).toHaveLength(1);
    }
    expect(result.permissionEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "Read",
          decision: "allow",
          reason: "fixture_path",
          source: "pre_tool_use",
        }),
        expect.objectContaining({
          toolName: "Bash",
          decision: "allow",
          reason: "exact_bash_command",
          source: "pre_tool_use",
        }),
        expect.objectContaining({
          toolName: "Bash",
          decision: "deny",
          reason: "bash_command_not_allowed",
          source: "pre_tool_use",
        }),
        expect.objectContaining({
          toolName: ECHO_NONCE_TOOL,
          decision: "allow",
          reason: "managed_mcp_tool",
          source: "pre_tool_use",
        }),
      ]),
    );
    expect(result.toolEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "Read", status: "success" }),
        expect.objectContaining({ toolName: "Bash", status: "success" }),
        expect.objectContaining({ toolName: "Bash", status: "error" }),
      ]),
    );
    const requestedMcp = requested.find(
      ({ toolName }) => toolName === ECHO_NONCE_TOOL,
    );
    expect(requestedMcp?.toolUseId).toBeDefined();
    expect(
      result.toolEvidence.filter(
        ({ toolName, toolUseId, status }) =>
          toolName === ECHO_NONCE_TOOL &&
          toolUseId === requestedMcp?.toolUseId &&
          status === "success",
      ),
    ).toHaveLength(1);
    expect(
      result.toolEvidence.filter(
        ({ toolName, toolUseId }) =>
          toolName === ECHO_NONCE_TOOL && toolUseId === undefined,
      ),
    ).toEqual([{ toolName: ECHO_NONCE_TOOL, status: "success" }]);
    expect(result.policyHookCoverage).toBe(true);
    expect(
      await fixturePathExists(
        join(fixture.workspaceRoot, "denied-side-effect.txt"),
      ),
    ).toBe(false);
    expect(result.queryClosed).toBe(true);
    expect(result.teardown.quiescent).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.cleanup();
  }
}, 45_000);
