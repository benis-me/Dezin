import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const WORKSPACE_SUITES = [
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
].map((cwd) => ({ id: cwd, cwd, command: "pnpm", args: ["test"], coverageArgs: ["test:coverage"] }));

export const TEST_SUITES = [
  {
    id: "scripts",
    cwd: ".",
    command: process.execPath,
    args: ["--test", "scripts/*.test.mjs"],
    coverageArgs: [
      "--experimental-test-coverage",
      "--no-warnings",
      "--test-coverage-exclude=**/*.test.*",
      "--test-coverage-lines=84",
      "--test-coverage-branches=76",
      "--test-coverage-functions=82",
      "--test",
      "scripts/*.test.mjs",
    ],
  },
  ...WORKSPACE_SUITES,
];

function suiteError(message, suite, properties = {}) {
  return Object.assign(new Error(message), { suiteId: suite.id, ...properties });
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process group already exited.
  }
}

function groupAlive(child) {
  if (!child.pid) return false;
  try {
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupGroup(child) {
  const survivedLeader = groupAlive(child);
  if (!survivedLeader) return false;
  signalGroup(child, "SIGTERM");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (groupAlive(child)) {
    signalGroup(child, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

export async function runCommand(suite, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = resolve(REPO_ROOT, suite.cwd);
  const child = spawn(suite.command, suite.args ?? [], {
    cwd,
    stdio: options.stdio ?? "inherit",
    env: { ...process.env, ...options.env },
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  let killTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup(child, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), 1_000);
    killTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();

  let result;
  let leakedProcessGroup = false;
  try {
    result = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    leakedProcessGroup = await cleanupGroup(child);
  }

  if (timedOut) {
    throw suiteError(`Suite ${suite.id} exceeded ${timeoutMs} ms`, suite, { code: "SUITE_TIMEOUT" });
  }
  if (leakedProcessGroup) {
    throw suiteError(`Suite ${suite.id} left an owned process group running`, suite, { code: "SUITE_PROCESS_LEAK" });
  }
  if (result.exitCode !== 0) {
    throw suiteError(`Suite ${suite.id} failed with exit code ${result.exitCode ?? "signal"}`, suite, {
      exitCode: result.exitCode,
      signal: result.signal,
    });
  }
  return result;
}

export async function runSuites(suites = TEST_SUITES, options = {}) {
  const coverage = options.coverage === true;
  for (const suite of suites) {
    const selected = coverage && suite.coverageArgs ? { ...suite, args: suite.coverageArgs } : suite;
    if (options.stdio !== "ignore") process.stdout.write(`── ${suite.id} ──\n`);
    await runCommand(selected, options);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const coverage = process.argv.includes("--coverage");
  const listOnly = process.argv.includes("--list");
  if (listOnly) {
    process.stdout.write(`${TEST_SUITES.map((suite) => suite.cwd).join("\n")}\n`);
  } else {
    runSuites(TEST_SUITES, {
      coverage,
      timeoutMs: Number(process.env.DEZIN_TEST_SUITE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    })
      .then(() => process.stdout.write("SUITE: PASS\n"))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
