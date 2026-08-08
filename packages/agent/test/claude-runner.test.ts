import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentExecutionIdentityError,
  AgentTurnError,
  ClaudeCodeRunner,
  NodeSpawner,
  OUTPUT_TRUNCATION_MARKER,
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "../src/index.ts";

/** A fake spawner that simulates `claude` writing index.html and emitting stream-json. */
class FakeSpawner implements ProcessSpawner {
  last: SpawnInput | null = null;
  private stdout: string;
  private fileContent: string;

  constructor(stdout: string, fileContent: string) {
    this.stdout = stdout;
    this.fileContent = fileContent;
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.last = input;
    await writeFile(join(input.cwd, "index.html"), this.fileContent, "utf8");
    return { stdout: this.stdout, exitCode: 0 };
  }
}

const STREAM = [
  `{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-4-6","apiKeySource":"user","claude_code_version":"2.1.32"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Wrote the hero."}]}}`,
  `{"type":"result","subtype":"success","result":"done","is_error":false}`,
].join("\n");

const ERROR_STREAM = [
  `{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-4-6","apiKeySource":"user","claude_code_version":"2.1.32"}`,
  `{"type":"result","subtype":"error_during_execution","result":"authentication expired","is_error":true}`,
].join("\n");

test("ClaudeCodeRunner assembles args/stdin, runs, and reads back the artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-"));
  const html = `<section data-dezin-id="x"><h1>Hero</h1></section>`;
  const spawner = new FakeSpawner(STREAM, html);
  const runner = new ClaudeCodeRunner({ spawner, command: "claude" });

  const result = await runner.runTurn({
    systemPrompt: "SYSTEM-PROMPT",
    message: "make me a hero",
    projectDir: dir,
    timeoutMs: 12_345,
  });

  // reads back the written artifact
  assert.equal(result.artifactHtml, html);
  assert.equal(result.artifactPath, "index.html");
  assert.equal(result.text, "Wrote the hero.");
  assert.deepEqual(result.executionIdentity, {
    requested: { providerId: "claude-code", model: null },
    observed: {
      providerId: "claude-code",
      model: "claude-sonnet-4-6",
      command: "claude",
      cliVersion: "2.1.32",
      apiKeySource: "user",
      protocol: "claude-stream-json-init-v1",
    },
  });
  // the file is actually on disk
  assert.equal(readFileSync(join(dir, "index.html"), "utf8"), html);

  // correct command/cwd
  assert.equal(spawner.last?.command, "claude");
  assert.equal(spawner.last?.cwd, dir);
  assert.equal(spawner.last?.timeoutMs, 12_345);
  // flags present
  const args = spawner.last?.args ?? [];
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--permission-mode") && args.includes("bypassPermissions"));
  // system prompt passed via --append-system-prompt
  const i = args.indexOf("--append-system-prompt");
  assert.ok(i >= 0 && args[i + 1] === "SYSTEM-PROMPT");
  // the user message went in as stream-json on stdin
  assert.match(spawner.last?.stdin ?? "", /"type":"user"/);
  assert.match(spawner.last?.stdin ?? "", /make me a hero/);
});

test("ClaudeCodeRunner prepends prior conversation turns to the message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-"));
  const spawner = new FakeSpawner(STREAM, "<section></section>");
  const runner = new ClaudeCodeRunner({ spawner, command: "claude" });

  await runner.runTurn({
    systemPrompt: "SYSTEM-PROMPT",
    message: "now make it bigger",
    projectDir: dir,
    history: [
      { role: "user", content: "make a hero" },
      { role: "assistant", content: "Built a hero." },
    ],
  });

  const stdin = spawner.last?.stdin ?? "";
  assert.match(stdin, /Conversation so far/);
  assert.match(stdin, /make a hero/); // prior user turn
  assert.match(stdin, /Built a hero\./); // prior assistant turn
  assert.match(stdin, /now make it bigger/); // current message still present
});

test("model option adds --model", () => {
  const runner = new ClaudeCodeRunner({ model: "claude-opus-4-8" });
  const args = runner.buildArgs("SYS");
  const i = args.indexOf("--model");
  assert.ok(i >= 0 && args[i + 1] === "claude-opus-4-8");
});

