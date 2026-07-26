import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type {
  NodeSpawnerOptions,
  ProcessSpawner,
  SpawnInput,
  SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import {
  buildSafeStructuredGenericSeatbeltProfile,
  isTrustedCodeBuddyExecutablePath,
  isTrustedClaudeExecutablePath,
  parseSafeStructuredCodexJsonl,
  parseSafeStructuredClaudeStream,
  resolveRegisteredProviderExecutable,
  resolveTrustedCodexNativeExecutable,
  runSafeStructuredAgent,
  SafeStructuredAgentError,
  safeStructuredClaudeArgs,
  safeStructuredCodexArgs,
} from "../src/orchestration/safe-structured-agent.ts";

const TEST_CLAUDE_EXECUTABLE = "/trusted/claude/install/bin/claude";
const TEST_CODEBUDDY_EXECUTABLE = "/trusted/codebuddy/install/bin/codebuddy";
const TEST_CODEX_EXECUTABLE = "/trusted/codex/install/bin/codex";
const TEST_CURSOR_EXECUTABLE = "/trusted/cursor-agent/install/bin/cursor-agent";
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

test("hard no-tools structured transport runs CodeBuddy with the requested model", async () => {
  const spawner = new RecordingSpawner();

  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    model: "gpt-5.6-terra",
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.deepEqual(result, { providerId: "codebuddy", text: "{}" });
  assert.equal(spawner.inputs.length, 1);
  const spawned = spawner.inputs[0]!;
  assert.equal(spawned.command, TEST_CODEBUDDY_EXECUTABLE);
  assert.equal(spawned.stdin, "Plan this exact workspace.");
  assert.equal(spawned.args[spawned.args.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.equal(spawned.args[spawned.args.indexOf("--system-prompt") + 1], "Return one JSON object.");
  assert.equal(spawned.args[spawned.args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(spawned.args[spawned.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(spawned.args[spawned.args.indexOf("--tools") + 1], "");
  assert.equal(spawned.args[spawned.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(spawned.args[spawned.args.indexOf("--setting-sources") + 1], "");
  assert.ok(spawned.args.includes("--strict-mcp-config"));
  assert.ok(spawned.args.includes("--no-session-persistence"));
  assert.ok(!spawned.args.some((argument) => /bypass|danger|yolo/i.test(argument)));
});

test("registry structured transport runs Codex inside outer confinement and extracts only its terminal JSONL message", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-codex-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const inputs: SpawnInput[] = [];
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      inputs.push(input);
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "reasoning-1", type: "reasoning", text: "private reasoning" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "message-1", type: "agent_message", text: '{"pages":[]}' },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 4 },
          }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codex",
    model: "gpt-5.6-codex",
    cwd: scratch,
    env: {
      OPENAI_API_KEY: "selected-provider-key",
      OPENAI_BASE_URL: "https://provider.example.test",
      DEZIN_DAEMON_TOKEN: undefined,
    },
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveCodexExecutable() {
      return TEST_CODEX_EXECUTABLE;
    },
    resolveSandboxExecutable() {
      return "/usr/bin/sandbox-exec";
    },
  });

  assert.deepEqual(result, { providerId: "codex", text: '{"pages":[]}' });
  assert.equal(inputs.length, 1);
  const spawned = inputs[0]!;
  const exactScratch = realpathSync(scratch);
  assert.equal(spawned.command, "/usr/bin/sandbox-exec");
  assert.equal(spawned.cwd, exactScratch);
  assert.equal(spawned.args[0], "-p");
  const profile = spawned.args[1] ?? "";
  assert.match(profile, /\(deny file-read-data \(subpath "\/Users"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/private\/tmp"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/Volumes"\)\)/);
  assert.match(profile, /\(deny process-fork\)/);
  assert.match(profile, /\(deny process-exec\*\)/);
  assert.match(
    profile,
    new RegExp(`\\(allow process-exec \\(literal "${TEST_CODEX_EXECUTABLE.replaceAll("\\", "\\\\")}"\\)\\)`),
  );
  assert.match(profile, new RegExp(`\\(subpath "${exactScratch.replaceAll("\\", "\\\\")}"\\)`));
  assert.match(profile, /subpath "\/trusted\/codex\/install\/bin"/);
  assert.match(profile, /\.codex/);
  assert.doesNotMatch(profile, new RegExp(`${process.env.HOME ?? "/Users/test"}/Documents`));
  assert.equal(spawned.args[2], TEST_CODEX_EXECUTABLE);
  assert.deepEqual(spawned.args.slice(3, 5), ["exec", "--skip-git-repo-check"]);
  assert.equal(spawned.args[spawned.args.indexOf("--sandbox") + 1], "danger-full-access");
  assert.equal(spawned.args[spawned.args.indexOf("--model") + 1], "gpt-5.6-codex");
  assert.ok(spawned.args.includes("--ephemeral"));
  assert.ok(spawned.args.includes("--ignore-user-config"));
  assert.ok(spawned.args.includes("--ignore-rules"));
  assert.ok(spawned.args.includes("--json"));
  assert.ok(spawned.args.includes("-"), "Codex prompt must be delivered over stdin");
  assert.match(spawned.stdin, /Return one JSON object/);
  assert.match(spawned.stdin, /Plan this exact workspace/);
  assert.equal(spawned.env?.OPENAI_API_KEY, "selected-provider-key");
  assert.equal(spawned.env?.OPENAI_BASE_URL, "https://provider.example.test");
  assert.equal(spawned.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "DEZIN_DAEMON_TOKEN"), true);
});

test("Codex Web Search is an explicit feature-gated structured transport capability", () => {
  const disabled = safeStructuredCodexArgs("gpt-5.4-mini");
  const enabled = safeStructuredCodexArgs("gpt-5.4-mini", undefined, [], true);

  assert.equal(disabled.includes("standalone_web_search"), false);
  const enableIndex = enabled.indexOf("--enable");
  assert.notEqual(enableIndex, -1);
  assert.equal(enabled[enableIndex + 1], "standalone_web_search");
});

test("structured Web Search capability is rejected before spawn for a non-Codex provider", async () => {
  let spawnerConstructions = 0;
  let resolverCalls = 0;

  await assert.rejects(
    () => runSafeStructuredAgent(request({
      command: "claude",
      allowWebSearch: true,
    }), {
      createSpawner() {
        spawnerConstructions += 1;
        return new RecordingSpawner();
      },
      resolveClaudeExecutable() {
        resolverCalls += 1;
        return TEST_CLAUDE_EXECUTABLE;
      },
    }),
    (error: unknown) => error instanceof SafeStructuredAgentError
      && error.code === "provider-unavailable"
      && /Codex Web Search|Web Search.*Codex/i.test(error.message),
  );

  assert.equal(resolverCalls, 0);
  assert.equal(spawnerConstructions, 0);
});

test("Codex outer confinement lets the native client start but blocks every subprocess exec", {
  skip: process.platform !== "darwin",
}, (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-codex-no-subprocess-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const exactScratch = realpathSync(scratch);
  const markerPath = join(exactScratch, "subprocess-was-started");
  const profile = buildSafeStructuredGenericSeatbeltProfile({
    providerId: "codex",
    executable: process.execPath,
    scratch: exactScratch,
  });
  const childProgram = [
    "const {spawnSync}=require('node:child_process')",
    `const child=spawnSync('/bin/sh',['-c',${JSON.stringify(`printf leaked > ${markerPath}`)}])`,
    "process.stdout.write(JSON.stringify({status:child.status,errorCode:child.error?.code,signal:child.signal}))",
  ].join(";");

  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, process.execPath, "-e", childProgram],
    { cwd: exactScratch, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: null,
    errorCode: "EPERM",
    signal: null,
  });
  assert.throws(
    () => readFileSync(markerPath, "utf8"),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("registry structured transport confines Codex image evidence and attaches only scratch paths", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-codex-image-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
  const inputs: SpawnInput[] = [];
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      inputs.push(input);
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-image" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "message-image", type: "agent_message", text: '{"decision":"pass"}' },
          }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codex",
    model: "gpt-5.4-mini",
    cwd: scratch,
    message: "Review only the supplied visual evidence.",
    images: [
      { label: "generated Moodboard reference", mediaType: "image/png", data: png.toString("base64") },
      { label: "reference crop", mediaType: "image/jpeg", data: jpeg.toString("base64") },
    ],
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveCodexExecutable() {
      return TEST_CODEX_EXECUTABLE;
    },
    resolveSandboxExecutable() {
      return "/usr/bin/sandbox-exec";
    },
  });

  assert.deepEqual(result, { providerId: "codex", text: '{"decision":"pass"}' });
  assert.equal(inputs.length, 1);
  const spawned = inputs[0]!;
  const imageArgumentPaths = spawned.args.flatMap((argument, index) =>
    argument === "--image" ? [spawned.args[index + 1]!] : []);
  assert.equal(imageArgumentPaths.length, 2);
  assert.deepEqual(imageArgumentPaths.map((path) => dirname(path)), [
    realpathSync(scratch),
    realpathSync(scratch),
  ]);
  assert.deepEqual(readFileSync(imageArgumentPaths[0]!), png);
  assert.deepEqual(readFileSync(imageArgumentPaths[1]!), jpeg);
  assert.equal(statSync(imageArgumentPaths[0]!).mode & 0o777, 0o600);
  assert.equal(statSync(imageArgumentPaths[1]!).mode & 0o777, 0o600);
  assert.match(spawned.stdin, /Image evidence 1: generated Moodboard reference/);
  assert.match(spawned.stdin, /Image evidence 2: reference crop/);
  assert.doesNotMatch(spawned.stdin, new RegExp(png.toString("base64")));
  assert.doesNotMatch(spawned.stdin, new RegExp(jpeg.toString("base64")));
});

