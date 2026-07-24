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
  buildProductionArtifactCodeBuddyArgs,
  buildProductionArtifactCodeBuddySeatbeltProfile,
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

test("production CodeBuddy Artifact argv uses only documented permissions and sandbox settings", () => {
  const worktreeDir = "/private/tmp/dezin-artifact/worktree";
  const runtimeRoot = "/private/tmp/dezin-artifact/provider-runtime";
  const args = buildProductionArtifactCodeBuddyArgs({
    worktreeDir,
    runtimeRoot,
    hostHome: "/Users/designer",
    systemPrompt: "Build the exact Artifact.",
    model: "claude-sonnet-4.6",
  });

  assert.equal(args[0], "-p");
  assert.ok(args.includes("--verbose"));
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
    "Read,Write,Edit,Glob,Grep",
  ]);
  const disallowedToolsIndex = args.indexOf("--disallowedTools");
  assert.notEqual(disallowedToolsIndex, -1);
  const disallowedTools = new Set(args[disallowedToolsIndex + 1]!.split(","));
  for (const name of [
    "Bash",
    "PowerShell",
    "Agent",
    "Skill",
    "WebFetch",
    "WebSearch",
    "ComputerUse",
    "ToolSearch",
    "SendMessage",
    "EnterWorktree",
    "Workflow",
  ]) {
    assert.ok(disallowedTools.has(name), `${name} must be disabled at the CLI boundary`);
  }
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2), [
    "--mcp-config",
    '{"mcpServers":{}}',
  ]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--safe-mode"));
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--no-chrome"));
  assert.ok(!args.includes("bypassPermissions"));

  const settingsIndex = args.indexOf("--settings");
  assert.notEqual(settingsIndex, -1);
  const settings = JSON.parse(args[settingsIndex + 1]!) as {
    permissions: { allow: string[]; ask: string[]; deny: string[] };
    sandbox: {
      enabled: boolean;
      autoAllowBashIfSandboxed: boolean;
      excludedCommands: string[];
      allowUnsandboxedCommands: boolean;
      filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
      };
      network: {
        allowedDomains: string[];
        deniedDomains: string[];
        allowUnixSockets: string[];
        allowLocalBinding: boolean;
      };
    };
  };
  assert.deepEqual(settings.permissions.allow, [
    "Read(//private/tmp/dezin-artifact/worktree/**)",
    "Edit(//private/tmp/dezin-artifact/worktree/**)",
    "Glob",
    "Grep",
  ]);
  assert.deepEqual(settings.permissions.ask, []);
  assert.ok(settings.permissions.deny.includes("Bash"));
  assert.ok(settings.permissions.deny.includes("PowerShell"));
  assert.ok(settings.permissions.deny.includes("ComputerUse"));
  assert.ok(settings.permissions.deny.includes("SendMessage"));
  assert.ok(settings.permissions.deny.includes("WebFetch"));
  assert.ok(settings.permissions.deny.includes("WebSearch"));
  assert.ok(!settings.permissions.deny.includes("Read"));
  assert.ok(!settings.permissions.deny.includes("Edit"));
  assert.ok(!settings.permissions.deny.includes("Write"));
  assert.ok(settings.permissions.deny.includes("Read(//Users/designer/.codebuddy/**)"));
  assert.ok(settings.permissions.deny.includes("Edit(//Users/designer/.codebuddy/**)"));
  assert.ok(settings.permissions.deny.includes(
    "Read(//Users/designer/Library/Application Support/CodeBuddyExtension/Data/Public/auth/**)",
  ));
  assert.ok(settings.permissions.deny.includes(
    "Edit(//Users/designer/Library/Application Support/CodeBuddyExtension/Data/Public/auth/**)",
  ));
  assert.ok(settings.permissions.deny.includes("Edit(//private/tmp/dezin-artifact/worktree/.git/**)"));
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
  assert.deepEqual(settings.sandbox.excludedCommands, []);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem, {
    denyRead: [
      "/Users/designer/.codebuddy",
      "/Users/designer/Library/Application Support/CodeBuddyExtension/Data/Public/auth",
    ],
    allowWrite: [worktreeDir, runtimeRoot],
    denyWrite: [
      `${worktreeDir}/.git`,
      "/Users/designer/.codebuddy",
      "/Users/designer/Library/Application Support/CodeBuddyExtension/Data/Public/auth",
    ],
  });
  assert.deepEqual(settings.sandbox.network, {
    allowedDomains: [],
    deniedDomains: ["*"],
    allowUnixSockets: [],
    allowLocalBinding: false,
  });
  assert.equal("fileSafety" in settings.sandbox, false);
  assert.notDeepEqual(settings.sandbox.filesystem.denyRead, ["/"]);
  const modelIndex = args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(args[modelIndex + 1], "claude-sonnet-4.6");
});