test("ClaudeCodeRunner accepts Claude family aliases resolved to canonical runtime models", async () => {
  for (const [alias, observed] of [
    ["opus", "claude-opus-5"],
    ["sonnet", "claude-sonnet-5"],
    ["haiku", "claude-haiku-4-5"],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), `dezin-claude-${alias}-alias-identity-`));
    const runner = new ClaudeCodeRunner({
      id: "claude",
      command: "claude",
      model: alias,
      spawner: new FakeSpawner(
        STREAM.replace("claude-sonnet-4-6", observed),
        "<main>resolved alias</main>",
      ),
    });

    const result = await runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir });

    assert.equal(result.executionIdentity?.requested.model, alias);
    assert.equal(result.executionIdentity?.observed.model, observed);
  }
});

test("ClaudeCodeRunner still fails closed when a canonical Claude model resolves differently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-canonical-identity-mismatch-"));
  const runner = new ClaudeCodeRunner({
    id: "claude",
    command: "claude",
    model: "claude-sonnet-4-6",
    spawner: new FakeSpawner(
      STREAM.replace("claude-sonnet-4-6", "claude-sonnet-5"),
      "<main>must not publish</main>",
    ),
  });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => error instanceof AgentExecutionIdentityError
      && error.requested.model === "claude-sonnet-4-6"
      && error.observed?.model === "claude-sonnet-5",
  );
});

test("ClaudeCodeRunner fails closed when system/init reports a different explicit model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-identity-mismatch-"));
  const stream = STREAM.replace("claude-sonnet-4-6", "claude-opus-4-8");
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    model: "hy3-ioa",
    spawner: new FakeSpawner(stream, "<main>must not publish</main>"),
  });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentExecutionIdentityError);
      assert.deepEqual(error.requested, { providerId: "codebuddy", model: "hy3-ioa" });
      assert.equal(error.observed?.providerId, "codebuddy");
      assert.equal(error.observed?.model, "claude-opus-4-8");
      return true;
    },
  );
});

test("ClaudeCodeRunner validates an explicit model before reporting the provider error result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-error-identity-mismatch-"));
  const stream = ERROR_STREAM.replace("claude-sonnet-4-6", "claude-opus-4-8");
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    model: "hy3-ioa",
    spawner: new FakeSpawner(stream, "<main>must not publish</main>"),
  });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentExecutionIdentityError);
      assert.match(error.message, /reported model.*claude-opus-4-8.*requested model.*hy3-ioa/i);
      assert.deepEqual(error.requested, { providerId: "codebuddy", model: "hy3-ioa" });
      assert.equal(error.observed?.providerId, "codebuddy");
      assert.equal(error.observed?.model, "claude-opus-4-8");
      return true;
    },
  );
});

test("ClaudeCodeRunner fails closed when a successful stream omits its system/init identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-missing-identity-"));
  const stream = STREAM.split("\n").slice(1).join("\n");
  const runner = new ClaudeCodeRunner({
    spawner: new FakeSpawner(stream, "<main>must not publish</main>"),
  });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => error instanceof AgentExecutionIdentityError
      && error.observed === null
      && /system\/init execution identity/i.test(error.message),
  );
});

test("ClaudeCodeRunner accepts CodeBuddy re-announcing one execution identity after an unavailable tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-codebuddy-repeated-identity-"));
  const lines = STREAM.split("\n");
  const baseInit = {
    ...JSON.parse(lines[0]!),
    uuid: "s1",
    model: "hy3-ioa",
    _requestId: "request-1",
  };
  const stream = [
    JSON.stringify({ ...baseInit, __timestamp: "2026-08-02T16:18:08.307Z" }),
    JSON.stringify({ ...baseInit, __timestamp: "2026-08-02T16:18:13.048Z" }),
    JSON.stringify({ ...baseInit, __timestamp: "2026-08-02T16:18:13.051Z" }),
    `{"type":"assistant","message":{"role":"assistant","model":"hy3-ioa","content":[{"type":"text","text":"Tool Bash not found in agent cli."}]}}`,
    ...lines.slice(1),
  ].join("\n");
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    model: "hy3-ioa",
    spawner: new FakeSpawner(stream, "<main>published safely</main>"),
  });

  const result = await runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir });
  assert.equal(result.executionIdentity?.observed.model, "hy3-ioa");
  assert.equal(result.artifactHtml, "<main>published safely</main>");
});

