import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeWorkspaceAgentConversation,
  decodeWorkspaceAgentConversation,
  workspaceAgentConversationMode,
} from "../src/workspace-agent-conversation.ts";

test("Workspace Agent retry conversation keeps the original brief and the current correction", () => {
  const original = "3 directions: cinematic, paper, cobalt. Each has Home, Film, Schedule, Checkout.";
  const current = "Retry all requested pages as new items.";

  const encoded = composeWorkspaceAgentConversation(current, original);

  assert.deepEqual(decodeWorkspaceAgentConversation(encoded), {
    priorRequests: [original],
    currentRequest: current,
  });
});

test("Workspace Agent retry conversation flattens a previous envelope instead of nesting it", () => {
  const original = "Create Home and Film.";
  const firstRetry = "Preserve both requested Pages.";
  const secondRetry = "Generate them as new items.";
  const previous = composeWorkspaceAgentConversation(firstRetry, original);

  const encoded = composeWorkspaceAgentConversation(secondRetry, previous);

  assert.deepEqual(decodeWorkspaceAgentConversation(encoded), {
    priorRequests: [original, firstRetry],
    currentRequest: secondRetry,
  });
});

test("Workspace Agent retry conversation preserves the current request within the 64 KiB transport limit", () => {
  const current = "Current request must win.";
  const encoded = composeWorkspaceAgentConversation(current, "x".repeat(96 * 1024));

  assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);
  const decoded = decodeWorkspaceAgentConversation(encoded);
  assert.equal(decoded.currentRequest, current);
  assert.ok(decoded.priorRequests[0]!.length > 0);
  assert.ok(Buffer.byteLength(decoded.priorRequests[0]!, "utf8") <= 32 * 1024);
});

test("Workspace Agent continuation requires an explicit retry verb or a clear prior-request reference", () => {
  assert.equal(
    workspaceAgentConversationMode("Keep typography restrained and create a settings page."),
    "replace",
  );
  assert.equal(workspaceAgentConversationMode("保持简洁，创建设置页面。"), "replace");

  assert.equal(workspaceAgentConversationMode("Keep the previous typography direction."), "continue");
  assert.equal(workspaceAgentConversationMode("保持原有的排版方向。"), "continue");
  assert.equal(workspaceAgentConversationMode("Retry all requested Pages."), "continue");
  assert.equal(workspaceAgentConversationMode("Continue from the prior brief."), "continue");
  assert.equal(workspaceAgentConversationMode("Resume."), "continue");
});
