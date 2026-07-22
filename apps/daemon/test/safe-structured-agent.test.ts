import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  NodeSpawnerOptions,
  ProcessSpawner,
  SpawnInput,
  SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import {
  isTrustedClaudeExecutablePath,
  parseSafeStructuredClaudeStream,
  runSafeStructuredAgent,
  safeStructuredClaudeArgs,
} from "../src/orchestration/safe-structured-agent.ts";

const TEST_CLAUDE_EXECUTABLE = "/trusted/claude/install/bin/claude";
const resolveTestClaudeExecutable = () => TEST_CLAUDE_EXECUTABLE;

class RecordingSpawner implements ProcessSpawner {
  readonly inputs: SpawnInput[] = [];

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.inputs.push(input);
    return {
      stdout: '{"type":"result","subtype":"success","result":"{}","is_error":false}',
      stderr: "",
      exitCode: 0,
    };
  }
}

function request(overrides: Partial<Parameters<typeof runSafeStructuredAgent>[0]> = {}) {
  return {
    command: "claude",
    systemPrompt: "Return one JSON object.",
    message: "Plan this exact workspace.",
    cwd: "/tmp",
    signal: new AbortController().signal,
    maxOutputBytes: 1_024,
    ...overrides,
  };
}

test("production spawner injection still resolves the trusted Claude executable", async () => {
  const spawner = new RecordingSpawner();
  let resolverCalls = 0;

  await runSafeStructuredAgent(request(), {
    createSpawner() {
      return spawner;
    },
    resolveClaudeExecutable() {
      resolverCalls += 1;
      return TEST_CLAUDE_EXECUTABLE;
    },
  });

  assert.equal(resolverCalls, 1);
  assert.equal(spawner.inputs[0]?.command, TEST_CLAUDE_EXECUTABLE);
});

test("trusted Claude executable policy rejects a fixed-search symlink to an external fake package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-untrusted-structured-agent-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const fixedSearchBin = join(home, ".local", "bin");
  const fakePackageCli = join(root, "outside", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const configuredCommand = join(fixedSearchBin, "claude");
  mkdirSync(fixedSearchBin, { recursive: true });
  mkdirSync(join(fakePackageCli, ".."), { recursive: true });
  writeFileSync(fakePackageCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  symlinkSync(fakePackageCli, configuredCommand);

  assert.equal(
    isTrustedClaudeExecutablePath(realpathSync(configuredCommand), home),
    false,
  );
});

test("hard no-tools structured transport passes only a minimal credential environment", async (t) => {
  const previousSecret = process.env.DEZIN_TEST_AMBIENT_SECRET;
  const previousPath = process.env.PATH;
  process.env.DEZIN_TEST_AMBIENT_SECRET = "must-not-cross-process-boundary";
  process.env.PATH = "/tmp/ambient-wrapper-directory";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.DEZIN_TEST_AMBIENT_SECRET;
    else process.env.DEZIN_TEST_AMBIENT_SECRET = previousSecret;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const spawner = new RecordingSpawner();
  const options: NodeSpawnerOptions[] = [];

  await runSafeStructuredAgent(request({
    env: {
      ANTHROPIC_API_KEY: "selected-provider-key",
      ANTHROPIC_BASE_URL: "https://provider.example.test",
      DEZIN_DAEMON_TOKEN: undefined,
    },
  }), {
    resolveClaudeExecutable: resolveTestClaudeExecutable,
    createSpawner(input) {
      options.push(input);
      return spawner;
    },
  });

  assert.equal(spawner.inputs.length, 1);
  const spawned = spawner.inputs[0]!;
  assert.equal(spawned.command, TEST_CLAUDE_EXECUTABLE);
  assert.equal(spawned.env?.ANTHROPIC_API_KEY, "selected-provider-key");
  assert.equal(spawned.env?.ANTHROPIC_BASE_URL, "https://provider.example.test");
  assert.equal(spawned.env?.DEZIN_TEST_AMBIENT_SECRET, undefined);
  assert.equal(spawned.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "DEZIN_DAEMON_TOKEN"), true);
  assert.doesNotMatch(spawned.env?.PATH ?? "", /ambient-wrapper-directory/);
  assert.ok((spawned.env?.HOME?.length ?? 0) > 0);
  assert.deepEqual(options, [{
    timeoutMs: 3 * 60 * 1_000,
    stdoutLimitBytes: 1_024,
    stderrLimitBytes: 256 * 1_024,
    killDelayMs: 500,
    inheritEnvironment: false,
  }]);
});