test("registry structured transport confines a requested Codex final-output schema", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-codex-schema-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["pages"],
    properties: {
      pages: { type: "array", items: { type: "object" } },
    },
  } as const;
  let observedSchema: unknown;
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      const argumentIndex = input.args.indexOf("--output-schema");
      assert.notEqual(argumentIndex, -1, "Codex must receive the requested final-output schema");
      const schemaPath = input.args[argumentIndex + 1];
      assert.equal(typeof schemaPath, "string");
      assert.equal(dirname(schemaPath!), realpathSync(scratch));
      observedSchema = JSON.parse(readFileSync(schemaPath!, "utf8"));
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-schema" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "message-schema", type: "agent_message", text: '{"pages":[]}' },
          }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    },
  };

  await runSafeStructuredAgent(request({
    command: "codex",
    cwd: scratch,
    outputSchema,
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveCodexExecutable() {
      return TEST_CODEX_EXECUTABLE;
    },
    resolveSandboxExecutable() {
      return "/usr/bin/sandbox-exec";
    },
  });

  assert.deepEqual(observedSchema, outputSchema);
});

test("registry structured transport canonicalizes its scratch before Seatbelt and spawn", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "dezin-safe-codex-canonical-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const canonicalScratch = join(parent, "canonical");
  const aliasedScratch = join(parent, "alias");
  mkdirSync(canonicalScratch, { mode: 0o700 });
  symlinkSync(canonicalScratch, aliasedScratch, "dir");
  const exactScratch = realpathSync(aliasedScratch);
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      assert.equal(input.cwd, exactScratch, "Codex must run from the exact scratch identity");
      assert.match(
        input.args[1] ?? "",
        new RegExp(exactScratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "Seatbelt must grant the same exact scratch identity",
      );
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-canonical" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "message-canonical", type: "agent_message", text: "{}" },
          }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    },
  };

  await runSafeStructuredAgent(request({
    command: "codex",
    cwd: aliasedScratch,
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveCodexExecutable() {
      return TEST_CODEX_EXECUTABLE;
    },
    resolveSandboxExecutable() {
      return "/usr/bin/sandbox-exec";
    },
  });
});

