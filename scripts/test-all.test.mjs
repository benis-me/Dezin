import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TEST_SUITES, loopbackNoProxyEnv, runCommand, runSuites } from "./test-all.mjs";

test("suites run with loopback excluded from any environment proxy", () => {
  assert.deepEqual(loopbackNoProxyEnv({}), { NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
  assert.equal(loopbackNoProxyEnv({ NO_PROXY: "corp.internal,localhost" }).NO_PROXY, "corp.internal,localhost,127.0.0.1,::1");
});

const EXPECTED_SUITES = [
  ".",
  "packages/agent",
  "packages/core",
  "packages/design",
  "packages/design-canvas-contracts",
  "packages/effects",
  "apps/daemon",
  "apps/desktop",
  "apps/extension",
  "packages/leafer-react",
  "apps/web",
];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("test orchestrator enumerates every supported suite exactly once", () => {
  assert.deepEqual(TEST_SUITES.map((suite) => suite.cwd), EXPECTED_SUITES);
  assert.equal(new Set(TEST_SUITES.map((suite) => suite.cwd)).size, EXPECTED_SUITES.length);
});

test("the browser-backed daemon suite gets a larger budget than the default", () => {
  const daemon = TEST_SUITES.find((suite) => suite.cwd === "apps/daemon");
  assert.ok(daemon.timeoutMs > 10 * 60 * 1000);
  assert.equal(TEST_SUITES.find((suite) => suite.cwd === "apps/web").timeoutMs, undefined);
});

test("test orchestrator runs every suite and reports all failures at the end", async () => {
  const ran = [];
  const marker = (name) => ({
    id: name,
    cwd: ".",
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(name)}); process.exit(${name.startsWith("fail") ? 7 : 0})`],
  });
  const suites = [marker("fail-a"), marker("ok-b"), marker("fail-c")];
  const originalRun = runCommand;
  await assert.rejects(
    runSuites(suites, { stdio: "ignore", timeoutMs: 5_000 }),
    (error) => {
      const ids = error.failures.map((failure) => failure.suiteId);
      assert.deepEqual(ids, ["fail-a", "fail-c"]);
      assert.equal(error.failures[0].exitCode, 7);
      return /2 suite\(s\) failed: fail-a, fail-c/.test(error.message);
    },
  );
  assert.equal(originalRun, runCommand);
  assert.deepEqual(ran, []);
});

test("a passing run resolves with no failures", async () => {
  const result = await runSuites(
    [{ id: "ok", cwd: ".", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    { stdio: "ignore", timeoutMs: 5_000 },
  );
  assert.deepEqual(result.failures, []);
});

test("a timed-out suite is bounded and leaves no descendant process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dezin-test-all-"));
  const pidFile = join(dir, "child.pid");
  const childCode = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  await assert.rejects(
    runCommand({ id: "timeout", cwd: ".", command: process.execPath, args: ["-e", childCode] }, { stdio: "ignore", timeoutMs: 100 }),
    (error) => error?.code === "SUITE_TIMEOUT",
  );
  assert.ok(Date.now() - started < 3_000, "timeout remains bounded");
  const pid = Number(await readFile(pidFile, "utf8"));
  for (let attempt = 0; attempt < 30 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive(pid), false);
});

test("a per-suite timeout budget applies when the run gives none", async () => {
  await assert.rejects(
    runCommand(
      { id: "slow", cwd: ".", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 100 },
      { stdio: "ignore" },
    ),
    (error) => error?.code === "SUITE_TIMEOUT",
  );
});

test("a successful suite fails when it leaves an owned descendant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dezin-test-leak-"));
  const pidFile = join(dir, "vite.pid");
  const viteScript = join(dir, "vite-leak.mjs");
  const launcher = join(dir, "launcher.mjs");
  await writeFile(viteScript, "setInterval(() => {}, 1000);");
  await writeFile(
    launcher,
    `import { spawn } from "node:child_process";
     import { writeFileSync } from "node:fs";
     const child = spawn(process.execPath, [${JSON.stringify(viteScript)}], { stdio: "ignore" });
     writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
     child.unref();`,
  );

  await assert.rejects(
    runCommand({ id: "leaking", cwd: ".", command: process.execPath, args: [launcher] }, { stdio: "ignore", timeoutMs: 2_000 }),
    (error) => error?.code === "SUITE_PROCESS_LEAK" && error?.suiteId === "leaking",
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  for (let attempt = 0; attempt < 30 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive(pid), false);
});
