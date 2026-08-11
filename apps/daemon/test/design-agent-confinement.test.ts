import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  type ProcessSpawner,
  type SpawnInput,
  type SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import type { Settings } from "../../../packages/core/src/index.ts";
import {
  DesignConfinedSpawner,
  designClaudeArgs,
  designCodeBuddyArgs,
} from "../src/design/design-agent-confinement.ts";
import {
  createProductionDesignAnalysisRunner,
  createProductionDesignNodeRunner,
  productionDesignAgentEnvironment,
} from "../src/design/design-node-agent.ts";
import {
  designExportStagingDirectory,
  designNodeJobStagingDirectory,
} from "../src/design/design-storage.ts";

function claudeStream(model: string): string {
  return [
  `{"type":"system","subtype":"init","session_id":"design-test","model":${JSON.stringify(model)}}`,
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
  '{"type":"result","subtype":"success","result":"done","is_error":false}',
  ].join("\n");
}

function settings(agentCommand: string, model = ""): Settings {
  return { agentCommand, model } as Settings;
}

class RecordingSpawner implements ProcessSpawner {
  readonly calls: SpawnInput[] = [];
  readonly #structuredOutput: boolean;
  readonly #writeArtifact: boolean;

  constructor(input: { structuredOutput?: boolean; writeArtifact?: boolean } = {}) {
    this.#structuredOutput = input.structuredOutput ?? true;
    this.#writeArtifact = input.writeArtifact ?? true;
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.calls.push(input);
    if (this.#writeArtifact) {
      await writeFile(join(input.cwd, "index.html"), "<!doctype html><html><body>confined</body></html>", "utf8");
    }
    return {
      stdout: this.#structuredOutput
        ? claudeStream(input.args[input.args.indexOf("--model") + 1] || "runtime-default-model")
        : "done",
      stderr: "",
      exitCode: 0,
    };
  }
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-confinement-"));
  const projectId = "project-test";
  const nodeStaging = designNodeJobStagingDirectory(dataDir, projectId, "node-test", "job-test");
  const exportStaging = designExportStagingDirectory(dataDir, projectId, "export-test");
  await Promise.all([
    mkdir(nodeStaging, { recursive: true }),
    mkdir(exportStaging, { recursive: true }),
  ]);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, projectId, nodeStaging, exportStaging };
}

test("Design Agent production environment excludes daemon authority and unrelated secrets", () => {
  const env = productionDesignAgentEnvironment({
    ...settings("claude"),
    apiKey: "anthropic-test-key",
    apiBaseUrl: "https://provider.example.test",
  }, "claude", "daemon-bearer-token");

  assert.equal(env.DEZIN_DAEMON_TOKEN, undefined);
  assert.deepEqual(env, {
    ANTHROPIC_API_KEY: "anthropic-test-key",
    ANTHROPIC_BASE_URL: "https://provider.example.test",
  });
});

test("the real Design process receives only the confined environment", async (t) => {
  const f = await fixture(t);
  const binDir = await mkdtemp(join(tmpdir(), "dezin-design-env-bin-"));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  const executable = join(binDir, ".local", "bin", "claude");
  await mkdir(join(binDir, ".local", "bin"), { recursive: true });
  await writeFile(executable, `#!/bin/sh
printf '%s|%s\n' "\${DEZIN_TEST_DAEMON_SECRET-unset}" "\${DEZIN_DAEMON_TOKEN-unset}"
`, "utf8");
  await chmod(executable, 0o755);

  const priorSecret = process.env.DEZIN_TEST_DAEMON_SECRET;
  const priorToken = process.env.DEZIN_DAEMON_TOKEN;
  process.env.DEZIN_TEST_DAEMON_SECRET = "ambient-secret";
  process.env.DEZIN_DAEMON_TOKEN = "ambient-daemon-token";
  t.after(() => {
    if (priorSecret === undefined) delete process.env.DEZIN_TEST_DAEMON_SECRET;
    else process.env.DEZIN_TEST_DAEMON_SECRET = priorSecret;
    if (priorToken === undefined) delete process.env.DEZIN_DAEMON_TOKEN;
    else process.env.DEZIN_DAEMON_TOKEN = priorToken;
  });

  const output = await new DesignConfinedSpawner({
    dataDir: f.dataDir,
    projectId: f.projectId,
    provider: "claude",
    command: "claude",
    runtimeEnvironment: { HOME: binDir, TMPDIR: tmpdir(), LANG: "C" },
  }).run({
    command: "claude",
    args: designClaudeArgs(undefined, "system"),
    cwd: f.nodeStaging,
    stdin: "prompt",
    env: {
      PATH: "/tmp/agent-controlled-path-must-be-ignored",
      DEZIN_DAEMON_TOKEN: "explicit-daemon-token",
      DEZIN_TEST_DAEMON_SECRET: "explicit-secret",
      NODE_OPTIONS: "--require=/tmp/escape.cjs",
    },
  });

  assert.equal(output.exitCode, 0, output.stderr ?? "");
  assert.equal(output.stdout.trim(), "unset|unset");
});

