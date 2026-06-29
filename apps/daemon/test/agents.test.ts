import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { detectAgents, type AgentProber, type AgentInfo } from "../src/agents-handler.ts";

const onlyClaude: AgentProber = async (command) =>
  command === "claude" ? { available: true, version: "claude 1.2.3" } : { available: false };

test("detectAgents probes each known agent + carries known models", async () => {
  const agents = await detectAgents(onlyClaude);
  // claude/codex/gemini lead the list; more candidates may follow.
  assert.deepEqual(agents.slice(0, 3).map((a) => a.id), ["claude", "codex", "gemini"]);
  const claude = agents.find((a) => a.id === "claude")!;
  assert.equal(claude.available, true);
  assert.equal(claude.version, "claude 1.2.3");
  assert.ok(claude.models.includes("claude-opus-4-8"), "claude carries known models");
  assert.equal(agents.find((a) => a.id === "codex")!.available, false);
});

test("GET /api/agents reports availability via the injected prober", async () => {
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "dezin-agents-")), agentProber: onlyClaude });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    assert.equal(res.status, 200);
    const agents = (await res.json()) as AgentInfo[];
    assert.ok(agents.length >= 3);
    const claude = agents.find((a) => a.id === "claude")!;
    assert.equal(claude.available, true);
    assert.equal(claude.version, "claude 1.2.3");
    assert.equal(agents.find((a) => a.id === "gemini")!.available, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