test("registry generic structured adapter invokes Gemini one-shot in an empty scratch with a restricted environment", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-gemini-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const inputs: SpawnInput[] = [];
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      inputs.push(input);
      return { stdout: '  {"pages":[]}  \n', stderr: "", exitCode: 0 };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "gemini",
    model: "gemini-2.5-pro",
    cwd: scratch,
    env: {
      GEMINI_API_KEY: "selected-provider-key",
      DEZIN_DAEMON_TOKEN: undefined,
    },
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveRegisteredExecutable(command) {
      assert.equal(command, "gemini");
      return "/trusted/gemini/install/bin/gemini";
    },
    resolveSandboxExecutable() {
      return "/usr/bin/sandbox-exec";
    },
  });

  assert.deepEqual(result, { providerId: "gemini", text: '{"pages":[]}' });
  assert.equal(inputs.length, 1);
  const spawned = inputs[0]!;
  const exactScratch = realpathSync(scratch);
  assert.equal(spawned.command, "/usr/bin/sandbox-exec");
  assert.equal(spawned.cwd, exactScratch);
  assert.equal(spawned.stdin, "");
  assert.equal(spawned.args[0], "-p");
  const profile = spawned.args[1] ?? "";
  assert.match(profile, /\(deny file-read-data \(subpath "\/Users"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/private\/tmp"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/Volumes"\)\)/);
  assert.match(profile, new RegExp(`\\(subpath "${exactScratch.replaceAll("\\", "\\\\")}"\\)`));
  assert.match(profile, /subpath "\/trusted\/gemini\/install\/bin"/);
  assert.doesNotMatch(profile, new RegExp(`${process.env.HOME ?? "/Users/test"}/Documents`));
  assert.equal(spawned.args[2], "/trusted/gemini/install/bin/gemini");
  assert.equal(spawned.args[spawned.args.indexOf("-m") + 1], "gemini-2.5-pro");
  assert.match(spawned.args[spawned.args.lastIndexOf("-p") + 1] ?? "", /Return one JSON object/);
  assert.match(spawned.args[spawned.args.lastIndexOf("-p") + 1] ?? "", /Plan this exact workspace/);
  assert.equal(spawned.env?.GEMINI_API_KEY, "selected-provider-key");
  assert.equal(spawned.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "DEZIN_DAEMON_TOKEN"), true);
  assert.equal(spawned.env?.TMPDIR, exactScratch);
});

