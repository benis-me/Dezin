import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type {
  ProcessSpawner,
  SpawnInput,
  SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import type { Settings } from "../../../packages/core/src/index.ts";
import {
  DesignAgentProviderUnsupportedError,
  DesignConfinedSpawner,
} from "../src/design/design-agent-confinement.ts";
import {
  createProductionDesignAnalysisRunner,
  createProductionDesignNodeRunner,
} from "../src/design/design-node-agent.ts";
import {
  designExportStagingDirectory,
  designNodeJobStagingDirectory,
} from "../src/design/design-storage.ts";

const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init","session_id":"design-test"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
  '{"type":"result","subtype":"success","result":"done","is_error":false}',
].join("\n");

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
      stdout: this.#structuredOutput ? CLAUDE_STREAM : "done",
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

test("Claude and CodeBuddy Design runners use the exact no-Bash confined policy and job cwd", async (t) => {
  const f = await fixture(t);

  for (const command of ["claude", "codebuddy"] as const) {
    const staging = command === "claude"
      ? f.nodeStaging
      : designNodeJobStagingDirectory(f.dataDir, f.projectId, "node-test", "job-codebuddy");
    await mkdir(staging, { recursive: true });
    const spawner = new RecordingSpawner();
    const runner = createProductionDesignNodeRunner(
      settings(command, "design-model"),
      { dataDir: f.dataDir, projectId: f.projectId, spawner },
    );

    const result = await runner.runTurn({
      systemPrompt: "confined system",
      message: "create the node",
      projectDir: staging,
      env: { DEZIN_TEST_LOCAL_AUTH: "preserved" },
    });

    assert.equal(result.artifactPath, "index.html");
    assert.equal(spawner.calls.length, 1);
    const call = spawner.calls[0]!;
    assert.equal(call.command, command);
    assert.equal(call.cwd, await realpath(staging));
    assert.equal(call.env?.DEZIN_TEST_LOCAL_AUTH, "preserved");
    assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read,Write,Edit,Glob,Grep");
    assert.equal(call.args[call.args.indexOf("--append-system-prompt") + 1], "confined system");
    assert.equal(call.args[call.args.indexOf("--model") + 1], "design-model");
    assert.equal(call.args.includes("bypassPermissions"), false);
    assert.equal(call.args.includes("danger-full-access"), false);
    assert.equal(call.args.some((argument) => /^(Bash|Web|Task|Agent)$/i.test(argument)), false);
    assert.match(call.stdin, /create the node/);
    assert.equal(call.args.includes("--strict-mcp-config"), true);
    assert.equal(call.args[call.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');

    if (command === "claude") {
      assert.equal(call.args.includes("--safe-mode"), true);
      assert.equal(call.args.includes("--no-chrome"), true);
      assert.equal(call.args.includes("--disable-slash-commands"), true);
    } else {
      assert.equal(call.args[call.args.indexOf("--setting-sources") + 1], "");
    }
    assert.equal(call.args.includes("--no-session-persistence"), true);
  }
});

test("Codex Design runner uses workspace-write, stdin, and the exact Export staging cwd", async (t) => {
  const f = await fixture(t);
  const spawner = new RecordingSpawner({ structuredOutput: false });
  const runner = createProductionDesignNodeRunner(
    settings("codex", "gpt-design"),
    { dataDir: f.dataDir, projectId: f.projectId, spawner },
  );

  await runner.runTurn({
    systemPrompt: "confined export system",
    message: "build the export",
    projectDir: f.exportStaging,
  });

  assert.equal(spawner.calls.length, 1);
  const call = spawner.calls[0]!;
  assert.equal(call.command, "codex");
  assert.equal(call.cwd, await realpath(f.exportStaging));
  assert.deepEqual(call.args, [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-m",
    "gpt-design",
    "-",
  ]);
  assert.equal(call.args.includes("danger-full-access"), false);
  assert.equal(call.args.includes("bypassPermissions"), false);
  assert.match(call.stdin, /confined export system/);
  assert.match(call.stdin, /build the export/);
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

test("Design runners fail closed for every provider without a verified confinement contract", () => {
  assert.throws(
    () => createProductionDesignNodeRunner(
      settings("gemini"),
      { dataDir: "/tmp/design-test", projectId: "project-test" },
    ),
    (error) => error instanceof DesignAgentProviderUnsupportedError
      && /no verified Design sandbox/i.test(error.message),
  );
  assert.throws(
    () => createProductionDesignAnalysisRunner(
      settings("custom-agent"),
      { dataDir: "/tmp/design-test", projectId: "project-test" },
    ),
    (error) => error instanceof DesignAgentProviderUnsupportedError,
  );
  assert.throws(
    () => createProductionDesignNodeRunner(
      settings("/usr/local/bin/claude"),
      { dataDir: "/tmp/design-test", projectId: "project-test" },
    ),
    (error) => error instanceof DesignAgentProviderUnsupportedError
      && /exact confined commands/i.test(error.message),
  );
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
