import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProvider,
  isAbortError,
  type AgentReadiness,
} from "../src/index.ts";

type FixtureMode = "ready" | "authentication-required" | "generic-error" | "hang" | "oversized";

interface Fixture {
  readonly command: string;
  readonly cwd: string;
  readonly auditPath: string;
  readonly cleanupPath: string;
  cleanup(): void;
}

function fakeCodeBuddy(mode: FixtureMode): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), "dezin-codebuddy-readiness-"));
  const command = join(cwd, process.platform === "win32" ? "codebuddy.cmd" : "codebuddy");
  const auditPath = join(cwd, "audit.json");
  const cleanupPath = join(cwd, "cleaned-up");
  const source = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    `const mode = ${JSON.stringify(mode)};`,
    `const auditPath = ${JSON.stringify(auditPath)};`,
    `const cleanupPath = ${JSON.stringify(cleanupPath)};`,
    "const audit = {",
    "  args: process.argv.slice(2),",
    "  messages: [],",
    "  environment: Object.fromEntries([",
    "    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',",
    "    'CLAUDE_CODE_OAUTH_TOKEN', 'CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN',",
    "    'CODEBUDDY_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',",
    "    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',",
    "    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'DEZIN_DAEMON_TOKEN',",
    "  ].filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]])),",
    "};",
    "const flush = () => fs.writeFileSync(auditPath, JSON.stringify(audit));",
    "const reply = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "const cleanup = () => { fs.writeFileSync(cleanupPath, 'yes'); process.exit(0); };",
    "process.on('SIGTERM', cleanup);",
    "process.on('SIGINT', cleanup);",
    "flush();",
    "if (mode === 'hang' && process.argv.includes('--help')) setInterval(() => {}, 1000);",
    "const lines = readline.createInterface({ input: process.stdin });",
    "lines.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  audit.messages.push(message);",
    "  flush();",
    "  if (message.id === 1) {",
    "    if (mode === 'oversized') {",
    "      process.stdout.write('x'.repeat(96 * 1024));",
    "      return;",
    "    }",
    "    reply({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });",
    "    return;",
    "  }",
    "  if (message.id !== 2 || mode === 'hang') return;",
    "  if (mode === 'ready') {",
    "    reply({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-test' } });",
    "  } else if (mode === 'authentication-required') {",
    "    reply({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required', data: { category: 'auth' } } });",
    "  } else {",
    "    reply({ jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'token=super-secret', data: { category: 'transport' } } });",
    "  }",
    "});",
  ].join("\n");
  writeFileSync(command, source, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(command, 0o755);
  return {
    command,
    cwd,
    auditPath,
    cleanupPath,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

async function probe(fixture: Fixture, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AgentReadiness> {
  const provider = getProvider(fixture.command);
  assert.equal(typeof provider?.probeReadiness, "function");
  return provider!.probeReadiness!(fixture.command, {
    cwd: fixture.cwd,
    timeoutMs: options.timeoutMs ?? 1_000,
    signal: options.signal,
  });
}

test("CodeBuddy readiness uses ACP session creation without prompts or credential APIs", async (t) => {
  const fixture = fakeCodeBuddy("ready");
  t.after(fixture.cleanup);
  const credentialKeys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEBUDDY_API_KEY",
    "CODEBUDDY_AUTH_TOKEN",
    "CODEBUDDY_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "DEZIN_DAEMON_TOKEN",
  ] as const;
  const previous = new Map(credentialKeys.map((key) => [key, process.env[key]]));
  for (const key of credentialKeys) process.env[key] = `must-not-leak-${key}`;
  t.after(() => {
    for (const key of credentialKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  assert.deepEqual(await probe(fixture), { status: "ready" });
  const audit = JSON.parse(readFileSync(fixture.auditPath, "utf8")) as {
    args: string[];
    messages: Array<{ id: number; method: string; params?: Record<string, unknown> }>;
    environment: Record<string, string>;
  };
  assert.deepEqual(audit.args, ["--acp", "--no-session-persistence"]);
  assert.deepEqual(audit.messages.map(({ method }) => method), ["initialize", "session/new"]);
  assert.equal("prompt" in (audit.messages[1]?.params ?? {}), false);
  assert.equal(audit.messages.some(({ method }) => method === "authenticate" || method === "getUserInfo"), false);
  assert.deepEqual(audit.environment, {});
  assert.equal(readFileSync(fixture.cleanupPath, "utf8"), "yes");
});

test("CodeBuddy readiness maps the exact ACP auth error without exposing credentials", async (t) => {
  const fixture = fakeCodeBuddy("authentication-required");
  t.after(fixture.cleanup);

  const result = await probe(fixture);
  assert.equal(result.status, "authentication-required");
  assert.match(result.reason, /sign in/i);
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("CodeBuddy readiness fails closed on an unrelated ACP error without reflecting raw output", async (t) => {
  const fixture = fakeCodeBuddy("generic-error");
  t.after(fixture.cleanup);

  const result = await probe(fixture);
  assert.equal(result.status, "verification-required");
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
});

test("CodeBuddy readiness is bounded and terminates a silent ACP process", async (t) => {
  const fixture = fakeCodeBuddy("hang");
  t.after(fixture.cleanup);

  // Leave enough time for the real child runtime to boot before exercising the
  // probe deadline; otherwise the OS can terminate it before its signal handler exists.
  const result = await probe(fixture, { timeoutMs: 500 });
  assert.equal(result.status, "verification-required");
  assert.match(result.reason, /timed out/i);
  assert.equal(readFileSync(fixture.cleanupPath, "utf8"), "yes");
});

test("CodeBuddy readiness aborts and cleans up without converting cancellation into availability", async (t) => {
  const fixture = fakeCodeBuddy("hang");
  t.after(fixture.cleanup);
  const controller = new AbortController();
  const result = probe(fixture, { signal: controller.signal, timeoutMs: 1_000 });
  const waitForChild = setInterval(() => {
    try {
      readFileSync(fixture.auditPath);
      clearInterval(waitForChild);
      controller.abort();
    } catch {
      // The child has not installed its signal handlers yet.
    }
  }, 10);
  t.after(() => clearInterval(waitForChild));

  await assert.rejects(result, (error) => isAbortError(error));
  assert.equal(readFileSync(fixture.cleanupPath, "utf8"), "yes");
});

test("CodeBuddy readiness rejects oversized ACP output and cleans up the process", async (t) => {
  const fixture = fakeCodeBuddy("oversized");
  t.after(fixture.cleanup);

  const result = await probe(fixture);
  assert.equal(result.status, "verification-required");
  assert.match(result.reason, /output/i);
  assert.equal(readFileSync(fixture.cleanupPath, "utf8"), "yes");
});

test("CodeBuddy model discovery aborts and terminates its owned help process", async (t) => {
  const fixture = fakeCodeBuddy("hang");
  t.after(fixture.cleanup);
  const provider = getProvider(fixture.command);
  assert.equal(typeof provider?.discoverModels, "function");
  const controller = new AbortController();
  const result = provider!.discoverModels!(fixture.command, true, controller.signal);
  const waitForChild = setInterval(() => {
    try {
      readFileSync(fixture.auditPath);
      clearInterval(waitForChild);
      controller.abort();
    } catch {
      // The model-discovery child has not installed its signal handlers yet.
    }
  }, 10);
  t.after(() => clearInterval(waitForChild));

  await assert.rejects(result, (error) => isAbortError(error));
  assert.equal(readFileSync(fixture.cleanupPath, "utf8"), "yes");
});