test("ClaudeCodeRunner fails closed when repeated system/init envelopes identify different executions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-ambiguous-identity-"));
  const lines = STREAM.split("\n");
  const secondInit = { ...JSON.parse(lines[0]!), session_id: "s2", uuid: "s2" };
  const stream = [lines[0]!, JSON.stringify(secondInit), ...lines.slice(1)].join("\n");
  const runner = new ClaudeCodeRunner({
    spawner: new FakeSpawner(stream, "<main>must not publish</main>"),
  });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => error instanceof AgentExecutionIdentityError
      && error.observed === null
      && /one consistent system\/init execution identity/i.test(error.message),
  );
});

test("NodeSpawner uses the augmented agent environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-"));
  const out = await new NodeSpawner().run({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({path:process.env.PATH, hook:process.env.IMPECCABLE_HOOK_DISABLED, quiet:process.env.IMPECCABLE_HOOK_QUIET}))",
    ],
    cwd: dir,
    stdin: "",
  });
  const env = JSON.parse(out.stdout) as { path: string; hook: string; quiet: string };
  assert.ok(env.path.split(process.platform === "win32" ? ";" : ":").includes(dirname(process.execPath)));
  assert.equal(env.hook, "1");
  assert.equal(env.quiet, "1");
});

test("NodeSpawner passes per-turn extra environment variables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-env-"));
  const out = await new NodeSpawner().run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.ANTHROPIC_API_KEY || '')"],
    cwd: dir,
    stdin: "",
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  assert.equal(out.stdout, "sk-test");
});

test("NodeSpawner exact-environment mode does not inherit ambient secrets", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-exact-env-"));
  const previousSecret = process.env.DEZIN_TEST_AMBIENT_SECRET;
  process.env.DEZIN_TEST_AMBIENT_SECRET = "must-not-cross-process-boundary";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.DEZIN_TEST_AMBIENT_SECRET;
    else process.env.DEZIN_TEST_AMBIENT_SECRET = previousSecret;
  });

  const out = await new NodeSpawner({ inheritEnvironment: false }).run({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({ambient:process.env.DEZIN_TEST_AMBIENT_SECRET,explicit:process.env.DEZIN_EXPLICIT_VALUE}))",
    ],
    cwd: dir,
    stdin: "",
    env: { DEZIN_EXPLICIT_VALUE: "visible" },
  });

  assert.deepEqual(JSON.parse(out.stdout), { explicit: "visible" });
});

test("NodeSpawner never reports a signal-terminated provider as exit code zero", {
  skip: process.platform === "win32",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-signal-"));
  const out = await new NodeSpawner().run({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGABRT')"],
    cwd: dir,
    stdin: "",
  });

  assert.notEqual(out.exitCode, 0);
});

