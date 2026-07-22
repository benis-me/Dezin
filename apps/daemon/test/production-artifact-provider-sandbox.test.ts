import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ProcessSpawner,
  SpawnInput,
} from "../../../packages/agent/src/index.ts";
import {
  buildProductionArtifactClaudeArgs,
  createProductionArtifactProviderRunner,
} from "../src/orchestration/production-artifact-provider-sandbox.ts";

test("production Claude Artifact argv enables a fail-closed Bash-only workspace sandbox", () => {
  const worktreeDir = "/private/tmp/dezin-artifact/worktree";
  const runtimeRoot = "/private/tmp/dezin-artifact/provider-runtime";
  const args = buildProductionArtifactClaudeArgs({
    worktreeDir,
    runtimeRoot,
    systemPrompt: "Build the exact Artifact.",
    model: "sonnet",
  });

  assert.equal(args[0], "-p");
  assert.ok(!args.includes("--bare"));
  assert.ok(args.includes("--safe-mode"));
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), [
    "--setting-sources",
    "",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "dontAsk",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), [
    "--tools",
    "Bash",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2), [
    "--mcp-config",
    '{"mcpServers":{}}',
  ]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--no-chrome"));
  assert.ok(!args.includes("bypassPermissions"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));

  const settingsIndex = args.indexOf("--settings");
  assert.notEqual(settingsIndex, -1);
  const settings = JSON.parse(args[settingsIndex + 1]!) as {
    permissions: { allow: string[]; deny: string[] };
    sandbox: {
      enabled: boolean;
      failIfUnavailable: boolean;
      autoAllowBashIfSandboxed: boolean;
      excludedCommands: string[];
      allowUnsandboxedCommands: boolean;
      filesystem: {
        denyRead: string[];
        allowRead: string[];
        denyWrite: string[];
        allowWrite: string[];
      };
      network: { allowedDomains: string[]; deniedDomains: string[] };
      credentials: { envVars: Array<{ name: string; mode: string }> };
    };
  };
  assert.deepEqual(settings.permissions.allow, ["Bash"]);
  assert.ok(settings.permissions.deny.includes("Read"));
  assert.ok(settings.permissions.deny.includes("Edit"));
  assert.ok(settings.permissions.deny.includes("WebFetch"));
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
  assert.deepEqual(settings.sandbox.excludedCommands, []);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem.denyRead, ["/"]);
  assert.ok(settings.sandbox.filesystem.allowRead.includes(worktreeDir));
  assert.ok(settings.sandbox.filesystem.allowRead.includes(runtimeRoot));
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, [`${worktreeDir}/.git`]);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [runtimeRoot]);
  assert.deepEqual(settings.sandbox.network, { allowedDomains: [], deniedDomains: ["*"] });
  assert.deepEqual(settings.sandbox.credentials, {
    envVars: [
      { name: "ANTHROPIC_API_KEY", mode: "deny" },
      { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
    ],
  });
});

test("production Artifact provider sandbox fail-closes Codex, Gemini, unknown providers, and mismatches", () => {
  assert.throws(
    () => createProductionArtifactProviderRunner({
      providerId: "codex",
      command: "codex",
      worktreeDir: "/private/tmp/dezin-artifact/worktree",
    }),
    /Codex.*disabled|tmp-granting|cannot be safely nested/i,
  );
  assert.throws(
    () => createProductionArtifactProviderRunner({
      providerId: "gemini",
      command: "gemini",
      worktreeDir: "/private/tmp/dezin-artifact/worktree",
    }),
    /Gemini|unsupported|workspace sandbox/i,
  );
  assert.throws(
    () => createProductionArtifactProviderRunner({
      providerId: "custom-cli",
      command: "custom-cli",
      worktreeDir: "/private/tmp/dezin-artifact/worktree",
    }),
    /unsupported|provider/i,
  );
  assert.throws(
    () => createProductionArtifactProviderRunner({
      providerId: "claude",
      command: "codex",
      worktreeDir: "/private/tmp/dezin-artifact/worktree",
    }),
    /provider.*command|mismatch/i,
  );
});