test("registry structured transport forces Cursor Agent terminal text into the strict response parser", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-cursor-agent-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const inputs: SpawnInput[] = [];
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      inputs.push(input);
      return { stdout: '  {"pages":[],"components":[{"name":"Card"}]}  \n', stderr: "", exitCode: 0 };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "cursor-agent",
    model: "gpt-5",
    cwd: scratch,
    env: { DEZIN_DAEMON_TOKEN: undefined },
  }), {
    platform: "darwin",
    createSpawner() {
      return spawner;
    },
    resolveRegisteredExecutable(command) {
      assert.equal(command, "cursor-agent");
      return TEST_CURSOR_EXECUTABLE;
    },
    resolveSandboxExecutable() {
      return "/usr/bin/sandbox-exec";
    },
  });

  assert.deepEqual(result, {
    providerId: "cursor-agent",
    text: '{"pages":[],"components":[{"name":"Card"}]}',
  });
  assert.equal(inputs.length, 1);
  const spawned = inputs[0]!;
  assert.equal(spawned.command, "/usr/bin/sandbox-exec");
  assert.equal(spawned.args[2], TEST_CURSOR_EXECUTABLE);
  assert.deepEqual(spawned.args.slice(3, 8), [
    "--output-format",
    "text",
    "--model",
    "gpt-5",
    "-p",
  ]);
  assert.match(spawned.args[8] ?? "", /Return one JSON object/);
  assert.match(spawned.args[8] ?? "", /Plan this exact workspace/);
  assert.equal(spawned.stdin, "");
});