test("hard no-tools structured transport rejects configured wrappers and extra credentials before spawn", async () => {
  let spawns = 0;
  const options = {
    resolveClaudeExecutable: resolveTestClaudeExecutable,
    createSpawner(): ProcessSpawner {
      spawns += 1;
      return new RecordingSpawner();
    },
  };
  await assert.rejects(
    runSafeStructuredAgent(request({ command: "/tmp/claude" }), options),
    /built-in Claude CLI entry|wrappers/i,
  );
  await assert.rejects(
    runSafeStructuredAgent(request({ env: { AWS_SECRET_ACCESS_KEY: "ambient-secret" } }), options),
    /environment variable AWS_SECRET_ACCESS_KEY is not permitted/i,
  );
  await assert.rejects(
    runSafeStructuredAgent(request({ env: { DEZIN_DAEMON_TOKEN: "mutation-capability" } }), options),
    /cannot receive the daemon mutation token/i,
  );
  assert.equal(spawns, 0, "unsafe commands and environments fail before the ProcessSpawner is constructed");
});

test("Claude structured arguments keep every hard no-tools control and no permissive flags", () => {
  const args = safeStructuredClaudeArgs("Return JSON.", "claude-sonnet");
  assert.ok(args.includes("--safe-mode"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--no-chrome"));
  assert.ok(!args.some((argument) => /bypass|danger|yolo/i.test(argument)));
});

test("Claude multimodal arguments use the real CLI-compatible stream-json tuple", () => {
  const args = safeStructuredClaudeArgs("Return JSON.", undefined, "stream-json");
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
});

test("safe Claude stream parser returns only one successful terminal result", () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"safe-session"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ignored duplicate transport text"}]}}',
    '{"type":"result","subtype":"success","result":"{\\"findings\\":[]}","is_error":false}',
  ].join("\n");
  assert.equal(parseSafeStructuredClaudeStream(stdout), '{"findings":[]}');
});

test("safe Claude stream parser rejects protocol noise, tool use, missing status, and error results", () => {
  assert.throws(
    () => parseSafeStructuredClaudeStream('not-json\n{"type":"result","subtype":"success","result":"{}","is_error":false}'),
    /line 1.*valid JSON/i,
  );
  assert.throws(
    () => parseSafeStructuredClaudeStream('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}\n{"type":"result","subtype":"success","result":"{}","is_error":false}'),
    /hard no-tools/i,
  );
  assert.throws(
    () => parseSafeStructuredClaudeStream('{"type":"result","subtype":"success","result":"{}"}'),
    /terminal result is malformed/i,
  );
  assert.throws(
    () => parseSafeStructuredClaudeStream('{"type":"result","subtype":"error_during_execution","result":"denied","is_error":true}'),
    /unsuccessful terminal result/i,
  );
  assert.throws(
    () => parseSafeStructuredClaudeStream('{"type":"result","subtype":"success","result":"{}","is_error":false}\n{"type":"system","subtype":"late"}'),
    /events after.*terminal/i,
  );
});