test("Codex and Gemini fail closed before resolution, runtime creation, or spawn even with credentials", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-disabled-provider-credentials-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktreeDir = join(root, "worktree");
  const runtimeRoot = join(root, "provider-runtime");
  mkdirSync(worktreeDir);
  let resolveCount = 0;
  let spawnCount = 0;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousGemini = process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = "configured-openai-credential";
  process.env.GEMINI_API_KEY = "configured-gemini-credential";
  t.after(() => {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
  });
  const dependencies = {
    runtimeRoot,
    resolveExecutable: () => { resolveCount += 1; return "/usr/bin/true"; },
    spawner: {
      async run() {
        spawnCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };

  assert.throws(() => createProductionArtifactProviderRunner({
    providerId: "codex",
    command: "codex",
    worktreeDir,
  }, dependencies), /Codex.*disabled|tmp-granting/i);
  assert.throws(() => createProductionArtifactProviderRunner({
    providerId: "gemini",
    command: "gemini",
    worktreeDir,
  }, dependencies), /Gemini.*unsupported|workspace sandbox/i);
  assert.equal(resolveCount, 0);
  assert.equal(spawnCount, 0);
  assert.equal(existsSync(runtimeRoot), false);
});

test("production Artifact provider sandbox rejects an untrusted same-name CLI wrapper", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-untrusted-artifact-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktreeDir = join(root, "worktree");
  const wrapper = join(root, "claude");
  mkdirSync(worktreeDir);
  writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(wrapper, 0o700);

  assert.throws(
    () => createProductionArtifactProviderRunner({
      providerId: "claude",
      command: wrapper,
      worktreeDir,
    }),
    /official|trusted|executable/i,
  );
});

test("production Artifact provider sandbox rejects a fake package path outside fixed install roots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-untrusted-artifact-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktreeDir = join(root, "worktree");
  const fakePackageCli = join(root, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const configuredCommand = join(root, "claude");
  mkdirSync(join(fakePackageCli, ".."), { recursive: true });
  mkdirSync(worktreeDir);
  writeFileSync(fakePackageCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  symlinkSync(fakePackageCli, configuredCommand);

  assert.throws(
    () => createProductionArtifactProviderRunner({
      providerId: "claude",
      command: configuredCommand,
      worktreeDir,
    }),
    /official|trusted|executable/i,
  );
});

test("production Claude Artifact runner spawns with the exact environment and stdin prompt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-artifact-provider-runner-"));
  const worktreeDir = join(root, "worktree");
  const runtimeRoot = join(root, "provider-runtime");
  const hostHome = join(root, "host-home");
  const claudeConfigDir = join(root, "claude-config");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(worktreeDir);
  mkdirSync(hostHome);
  mkdirSync(claudeConfigDir);
  writeFileSync(join(worktreeDir, "index.html"), "<main>safe</main>");
  const calls: SpawnInput[] = [];
  const spawner: ProcessSpawner = {
    async run(input) {
      calls.push(input);
      return {
        stdout: [
          '{"type":"system","subtype":"init","session_id":"s1"}',
          '{"type":"result","subtype":"success","result":"done","is_error":false}',
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    },
  };
  const previous = process.env.DEZIN_AMBIENT_SECRET_SENTINEL;
  process.env.DEZIN_AMBIENT_SECRET_SENTINEL = "must-not-cross";
  t.after(() => {
    if (previous === undefined) delete process.env.DEZIN_AMBIENT_SECRET_SENTINEL;
    else process.env.DEZIN_AMBIENT_SECRET_SENTINEL = previous;
  });

  const runner = createProductionArtifactProviderRunner({
    providerId: "claude",
    command: "claude",
    model: "sonnet",
    worktreeDir,
  }, {
    resolveExecutable: () => "/usr/bin/true",
    runtimeRoot,
    hostHome,
    claudeConfigDir,
    spawner,
  });
  const result = await runner.runTurn({
    systemPrompt: "Exact system boundary",
    message: "Build the page",
    projectDir: worktreeDir,
    env: {
      ANTHROPIC_API_KEY: "provider-secret",
      ANTHROPIC_BASE_URL: "https://api.example.test",
      DEZIN_AGENT_SCOPE_PROTOCOL: "dezin.artifact-agent-scope.v1",
      DEZIN_DAEMON_TOKEN: undefined,
    },
  });

  assert.equal(result.artifactHtml, "<main>safe</main>");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.command, "/usr/bin/true");
  assert.equal(call.cwd, realpathSync(worktreeDir));
  assert.match(call.stdin, /Build the page/);
  const systemPromptIndex = call.args?.indexOf("--system-prompt") ?? -1;
  assert.notEqual(systemPromptIndex, -1);
  assert.equal(call.args?.[systemPromptIndex + 1], "Exact system boundary");
  assert.equal(call.env?.ANTHROPIC_API_KEY, "provider-secret");
  assert.equal(call.env?.ANTHROPIC_BASE_URL, "https://api.example.test");
  assert.equal(call.env?.DEZIN_AMBIENT_SECRET_SENTINEL, undefined);
  assert.equal(call.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(call.env?.HOME, realpathSync(hostHome));
  assert.equal(call.env?.CLAUDE_CONFIG_DIR, realpathSync(claudeConfigDir));
  assert.equal(call.env?.TMPDIR, realpathSync(join(runtimeRoot, "tmp")));
  assert.equal(call.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(statSync(runtimeRoot).mode & 0o777, 0o700);
});

test("production Claude Artifact runner rejects foreign provider environment and daemon capability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-artifact-provider-env-reject-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktreeDir = join(root, "worktree");
  const hostHome = join(root, "host-home");
  mkdirSync(worktreeDir);
  mkdirSync(hostHome);
  writeFileSync(join(worktreeDir, "index.html"), "<main>safe</main>");
  let spawnCount = 0;
  const runner = createProductionArtifactProviderRunner({
    providerId: "claude",
    command: "claude",
    worktreeDir,
  }, {
    resolveExecutable: () => "/usr/bin/true",
    hostHome,
    spawner: { async run() { spawnCount += 1; return { stdout: "", stderr: "", exitCode: 0 }; } },
  });
  const base = {
    systemPrompt: "boundary",
    message: "build",
    projectDir: worktreeDir,
  };
  await assert.rejects(() => runner.runTurn({
    ...base,
    env: { OPENAI_API_KEY: "foreign-secret" },
  }), /OPENAI_API_KEY|not permitted/i);
  await assert.rejects(() => runner.runTurn({
    ...base,
    env: { DEZIN_DAEMON_TOKEN: "mutation-capability" },
  }), /daemon mutation token|cannot receive/i);
  assert.equal(spawnCount, 0);
});