test("NodeSpawner cleans up same-group descendants after a normal parent exit without changing success output", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-normal-exit-descendant-"));
  const processRecordPath = join(dir, "processes.json");
  let groupPid: number | null = null;
  t.after(() => {
    let recordedGroupPid = groupPid;
    if (!recordedGroupPid) {
      try {
        recordedGroupPid = (JSON.parse(readFileSync(processRecordPath, "utf8")) as { groupPid?: number }).groupPid ?? null;
      } catch {
        return;
      }
    }
    if (!recordedGroupPid) return;
    try {
      process.kill(-recordedGroupPid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  const descendant = [
    "process.on('SIGTERM',()=>{})",
    "setInterval(()=>{},1000)",
  ].join(";");
  const parent = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    `const child=spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "child.unref()",
    `fs.writeFileSync(${JSON.stringify(processRecordPath)},JSON.stringify({groupPid:process.pid,descendantPid:child.pid}))`,
    "process.stdout.write('parent-finished',()=>process.exit(0))",
  ].join(";");

  const out = await new NodeSpawner({ killDelayMs: 10, timeoutMs: 2_000 }).run({
    command: process.execPath,
    args: ["-e", parent],
    cwd: dir,
    stdin: "",
  });
  const record = JSON.parse(readFileSync(processRecordPath, "utf8")) as {
    groupPid: number;
    descendantPid: number;
  };
  groupPid = record.groupPid;

  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, "parent-finished");
  assert.throws(
    () => process.kill(record.descendantPid, 0),
    (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("NodeSpawner times out a stuck process and escalates termination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-timeout-"));
  const spawner = new NodeSpawner({ timeoutMs: 40, killDelayMs: 10 });

  await assert.rejects(
    () =>
      spawner.run({
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        cwd: dir,
        stdin: "",
      }),
    /timed out after 40ms/i,
  );
});

test("NodeSpawner abort kills a process that ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-abort-"));
  const spawner = new NodeSpawner({ timeoutMs: 1000, killDelayMs: 10 });
  const controller = new AbortController();
  const run = spawner.run({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    cwd: dir,
    stdin: "",
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(run, (error) => error instanceof Error && error.name === "AbortError");
});

test("NodeSpawner retains only a UTF-8-safe 1-marker stderr tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-stderr-"));
  const out = await new NodeSpawner({ stderrLimitBytes: 160 }).run({
    command: process.execPath,
    args: ["-e", "process.stderr.write('🙂'.repeat(1000)); process.stdout.write('ok')"],
    cwd: dir,
    stdin: "",
  });
  assert.equal(out.stdout, "ok");
  assert.ok(Buffer.byteLength(out.stderr ?? "", "utf8") <= 160);
  assert.equal((out.stderr ?? "").split(OUTPUT_TRUNCATION_MARKER).length - 1, 1);
  assert.doesNotMatch(out.stderr ?? "", /�/);
});

test("NodeSpawner kills the process group and rejects with AGENT_OUTPUT_LIMIT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-output-limit-"));
  const spawner = new NodeSpawner({ stdoutLimitBytes: 64 * 1024, killDelayMs: 10, timeoutMs: 2000 });
  let forwardedBytes = 0;
  await assert.rejects(
    spawner.run({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{}); const c=Buffer.alloc(16384,120); const pump=()=>{while(process.stdout.write(c)){};process.stdout.once('drain',pump)};pump();setInterval(()=>{},1000)",
      ],
      cwd: dir,
      stdin: "",
      onStdout: (chunk) => { forwardedBytes += Buffer.byteLength(chunk, "utf8"); },
    }),
    (error) => error instanceof Error && (error as Error & { code?: string }).code === "AGENT_OUTPUT_LIMIT",
  );
  assert.ok(forwardedBytes <= 64 * 1024);
});

test("NodeSpawner gives output overflow deterministic priority in an overflow-abort race", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-output-abort-race-"));
  const controller = new AbortController();
  const limit = 64 * 1024;
  let forwardedBytes = 0;
  const run = new NodeSpawner({ stdoutLimitBytes: limit, killDelayMs: 10, timeoutMs: 2000 }).run({
    command: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM',()=>{}); const c=Buffer.alloc(16384,120); const pump=()=>{while(process.stdout.write(c)){};process.stdout.once('drain',pump)};pump();setInterval(()=>{},1000)",
    ],
    cwd: dir,
    stdin: "",
    signal: controller.signal,
    onStdout: (chunk) => {
      forwardedBytes += Buffer.byteLength(chunk, "utf8");
      if (!controller.signal.aborted) controller.abort();
    },
  });

  await assert.rejects(
    run,
    (error) => error instanceof Error && (error as Error & { code?: string }).code === "AGENT_OUTPUT_LIMIT",
  );
  assert.equal(controller.signal.aborted, true);
  assert.ok(forwardedBytes <= limit);
});

test("NodeSpawner waits until an overflowing descendant process is gone", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group assertion");
  const dir = mkdtempSync(join(tmpdir(), "dezin-node-spawner-descendant-"));
  const pidPath = join(dir, "descendant.pid");
  const descendant = [
    "const fs=require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid))`,
    "process.on('SIGTERM',()=>{})",
    "const c=Buffer.alloc(16384,120)",
    "const pump=()=>{while(process.stdout.write(c)){};process.stdout.once('drain',pump)}",
    "pump()",
    "setInterval(()=>{},1000)",
  ].join(";");
  const parent = [
    "const {spawn}=require('node:child_process')",
    "process.on('SIGTERM',()=>{})",
    `spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','ignore']})`,
    "setInterval(()=>{},1000)",
  ].join(";");

  await assert.rejects(
    new NodeSpawner({ stdoutLimitBytes: 64 * 1024, killDelayMs: 10, timeoutMs: 2000 }).run({
      command: process.execPath,
      args: ["-e", parent],
      cwd: dir,
      stdin: "",
    }),
    (error) => error instanceof Error && (error as Error & { code?: string }).code === "AGENT_OUTPUT_LIMIT",
  );

  const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  assert.ok(Number.isSafeInteger(pid));
  assert.throws(
    () => process.kill(pid, 0),
    (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("ClaudeCodeRunner preserves an attested execution identity when the CLI exits nonzero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-exit-"));
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, stderr: "authentication expired", exitCode: 1 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTurnError);
      assert.match(error.message, /claude.*exit code 1.*authentication expired/i);
      assert.deepEqual(error.executionIdentity, {
        requested: { providerId: "claude-code", model: null },
        observed: {
          providerId: "claude-code",
          model: "claude-sonnet-4-6",
          command: "claude",
          cliVersion: "2.1.32",
          apiKeySource: "user",
          protocol: "claude-stream-json-init-v1",
        },
      });
      return true;
    },
  );
});

