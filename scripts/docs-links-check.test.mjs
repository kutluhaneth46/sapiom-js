import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDocsLinks,
  validateDocsLinkContent,
} from "./docs-links-check.mjs";

test("accepts canonical docs routes with fragments and punctuation", () => {
  const source = [
    "See https://docs.sapiom.ai/agents/authoring.",
    "Then https://docs.sapiom.ai/capabilities/compute#sandbox-previews.",
  ].join("\n");

  assert.deepEqual(validateDocsLinkContent("README.md", source), []);
  assert.deepEqual(extractDocsLinks(source), [
    "https://docs.sapiom.ai/agents/authoring",
    "https://docs.sapiom.ai/capabilities/compute#sandbox-previews",
  ]);
});

test("rejects a redirecting or nonexistent route at the emitting file", () => {
  assert.deepEqual(
    validateDocsLinkContent(
      "packages/example.ts",
      "Visit https://docs.sapiom.ai/integration/mcp-servers/setup",
    ),
    [
      "packages/example.ts:1 emits noncanonical docs route /integration/mcp-servers/setup",
    ],
  );
});