test("registry generic structured adapter fails closed when an outer confinement capability is unavailable", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dezin-safe-generic-unsupported-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  let spawns = 0;
  await assert.rejects(
    runSafeStructuredAgent(request({
      command: "gemini",
      cwd: scratch,
      env: { DEZIN_DAEMON_TOKEN: undefined },
    }), {
      platform: "linux",
      resolveRegisteredExecutable: () => "/trusted/gemini/install/bin/gemini",
      createSpawner() {
        spawns += 1;
        return new RecordingSpawner();
      },
    }),
    /outer filesystem confinement.*unavailable|requires macOS Seatbelt/i,
  );
  assert.equal(spawns, 0);
});

test("CodeBuddy structured transport retries bounded transient remote 5xx failures within one deadline", async () => {
  let attempts = 0;
  const seenTimeouts: number[] = [];
  const spawner: ProcessSpawner = {
    async run(input): Promise<SpawnOutput> {
      attempts += 1;
      seenTimeouts.push(input.timeoutMs ?? 0);
      if (attempts < 3) await new Promise((resolve) => setTimeout(resolve, 20));
      return attempts < 3
        ? {
            stdout: JSON.stringify({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["500 internal server error"],
            }),
            stderr: "",
            exitCode: 0,
          }
        : {
            stdout: '{"type":"result","subtype":"success","result":"{\\"ok\\":true}","is_error":false}',
            stderr: "",
            exitCode: 0,
          };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    timeoutMs: 500,
  }), {
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.equal(attempts, 3);
  assert.equal(seenTimeouts[0], 500);
  assert.ok(seenTimeouts[1]! > 0 && seenTimeouts[1]! < 500);
  assert.ok(seenTimeouts[2]! > 0 && seenTimeouts[2]! < seenTimeouts[1]!);
  assert.deepEqual(result, { providerId: "codebuddy", text: '{"ok":true}' });
});

test("CodeBuddy structured transport terminalizes quota-exhausted 429 without leaking provider output", async () => {
  let attempts = 0;
  const secret = "api_key=must-not-persist";
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [`API Error: 429 当前无可用Token额度，如需申请，请联系您所在团队的负责人或HRBP。 ${secret}`],
          result: `private prompt transcript ${secret}`,
        }),
        stderr: `private diagnostic ${secret}`,
        exitCode: 0,
      };
    },
  };

  await assert.rejects(
    () => runSafeStructuredAgent(request({
      command: "codebuddy",
      timeoutMs: 1_000,
    }), {
      createSpawner() {
        return spawner;
      },
      resolveCodeBuddyExecutable() {
        return TEST_CODEBUDDY_EXECUTABLE;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SafeStructuredAgentError);
      assert.equal(error.code, "quota-exhausted");
      assert.equal(error.message, "Structured Agent provider quota is exhausted");
      assert.deepEqual(error.details, {
        reasonCode: "quota-exhausted",
        httpStatus: 429,
        retryable: false,
      });
      assert.doesNotMatch(JSON.stringify(error.details), /private|prompt|api_key|must-not-persist|HRBP/);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("CodeBuddy structured transport gives terminal quota precedence across mixed remote status evidence", async () => {
  const evidenceOrders = [
    [
      "HTTP 500 prior internal server error",
      "API Error: 429 insufficient quota",
    ],
    [
      "API Error: 429 quota exhausted",
      "HTTP 503 later service unavailable",
    ],
  ];

  for (const errors of evidenceOrders) {
    let attempts = 0;
    const spawner: ProcessSpawner = {
      async run(): Promise<SpawnOutput> {
        attempts += 1;
        return {
          stdout: JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors,
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    };

    await assert.rejects(
      () => runSafeStructuredAgent(request({
        command: "codebuddy",
        timeoutMs: 1_000,
      }), {
        createSpawner() {
          return spawner;
        },
        resolveCodeBuddyExecutable() {
          return TEST_CODEBUDDY_EXECUTABLE;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SafeStructuredAgentError);
        assert.equal(error.code, "quota-exhausted");
        assert.deepEqual(error.details, {
          reasonCode: "quota-exhausted",
          httpStatus: 429,
          retryable: false,
        });
        return true;
      },
    );
    assert.equal(attempts, 1);
  }
});

test("CodeBuddy structured transport gives terminal quota precedence in mixed stderr diagnostics", async () => {
  let attempts = 0;
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return {
        stdout: "",
        stderr: [
          "HTTP 503 prior service unavailable",
          "API Error: 429 quota exhausted",
        ].join("\n"),
        exitCode: 1,
      };
    },
  };

  await assert.rejects(
    () => runSafeStructuredAgent(request({
      command: "codebuddy",
      timeoutMs: 1_000,
    }), {
      createSpawner() {
        return spawner;
      },
      resolveCodeBuddyExecutable() {
        return TEST_CODEBUDDY_EXECUTABLE;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SafeStructuredAgentError);
      assert.equal(error.code, "quota-exhausted");
      assert.deepEqual(error.details, {
        reasonCode: "quota-exhausted",
        httpStatus: 429,
        retryable: false,
      });
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("CodeBuddy structured transport retries an ordinary rate-limit 429", async () => {
  let attempts = 0;
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return attempts === 1
        ? {
            stdout: JSON.stringify({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["HTTP 429 too many requests; retry after a short delay"],
            }),
            stderr: "",
            exitCode: 0,
          }
        : {
            stdout: '{"type":"result","subtype":"success","result":"{\\"ok\\":true}","is_error":false}',
            stderr: "",
            exitCode: 0,
          };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    timeoutMs: 1_000,
  }), {
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { providerId: "codebuddy", text: '{"ok":true}' });
});

test("CodeBuddy structured transport retries a nonzero stderr-only transient 502", async () => {
  let attempts = 0;
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return attempts === 1
        ? {
            stdout: "",
            stderr: "HTTP 502 service unavailable",
            exitCode: 1,
          }
        : {
            stdout: '{"type":"result","subtype":"success","result":"{\\"ok\\":true}","is_error":false}',
            stderr: "",
            exitCode: 0,
          };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    timeoutMs: 1_000,
  }), {
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { providerId: "codebuddy", text: '{"ok":true}' });
});

test("CodeBuddy retry classification ignores status-like text in structured assistant content", async () => {
  let attempts = 0;
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return attempts === 1
        ? {
            stdout: JSON.stringify({
              type: "assistant",
              message: {
                content: [{ type: "text", text: "Designing a 404 page for the empty state." }],
              },
            }),
            stderr: "HTTP 502 service unavailable",
            exitCode: 1,
          }
        : {
            stdout: '{"type":"result","subtype":"success","result":"{\\"ok\\":true}","is_error":false}',
            stderr: "",
            exitCode: 0,
          };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    timeoutMs: 1_000,
  }), {
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { providerId: "codebuddy", text: '{"ok":true}' });
});

test("CodeBuddy structured transport tolerates diagnostic noise around a retryable terminal 503", async () => {
  let attempts = 0;
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return attempts === 1
        ? {
            stdout: [
              "CodeBuddy diagnostic: upstream request failed",
              JSON.stringify({
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                errors: ["503 temporarily unavailable"],
              }),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          }
        : {
            stdout: '{"type":"result","subtype":"success","result":"{\\"ok\\":true}","is_error":false}',
            stderr: "",
            exitCode: 0,
          };
    },
  };

  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    timeoutMs: 1_000,
  }), {
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { providerId: "codebuddy", text: '{"ok":true}' });
});