test("ClaudeCodeRunner validates an explicit model before reporting a nonzero exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-exit-identity-mismatch-"));
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    model: "hy3-ioa",
    spawner: {
      run: async () => ({
        stdout: STREAM.replace("claude-sonnet-4-6", "claude-opus-4-8"),
        stderr: "provider crashed",
        exitCode: 1,
      }),
    },
  });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentExecutionIdentityError);
      assert.match(error.message, /reported model.*claude-opus-4-8.*requested model.*hy3-ioa/i);
      assert.deepEqual(error.requested, { providerId: "codebuddy", model: "hy3-ioa" });
      assert.equal(error.observed?.providerId, "codebuddy");
      assert.equal(error.observed?.model, "claude-opus-4-8");
      return true;
    },
  );
});

test("ClaudeCodeRunner preserves the observed default model when the provider reports an error result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-is-error-"));
  const spawner = new FakeSpawner(ERROR_STREAM, "<h1>old</h1>");
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTurnError);
      assert.match(error.message, /claude.*error.*authentication expired/i);
      assert.deepEqual(error.executionIdentity, {
        requested: { providerId: "claude-code", model: null },
        observed: {
          providerId: "claude-code",
          model: "claude-sonnet-4-6",
          command: "claude",
          cliVersion: "2.1.32",
          apiKeySource: "user",
          protocol: "claude-stream-json-init-v1",
        },
      });
      return true;
    },
  );
});

test("ClaudeCodeRunner rejects when the agent writes no artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-empty-"));
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTurnError);
      assert.match(error.message, /artifact.*missing/i);
      assert.equal(error.executionIdentity.observed.providerId, "claude-code");
      assert.equal(error.executionIdentity.observed.model, "claude-sonnet-4-6");
      return true;
    },
  );
});

test("ClaudeCodeRunner preserves the attested identity when artifact validation finds an empty file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-empty-artifact-"));
  const runner = new ClaudeCodeRunner({ spawner: new FakeSpawner(STREAM, "   ") });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTurnError);
      assert.match(error.message, /artifact.*empty/i);
      assert.equal(error.executionIdentity.observed.model, "claude-sonnet-4-6");
      return true;
    },
  );
});

test("ClaudeCodeRunner rejects stale artifacts from a successful no-op turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-stale-"));
  await writeFile(join(dir, "index.html"), "<h1>previous</h1>", "utf8");
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner });

  await assert.rejects(
    () => runner.runTurn({ systemPrompt: "S", message: "go", projectDir: dir }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTurnError);
      assert.match(error.message, /artifact.*not updated/i);
      assert.equal(error.executionIdentity.observed.model, "claude-sonnet-4-6");
      return true;
    },
  );
});

test("ClaudeCodeRunner can return an unchanged artifact when update enforcement is disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-claude-standard-"));
  const html = "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.jsx\"></script>";
  await writeFile(join(dir, "index.html"), html, "utf8");
  const spawner: ProcessSpawner = {
    run: async () => ({ stdout: STREAM, exitCode: 0 }),
  };
  const runner = new ClaudeCodeRunner({ spawner, enforceArtifactUpdate: false });

  const result = await runner.runTurn({ systemPrompt: "S", message: "update src/App.jsx", projectDir: dir });

  assert.equal(result.artifactHtml, html);
});