test("production Claude Artifact runner rejects foreign cwd and runtime roots outside its transaction", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-artifact-provider-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transactionRoot = join(root, "transaction");
  const worktreeDir = join(transactionRoot, "worktree");
  const foreignDir = join(root, "foreign-worktree");
  const hostHome = join(root, "host-home");
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(foreignDir);
  mkdirSync(hostHome);
  writeFileSync(join(worktreeDir, "index.html"), "<main>safe</main>");
  writeFileSync(join(foreignDir, "index.html"), "<main>foreign</main>");
  let spawnCount = 0;
  const dependencies = {
    resolveExecutable: () => "/usr/bin/true",
    hostHome,
    spawner: {
      async run() {
        spawnCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
  const runner = createProductionArtifactProviderRunner({
    providerId: "claude",
    command: "claude",
    worktreeDir,
  }, dependencies);
  await assert.rejects(() => runner.runTurn({
    systemPrompt: "boundary",
    message: "build",
    projectDir: foreignDir,
    env: {},
  }), /exact executable and candidate worktree|spawn does not match/i);
  assert.equal(spawnCount, 0);

  assert.throws(() => createProductionArtifactProviderRunner({
    providerId: "claude",
    command: "claude",
    worktreeDir,
  }, {
    ...dependencies,
    runtimeRoot: join(root, "outside-transaction-runtime"),
  }), /private sibling|exact candidate transaction|runtime parent/i);
  assert.throws(() => createProductionArtifactProviderRunner({
    providerId: "claude",
    command: "claude",
    worktreeDir,
  }, {
    ...dependencies,
    runtimeRoot: join(worktreeDir, "nested-runtime"),
  }), /private sibling|exact candidate transaction|runtime parent/i);
});