test("CodeBuddy structured transport does not retry nontransient failures or successful terminal results", async () => {
  let failedAttempts = 0;
  const failedSpawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      failedAttempts += 1;
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["HTTP 404 model not found"],
        }),
        stderr: "A previous request returned HTTP 502",
        exitCode: 0,
      };
    },
  };

  await assert.rejects(
    () => runSafeStructuredAgent(request({
      command: "codebuddy",
      timeoutMs: 1_000,
    }), {
      createSpawner() {
        return failedSpawner;
      },
      resolveCodeBuddyExecutable() {
        return TEST_CODEBUDDY_EXECUTABLE;
      },
    }),
    (error: unknown) => (
      error instanceof Error
      && Reflect.get(error, "code") === "process-failed"
    ),
  );
  assert.equal(failedAttempts, 1);

  let successfulAttempts = 0;
  const successfulSpawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      successfulAttempts += 1;
      return {
        stdout: '{"type":"result","subtype":"success","result":"{\\"ok\\":true}","is_error":false}',
        stderr: "A previous request returned HTTP 502",
        exitCode: 0,
      };
    },
  };
  const result = await runSafeStructuredAgent(request({
    command: "codebuddy",
    timeoutMs: 1_000,
  }), {
    createSpawner() {
      return successfulSpawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });

  assert.equal(successfulAttempts, 1);
  assert.deepEqual(result, { providerId: "codebuddy", text: '{"ok":true}' });
});