test("hard no-tools structured transport sends image evidence as stream-json content blocks", async () => {
  const spawner = new RecordingSpawner();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);

  await runSafeStructuredAgent(request({
    message: "Review only the supplied visual evidence.",
    images: [
      { label: "generated artifact", mediaType: "image/png", data: png.toString("base64") },
      { label: "Sharingan source", mediaType: "image/jpeg", data: jpeg.toString("base64") },
    ],
  }), {
    resolveClaudeExecutable: resolveTestClaudeExecutable,
    createSpawner() {
      return spawner;
    },
  });

  const spawned = spawner.inputs[0]!;
  assert.equal(spawned.args[spawned.args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(spawned.args[spawned.args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(spawned.args.includes("--verbose"));
  assert.equal(spawned.args[spawned.args.indexOf("--tools") + 1], "");
  assert.ok(!spawned.args.some((argument) => /bypass|danger|yolo/i.test(argument)));
  const payload = JSON.parse(spawned.stdin.trim()) as {
    type: string;
    message: { role: string; content: Array<Record<string, unknown>> };
  };
  assert.equal(payload.type, "user");
  assert.equal(payload.message.role, "user");
  assert.deepEqual(payload.message.content, [
    { type: "text", text: "Review only the supplied visual evidence." },
    { type: "text", text: "Image evidence: generated artifact" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    },
    { type: "text", text: "Image evidence: Sharingan source" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
    },
  ]);
});

test("hard no-tools structured transport bounds image count, per-image bytes, and total decoded bytes before spawn", async () => {
  let spawnerConstructions = 0;
  const options = {
    resolveClaudeExecutable: resolveTestClaudeExecutable,
    createSpawner(): ProcessSpawner {
      spawnerConstructions += 1;
      return new RecordingSpawner();
    },
  };
  const image = (label: string, bytes: number) => ({
    label,
    mediaType: "image/png" as const,
    data: (() => {
      const payload = Buffer.alloc(Math.max(bytes, 8), 1);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(payload);
      return payload.toString("base64");
    })(),
  });

  await assert.rejects(
    runSafeStructuredAgent(request({ images: [image("one", 1), image("two", 1), image("three", 1)] }), options),
    /at most 2 images/i,
  );
  await assert.rejects(
    runSafeStructuredAgent(request({ images: [image("oversized", 8 * 1_024 * 1_024 + 1)] }), options),
    /8 MiB|image.*byte limit/i,
  );
  await assert.rejects(
    runSafeStructuredAgent(request({ images: [image("one", 7 * 1_024 * 1_024), image("two", 7 * 1_024 * 1_024)] }), options),
    /12 MiB|total.*byte limit/i,
  );
  assert.equal(spawnerConstructions, 0);
});

test("hard no-tools structured transport bounds system prompt, message, and final stream-json stdin before spawn", async () => {
  let spawnerConstructions = 0;
  const options = {
    resolveClaudeExecutable: resolveTestClaudeExecutable,
    createSpawner(): ProcessSpawner {
      spawnerConstructions += 1;
      return new RecordingSpawner();
    },
  };
  await assert.rejects(
    runSafeStructuredAgent(request({ systemPrompt: "s".repeat(64 * 1_024 + 1) }), options),
    /system prompt.*64 KiB|system prompt.*byte limit/i,
  );
  await assert.rejects(
    runSafeStructuredAgent(request({ message: "m".repeat(512 * 1_024 + 1) }), options),
    /message.*512 KiB|message.*byte limit/i,
  );
  const sixMiBBytes = Buffer.alloc(6 * 1_024 * 1_024, 2);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(sixMiBBytes);
  const sixMiB = sixMiBBytes.toString("base64");
  await assert.rejects(
    runSafeStructuredAgent(request({
      images: [
        { label: "one", mediaType: "image/png", data: sixMiB },
        { label: "two", mediaType: "image/png", data: sixMiB },
      ],
    }), options),
    /stdin.*16 MiB|stdin.*byte limit/i,
  );
  assert.equal(spawnerConstructions, 0);
});

test("hard no-tools structured transport rejects wrong image magic and media mismatch before spawn", async () => {
  let spawnerConstructions = 0;
  const options = {
    resolveClaudeExecutable: resolveTestClaudeExecutable,
    createSpawner(): ProcessSpawner {
      spawnerConstructions += 1;
      return new RecordingSpawner();
    },
  };
  await assert.rejects(
    runSafeStructuredAgent(request({
      images: [{ label: "fake png", mediaType: "image/png", data: Buffer.from("not-an-image").toString("base64") }],
    }), options),
    /PNG signature|image.*magic/i,
  );
  await assert.rejects(
    runSafeStructuredAgent(request({
      images: [{
        label: "mismatched jpeg",
        mediaType: "image/png",
        data: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]).toString("base64"),
      }],
    }), options),
    /PNG signature|media.*mismatch/i,
  );
  assert.equal(spawnerConstructions, 0);
});
