import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentExecutionIdentityError,
  classifyAgentTurnFailure,
  runTurnWithRetry,
} from "../src/index.ts";

const HTML = `<style>:root{--accent:#2563eb}</style>
<section data-dezin-id="x"><h1>Hi there</h1><p>Real copy describing the thing.</p></section>`;

test("runTurnWithRetry retries transient failures then succeeds", async () => {
  let calls = 0;
  const flaky = {
    async runTurn() {
      calls++;
      if (calls < 3) throw new Error("stream hiccup");
      return { text: "ok", artifactHtml: HTML, artifactPath: "index.html" };
    },
  };
  const retries: number[] = [];
  const r = await runTurnWithRetry(flaky as never, { systemPrompt: "S", message: "m", projectDir: "/tmp/x" }, {
    maxAttempts: 3,
    sleep: async () => {},
    onRetry: (a) => retries.push(a),
  });
  assert.equal(r.text, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test("runTurnWithRetry throws after exhausting attempts", async () => {
  const dead = {
    async runTurn() {
      throw new Error("agent crashed");
    },
  };
  await assert.rejects(
    runTurnWithRetry(dead as never, { systemPrompt: "S", message: "m", projectDir: "/tmp/x" }, { maxAttempts: 2, sleep: async () => {} }),
    /agent crashed/,
  );
});

test("runTurnWithRetry retries only bounded transient provider failures", async () => {
  const transient = [
    new Error("provider returned 429 Too Many Requests"),
    new Error("socket hang up ECONNRESET"),
    new Error("codebuddy timed out after 1000ms"),
    new Error("agent process crashed with signal SIGSEGV"),
  ];
  for (const error of transient) {
    assert.equal(classifyAgentTurnFailure(error).retryable, true, error.message);
  }

  const terminal = [
    new Error("authentication expired; please login again"),
    new Error("permission denied by provider policy"),
    new DOMException("cancelled", "AbortError"),
    new AgentExecutionIdentityError(
      "provider reported a different runtime model",
      { providerId: "codebuddy", model: "requested" },
      null,
    ),
  ];
  for (const error of terminal) {
    assert.equal(classifyAgentTurnFailure(error).retryable, false, error.message);
  }

  let calls = 0;
  const authFailing = {
    async runTurn() {
      calls++;
      throw new Error("authentication expired; please login again");
    },
  };
  await assert.rejects(
    runTurnWithRetry(authFailing as never, { systemPrompt: "S", message: "m", projectDir: "/tmp/x" }, { maxAttempts: 3, sleep: async () => {} }),
    /authentication expired/,
  );
  assert.equal(calls, 1);

  const chained = new Error("turn failed", { cause: new Error("connection reset by peer") });
  assert.equal(classifyAgentTurnFailure(chained).category, "transport");
  assert.equal(classifyAgentTurnFailure({ code: "AGENT_EXECUTION_IDENTITY_MISMATCH" }).category, "identity");
  assert.equal(classifyAgentTurnFailure("weird string failure").category, "unknown");
});