test("Claude Design runners use the exact no-Bash confined policy and job cwd", async (t) => {
  const f = await fixture(t);
  const spawner = new RecordingSpawner();
  const runner = createProductionDesignNodeRunner(
    settings("claude", "design-model"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner },
  );
  assert.equal(runner.id, "claude");

  const result = await runner.runTurn({
    systemPrompt: "confined system",
    message: "create the node",
    projectDir: f.nodeStaging,
    env: { PATH: process.env.PATH, DEZIN_TEST_LOCAL_AUTH: "must-be-removed" },
  });

  assert.equal(result.artifactPath, "index.html");
  assert.equal(spawner.calls.length, 1);
  const call = spawner.calls[0]!;
  assert.equal(call.command, "claude");
  assert.equal(call.cwd, await realpath(f.nodeStaging));
  assert.equal(call.env?.DEZIN_TEST_LOCAL_AUTH, undefined);
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read,Write,Edit,Glob,Grep");
  assert.equal(call.args[call.args.indexOf("--append-system-prompt") + 1], "confined system");
  assert.equal(call.args[call.args.indexOf("--model") + 1], "design-model");
  assert.equal(call.args.includes("bypassPermissions"), false);
  assert.equal(call.args.includes("danger-full-access"), false);
  assert.equal(call.args.some((argument) => /^(Bash|Web|Task|Agent)$/i.test(argument)), false);
  assert.match(call.stdin, /create the node/);
  assert.equal(call.args.includes("--safe-mode"), true);
  assert.equal(call.args.includes("--strict-mcp-config"), true);
  assert.equal(call.args[call.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(call.args.includes("--no-chrome"), true);
  assert.equal(call.args.includes("--disable-slash-commands"), true);
  assert.equal(call.args.includes("--no-session-persistence"), true);
});

test("Design confinement fails closed on Windows before shell metacharacters reach a delegate", async (t) => {
  const f = await fixture(t);
  const attack = "& powershell -NoProfile -Command Write-Output escaped & rem";
  const delegate = new RecordingSpawner();
  const spawner = new DesignConfinedSpawner({
    dataDir: f.dataDir,
    projectId: f.projectId,
    provider: "claude",
    command: "claude",
    delegate,
    platform: "win32",
  });
  await assert.rejects(
    spawner.run({
      command: "claude",
      args: designClaudeArgs(undefined, attack),
      cwd: f.nodeStaging,
      stdin: attack,
    }),
    /Windows.*not.*verified|not.*available.*Windows/i,
  );
  assert.equal(delegate.calls.length, 0);
});

test("CodeBuddy Design runners use their verified no-Bash policy and exact job cwd", async (t) => {
  const f = await fixture(t);
  const spawner = new RecordingSpawner();
  const runner = createProductionDesignNodeRunner(
    settings("codebuddy", "design-model"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner },
  );
  assert.equal(runner.id, "codebuddy");

  const result = await runner.runTurn({
    systemPrompt: "confined system",
    message: "create the node",
    projectDir: f.nodeStaging,
    env: { DEZIN_TEST_LOCAL_AUTH: "must-be-removed" },
  });

  assert.equal(result.artifactPath, "index.html");
  assert.equal(spawner.calls.length, 1);
  const call = spawner.calls[0]!;
  assert.equal(call.command, "codebuddy");
  assert.equal(call.cwd, await realpath(f.nodeStaging));
  assert.equal(call.env?.DEZIN_TEST_LOCAL_AUTH, undefined);
  assert.deepEqual(call.args, designCodeBuddyArgs("design-model", "confined system"));
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read,Write,Edit,Glob,Grep");
  assert.equal(call.args[call.args.indexOf("--setting-sources") + 1], "");
  const confinedSettings = JSON.parse(call.args[call.args.indexOf("--settings") + 1]!);
  assert.equal(confinedSettings.disableAllHooks, true);
  assert.equal(confinedSettings.memory.autoMemoryEnabled, false);
  assert.equal(confinedSettings.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(call.args.includes("bypassPermissions"), false);
  assert.equal(call.args.some((argument) => /^(Bash|Web|Task|Agent)$/i.test(argument)), false);
  assert.ok(call.terminalStdout);
  assert.equal(call.terminalStdout.graceMs > 0 && call.terminalStdout.graceMs <= 1_000, true);
  assert.equal(call.terminalStdout.isTerminalLine(
    '{"type":"result","subtype":"success","result":"done","is_error":false}',
  ), true);
  assert.equal(call.terminalStdout.isTerminalLine(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"type\\":\\"result\\"}"}]}}',
  ), false);
  assert.equal(call.terminalStdout.isTerminalLine('{"type":"result"}'), false);
});

test("Codex Design runners are accepted and remain scoped to the exact Project staging directory", async (t) => {
  const f = await fixture(t);
  const delegate = new RecordingSpawner({ structuredOutput: false });
  const runner = createProductionDesignNodeRunner(
    settings("codex", "gpt-design"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner: delegate },
  );

  const result = await runner.runTurn({
    systemPrompt: "design system",
    message: "create the node",
    projectDir: f.nodeStaging,
  });

  assert.equal(runner.id, "codex");
  assert.equal(result.artifactPath, "index.html");
  assert.equal(delegate.calls.length, 1);
  assert.equal(delegate.calls[0]?.cwd, await realpath(f.nodeStaging));
  assert.equal(delegate.calls[0]?.command, "codex");
  assert.deepEqual(delegate.calls[0]?.args.slice(0, 4), ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
  assert.equal(delegate.calls[0]?.args.includes("danger-full-access"), false);

  const guard = new DesignConfinedSpawner({
    dataDir: f.dataDir,
    projectId: f.projectId,
    provider: "codex",
    command: "codex",
    model: "gpt-design",
    delegate,
  });
  await assert.rejects(guard.run({
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", "-m", "gpt-design", "prompt"],
    cwd: f.nodeStaging,
    stdin: "",
    env: {},
  }), /arguments do not match the confined policy/i);
  assert.equal(delegate.calls.length, 1);
});

test("Main Agent analysis uses the same confined policy without requiring an artifact mutation", async (t) => {
  const f = await fixture(t);
  const placeholder = "<!doctype html><html><body>Main Agent analysis</body></html>";
  await writeFile(join(f.exportStaging, "index.html"), placeholder, "utf8");
  const spawner = new RecordingSpawner({ writeArtifact: false });
  const runner = createProductionDesignAnalysisRunner(
    settings("claude"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner },
  );

  const result = await runner.runTurn({
    systemPrompt: "main agent system",
    message: "plan canvas commands",
    projectDir: f.exportStaging,
  });

  assert.equal(result.artifactHtml, placeholder);
  assert.equal(spawner.calls[0]?.cwd, await realpath(f.exportStaging));
  assert.equal(spawner.calls[0]?.args.includes("dontAsk"), true);
  assert.equal(spawner.calls[0]?.args.includes("bypassPermissions"), false);
});

test("Design runners accept registered, custom, and absolute-path providers", () => {
  const confinement = { dataDir: "/tmp/design-test", projectId: "project-test" };
  assert.equal(createProductionDesignNodeRunner(settings("gemini"), confinement).id, "gemini");
  assert.equal(createProductionDesignAnalysisRunner(settings("custom-agent"), confinement).id, "custom-agent");
  assert.equal(createProductionDesignNodeRunner(settings("/usr/local/bin/claude"), confinement).id, "claude");
});

test("the last-mile spawner rejects unsafe argv drift before the delegated process runs", async (t) => {
  const f = await fixture(t);
  const delegate = new RecordingSpawner();
  const spawner = new DesignConfinedSpawner({
    dataDir: f.dataDir,
    projectId: f.projectId,
    provider: "claude",
    command: "claude",
    delegate,
  });

  await assert.rejects(
    spawner.run({
      command: "claude",
      args: ["--permission-mode", "bypassPermissions"],
      cwd: f.nodeStaging,
      stdin: "prompt",
    }),
    /arguments do not match the confined policy/i,
  );
  assert.equal(delegate.calls.length, 0);

});

test("a Design runner cannot use another Project's otherwise valid pending directory", async (t) => {
  const f = await fixture(t);
  const outside = designNodeJobStagingDirectory(f.dataDir, "project-other", "node-test", "job-test");
  await mkdir(outside, { recursive: true });
  const spawner = new RecordingSpawner();
  const runner = createProductionDesignNodeRunner(
    settings("claude"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner },
  );

  await assert.rejects(
    runner.runTurn({
      systemPrompt: "system",
      message: "message",
      projectDir: outside,
    }),
    /cwd is outside its Project staging root/i,
  );
  assert.equal(spawner.calls.length, 0);
});

test("a Design runner rejects a Project staging root redirected through a symlink", async (t) => {
  const f = await fixture(t);
  const designRoot = join(f.dataDir, "projects", f.projectId, "design");
  const redirectedRoot = await mkdtemp(join(tmpdir(), "dezin-design-redirected-"));
  t.after(() => rm(redirectedRoot, { recursive: true, force: true }));
  await rm(designRoot, { recursive: true, force: true });
  const staging = join(redirectedRoot, "nodes", "node-test", ".pending", "jobs", "job-test");
  await mkdir(staging, { recursive: true });
  await symlink(redirectedRoot, designRoot, "dir");

  const delegate = new RecordingSpawner();
  const runner = createProductionDesignNodeRunner(
    settings("claude"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner: delegate },
  );

  await assert.rejects(
    runner.runTurn({
      systemPrompt: "system",
      message: "message",
      projectDir: designNodeJobStagingDirectory(f.dataDir, f.projectId, "node-test", "job-test"),
    }),
    /Project staging root traverses a symbolic link/i,
  );
  assert.equal(delegate.calls.length, 0);
});