test("CodeBuddy structured transport aborts during retry backoff without another spawn", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const reason = new Error("cancelled during retry backoff");
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnOutput> {
      attempts += 1;
      return {
        stdout: "",
        stderr: "HTTP 502 service unavailable",
        exitCode: 1,
      };
    },
  };
  const run = runSafeStructuredAgent(request({
    command: "codebuddy",
    signal: controller.signal,
    timeoutMs: 1_000,
  }), {
    createSpawner() {
      return spawner;
    },
    resolveCodeBuddyExecutable() {
      return TEST_CODEBUDDY_EXECUTABLE;
    },
  });
  setTimeout(() => controller.abort(reason), 5);

  await assert.rejects(run, (error: unknown) => error === reason);
  assert.equal(attempts, 1);
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

test("trusted CodeBuddy executable policy accepts only its fixed official package roots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-trusted-codebuddy-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const officialCli = join(
    home,
    ".local",
    "lib",
    "node_modules",
    "@tencent-ai",
    "codebuddy-code",
    "bin",
    "codebuddy",
  );
  const externalCli = join(root, "outside", "codebuddy");
  mkdirSync(join(officialCli, ".."), { recursive: true });
  mkdirSync(join(externalCli, ".."), { recursive: true });
  writeFileSync(officialCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(externalCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const trustedHome = realpathSync(home);
  assert.equal(isTrustedCodeBuddyExecutablePath(realpathSync(officialCli), trustedHome), true);
  assert.equal(isTrustedCodeBuddyExecutablePath(realpathSync(externalCli), trustedHome), false);
});

test("trusted Codex resolver maps its official wrapper package to the exact native binary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-trusted-codex-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const wrapper = join(
    home,
    ".local",
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  const native = join(
    home,
    ".local",
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-darwin-arm64",
    "vendor",
    "aarch64-apple-darwin",
    "bin",
    "codex",
  );
  const entrypoint = join(home, ".local", "bin", "codex");
  mkdirSync(dirname(wrapper), { recursive: true });
  mkdirSync(dirname(native), { recursive: true });
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(wrapper, "#!/usr/bin/env node\n", { mode: 0o700 });
  writeFileSync(native, "native-codex-fixture", { mode: 0o700 });
  symlinkSync(wrapper, entrypoint);
  assert.equal(resolveTrustedCodexNativeExecutable({
    trustedHome: realpathSync(home),
    platform: "darwin",
    architecture: "arm64",
  }), realpathSync(native));
});

test("trusted Codex resolver rejects a fixed-search symlink to an external wrapper", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-untrusted-codex-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const entrypoint = join(home, ".local", "bin", "codex");
  const externalWrapper = join(root, "outside", "codex.js");
  mkdirSync(dirname(entrypoint), { recursive: true });
  mkdirSync(dirname(externalWrapper), { recursive: true });
  writeFileSync(externalWrapper, "#!/usr/bin/env node\n", { mode: 0o700 });
  symlinkSync(externalWrapper, entrypoint);
  assert.throws(
    () => resolveTrustedCodexNativeExecutable({
      trustedHome: realpathSync(home),
      platform: "darwin",
      architecture: "arm64",
    }),
    /official Codex CLI wrapper|trusted install/i,
  );
});