test("production CodeBuddy outer Seatbelt profile gives the CLI only exact runtime roots", () => {
  const profile = buildProductionArtifactCodeBuddySeatbeltProfile({
    worktreeDir: "/Users/designer/project/transaction/worktree",
    runtimeRoot: "/Users/designer/project/transaction/provider-runtime",
    hostHome: "/Users/designer",
    executable: "/Users/designer/.local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy",
    nodeRuntimeRoot: "/Users/designer/.hermes/node",
  });

  assert.match(profile, /^\(version 1\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/Users"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/private\/tmp"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/tmp"\)\)/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/Volumes"\)\)/);
  assert.match(profile, /\(allow file-read-data /);
  assert.doesNotMatch(profile, /\(deny file-read\*\)/);
  assert.doesNotMatch(profile, /^\(deny file-read-data\)$/m);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /subpath "\/Users\/designer\/project\/transaction\/worktree"/);
  assert.match(profile, /subpath "\/Users\/designer\/project\/transaction\/provider-runtime"/);
  assert.match(profile, /subpath "\/Users\/designer\/\.codebuddy"/);
  assert.match(profile, /subpath "\/Users\/designer\/Library\/Application Support\/CodeBuddyExtension\/Data\/Public\/auth"/);
  assert.match(profile, /subpath "\/Users\/designer\/\.local\/lib\/node_modules\/@tencent-ai\/codebuddy-code"/);
  assert.match(profile, /subpath "\/Users\/designer\/\.hermes\/node"/);
  assert.match(profile, /\(deny file-write\* \(subpath "\/Users\/designer\/project\/transaction\/worktree\/\.git"\)\)/);
  assert.doesNotMatch(profile, /\(allow network/);
  assert.doesNotMatch(profile, /\(deny network/);
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

test("production Artifact provider sandbox trusts only the official CodeBuddy package root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-codebuddy-package-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transactionRoot = join(root, "transaction");
  const worktreeDir = join(transactionRoot, "worktree");
  const hostHome = join(root, "host-home");
  const officialCli = join(
    hostHome,
    ".local",
    "lib",
    "node_modules",
    "@tencent-ai",
    "codebuddy-code",
    "bin",
    "codebuddy",
  );
  const officialLink = join(hostHome, ".local", "bin", "codebuddy");
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(join(officialCli, ".."), { recursive: true });
  mkdirSync(join(officialLink, ".."), { recursive: true });
  writeFileSync(officialCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  symlinkSync(officialCli, officialLink);

  assert.doesNotThrow(() => createProductionArtifactProviderRunner({
    providerId: "codebuddy",
    command: "codebuddy",
    worktreeDir,
  }, {
    hostHome,
    platform: "darwin",
    sandboxExecutable: "/usr/bin/true",
    spawner: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
  }));

  const fakeCli = join(
    root,
    "untrusted",
    "node_modules",
    "@tencent-ai",
    "codebuddy-code",
    "bin",
    "codebuddy",
  );
  mkdirSync(join(fakeCli, ".."), { recursive: true });
  writeFileSync(fakeCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.throws(() => createProductionArtifactProviderRunner({
    providerId: "codebuddy",
    command: fakeCli,
    worktreeDir,
  }, {
    hostHome,
    platform: "darwin",
    sandboxExecutable: "/usr/bin/true",
    spawner: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
  }), /official|trusted|executable/i);
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
  const previousCodeBuddyKey = process.env.CODEBUDDY_API_KEY;
  process.env.DEZIN_AMBIENT_SECRET_SENTINEL = "must-not-cross";
  process.env.CODEBUDDY_API_KEY = "ambient-codebuddy-secret-must-not-cross";
  t.after(() => {
    if (previous === undefined) delete process.env.DEZIN_AMBIENT_SECRET_SENTINEL;
    else process.env.DEZIN_AMBIENT_SECRET_SENTINEL = previous;
    if (previousCodeBuddyKey === undefined) delete process.env.CODEBUDDY_API_KEY;
    else process.env.CODEBUDDY_API_KEY = previousCodeBuddyKey;
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

test("production CodeBuddy Artifact runner preserves registered stream semantics inside the exact sandbox", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-codebuddy-artifact-provider-"));
  const worktreeDir = join(root, "worktree");
  const runtimeRoot = join(root, "provider-runtime");
  const hostHome = join(root, "host-home");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(worktreeDir);
  mkdirSync(hostHome);
  writeFileSync(join(worktreeDir, "index.html"), "<main>codebuddy-safe</main>");
  const stream = [
    '{"type":"system","subtype":"init","session_id":"cb1"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Built with CodeBuddy."}]}}',
    '{"type":"result","subtype":"success","result":"done","is_error":false}',
  ].join("\n");
  const calls: SpawnInput[] = [];
  const spawner: ProcessSpawner = {
    async run(input) {
      calls.push(input);
      input.onStdout?.(`${stream}\n`);
      return { stdout: stream, stderr: "", exitCode: 0 };
    },
  };
  const previous = process.env.DEZIN_AMBIENT_SECRET_SENTINEL;
  process.env.DEZIN_AMBIENT_SECRET_SENTINEL = "must-not-cross";
  t.after(() => {
    if (previous === undefined) delete process.env.DEZIN_AMBIENT_SECRET_SENTINEL;
    else process.env.DEZIN_AMBIENT_SECRET_SENTINEL = previous;
  });
  const controller = new AbortController();
  const activity: unknown[] = [];

  const runner = createProductionArtifactProviderRunner({
    providerId: "codebuddy",
    command: "codebuddy",
    model: "claude-sonnet-4.6",
    worktreeDir,
  }, {
    resolveExecutable: () => "/usr/bin/true",
    runtimeRoot,
    hostHome,
    platform: "darwin",
    sandboxExecutable: "/usr/bin/true",
    spawner,
  });
  const result = await runner.runTurn({
    systemPrompt: "Exact CodeBuddy system boundary",
    message: "Build the component",
    projectDir: worktreeDir,
    signal: controller.signal,
    onActivity: (event) => activity.push(event),
    env: {
      DEZIN_AGENT_SCOPE_PROTOCOL: "dezin.artifact-agent-scope.v1",
      DEZIN_AGENT_CAPABILITIES: '["artifact.read","artifact.write"]',
      DEZIN_DAEMON_TOKEN: undefined,
    },
  });

  assert.equal(result.text, "Built with CodeBuddy.");
  assert.equal(result.artifactHtml, "<main>codebuddy-safe</main>");
  assert.ok(activity.length > 0);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.command, "/usr/bin/true");
  assert.equal(call.cwd, realpathSync(worktreeDir));
  assert.equal(call.args[0], "-p");
  assert.match(call.args[1]!, /\(deny file-read-data \(subpath "\/Users"\)\)/);
  assert.equal(call.args[2], "/usr/bin/true");
  assert.equal(call.signal, controller.signal);
  assert.match(call.stdin, /Build the component/);
  const systemPromptIndex = call.args.indexOf("--system-prompt");
  assert.notEqual(systemPromptIndex, -1);
  assert.equal(call.args[systemPromptIndex + 1], "Exact CodeBuddy system boundary");
  assert.equal(call.timeoutMs, 8 * 60_000);
  const modelIndex = call.args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(call.args[modelIndex + 1], "claude-sonnet-4.6");
  assert.ok(!call.args.includes("bypassPermissions"));
  assert.equal(call.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(call.env?.CODEBUDDY_API_KEY, undefined);
  assert.equal(call.env?.DEZIN_AGENT_SCOPE_PROTOCOL, "dezin.artifact-agent-scope.v1");
  assert.equal(call.env?.DEZIN_AGENT_CAPABILITIES, '["artifact.read","artifact.write"]');
  assert.equal(call.env?.DEZIN_AMBIENT_SECRET_SENTINEL, undefined);
  assert.equal(call.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(call.env?.HOME, realpathSync(hostHome));
  assert.equal(call.env?.TMPDIR, realpathSync(join(runtimeRoot, "tmp")));
});

test("production CodeBuddy Artifact runner keeps provider credentials out of its process environment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-codebuddy-artifact-credential-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktreeDir = join(root, "worktree");
  const hostHome = join(root, "host-home");
  mkdirSync(worktreeDir);
  mkdirSync(hostHome);
  writeFileSync(join(worktreeDir, "index.html"), "<main>safe</main>");
  let spawnCount = 0;
  const runner = createProductionArtifactProviderRunner({
    providerId: "codebuddy",
    command: "codebuddy",
    worktreeDir,
  }, {
    resolveExecutable: () => "/usr/bin/true",
    hostHome,
    platform: "darwin",
    sandboxExecutable: "/usr/bin/true",
    spawner: {
      async run() {
        spawnCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  });

  for (const env of [
    { ANTHROPIC_API_KEY: "must-not-reach-codebuddy-bash" },
    { CODEBUDDY_API_KEY: "must-not-reach-codebuddy-bash" },
    { CODEBUDDY_AUTH_TOKEN: "must-not-reach-codebuddy-bash" },
  ]) {
    await assert.rejects(() => runner.runTurn({
      systemPrompt: "boundary",
      message: "build",
      projectDir: worktreeDir,
      env,
    }), /ANTHROPIC_API_KEY|CODEBUDDY_(?:API_KEY|AUTH_TOKEN)|not permitted/i);
  }
  assert.equal(spawnCount, 0);
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
