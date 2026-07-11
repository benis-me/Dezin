import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TEST_SUITES, runCommand, runSuites } from "./test-all.mjs";

const EXPECTED_SUITES = [
  ".",
  "packages/agent",
  "packages/core",
  "packages/craft",
  "packages/design",
  "packages/effects",
  "packages/prompt",
  "packages/quality",
  "packages/research",
  "packages/skills",
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

test("test orchestrator propagates the first suite failure", async () => {
  await assert.rejects(
    runSuites(
      [{ id: "failing", cwd: ".", command: process.execPath, args: ["-e", "process.exit(7)"] }],
      { stdio: "ignore", timeoutMs: 2_000 },
    ),
    (error) => error?.exitCode === 7 && error?.suiteId === "failing",
  );
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