test("registered structured providers resolve from the same fixed Bun toolchain root used by Agent scan", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-registered-provider-bun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const executable = join(home, ".bun", "bin", "gemini");
  mkdirSync(join(executable, ".."), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  assert.equal(
    resolveRegisteredProviderExecutable("gemini", home),
    realpathSync(executable),
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

test("safe Codex JSONL parser returns the final completed Agent message", () => {
  const thread = JSON.stringify({ type: "thread.started", thread_id: "thread-test" });
  const turn = JSON.stringify({ type: "turn.started" });
  const progress = JSON.stringify({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "Preparing the compact intent." },
  });
  const final = JSON.stringify({
    type: "item.completed",
    item: { id: "message-2", type: "agent_message", text: '{"pages":[]}' },
  });
  const terminal = JSON.stringify({ type: "turn.completed", usage: {} });

  assert.equal(
    parseSafeStructuredCodexJsonl([thread, turn, progress, final, terminal].join("\n")),
    '{"pages":[]}',
  );
});

test("safe Codex JSONL parser accepts Web Search items only when the request enabled them", () => {
  const thread = JSON.stringify({ type: "thread.started", thread_id: "thread-test" });
  const turn = JSON.stringify({ type: "turn.started" });
  const search = JSON.stringify({
    type: "item.completed",
    item: {
      id: "search-1",
      type: "web_search",
      query: "current accessible design research sources",
    },
  });
  const message = JSON.stringify({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: '{"sources":[]}' },
  });
  const terminal = JSON.stringify({ type: "turn.completed", usage: {} });
  const stdout = [thread, turn, search, message, terminal].join("\n");

  assert.throws(
    () => parseSafeStructuredCodexJsonl(stdout),
    /Web Search.*not enabled|hard no-tools/i,
  );
  assert.equal(
    parseSafeStructuredCodexJsonl(stdout, { allowWebSearch: true }),
    '{"sources":[]}',
  );
});

test("safe Codex JSONL parser rejects command, file, and MCP tool items even with Web Search enabled", () => {
  const thread = JSON.stringify({ type: "thread.started", thread_id: "thread-test" });
  const turn = JSON.stringify({ type: "turn.started" });
  const message = JSON.stringify({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "{}" },
  });
  const terminal = JSON.stringify({ type: "turn.completed", usage: {} });

  for (const forbiddenType of ["command_execution", "file_change", "mcp_tool_call"]) {
    const forbidden = JSON.stringify({
      type: "item.completed",
      item: { id: "forbidden-1", type: forbiddenType },
    });
    assert.throws(
      () => parseSafeStructuredCodexJsonl(
        [thread, turn, forbidden, message, terminal].join("\n"),
        { allowWebSearch: true },
      ),
      new RegExp(`forbidden.*${forbiddenType}`, "i"),
    );
  }
});

test("safe Codex JSONL parser rejects incomplete and post-terminal envelopes", () => {
  const thread = JSON.stringify({ type: "thread.started", thread_id: "thread-test" });
  const turn = JSON.stringify({ type: "turn.started" });
  const message = JSON.stringify({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "{}" },
  });
  const terminal = JSON.stringify({ type: "turn.completed", usage: {} });

  assert.throws(
    () => parseSafeStructuredCodexJsonl([turn, message, terminal].join("\n")),
    /malformed turn start/i,
  );
  assert.throws(
    () => parseSafeStructuredCodexJsonl([thread, turn, message, terminal, '{"type":"turn.started"}'].join("\n")),
    /events after.*terminal/i,
  );
  assert.throws(
    () => parseSafeStructuredCodexJsonl([thread, turn, message].join("\n")),
    /no completed terminal turn/i,
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
