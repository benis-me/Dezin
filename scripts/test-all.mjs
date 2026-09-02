import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// The daemon suite drives real Chrome for the runtime, Export, and visual gates.
const DAEMON_TIMEOUT_MS = 20 * 60 * 1000;

const WORKSPACE_SUITES = [
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
].map((cwd) => ({
  id: cwd,
  cwd,
  command: "pnpm",
  args: ["test"],
  coverageArgs: ["test:coverage"],
  ...(cwd === "apps/daemon" ? { timeoutMs: DAEMON_TIMEOUT_MS } : {}),
}));

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

/**
 * With NODE_USE_ENV_PROXY=1 Node routes even loopback fetches through the
 * developer's proxy, whose keep-alive socket keeps test processes alive after
 * their last test. Suites talk to 127.0.0.1 constantly, so exclude loopback.
 */
export function loopbackNoProxyEnv(env) {
  const entries = new Set(
    [env.NO_PROXY, env.no_proxy].flatMap((value) => (value ?? "").split(",")).map((entry) => entry.trim()).filter(Boolean),
  );
  for (const host of ["127.0.0.1", "localhost", "::1"]) entries.add(host);
  const merged = [...entries].join(",");
  return { NO_PROXY: merged, no_proxy: merged };
}

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
  // Per-suite budgets win over the run-wide default; an explicit option overrides both.
  const timeoutMs = options.timeoutMs ?? suite.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = resolve(REPO_ROOT, suite.cwd);
  const child = spawn(suite.command, suite.args ?? [], {
    cwd,
    stdio: options.stdio ?? "inherit",
    env: { ...process.env, ...loopbackNoProxyEnv(process.env), ...options.env },
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

/**
 * Run every suite, even after one fails, so a single red suite cannot hide the
 * state of the others. Rejects at the end with every failure attached.
 */
export async function runSuites(suites = TEST_SUITES, options = {}) {
  const coverage = options.coverage === true;
  const failures = [];
  for (const suite of suites) {
    const selected = coverage && suite.coverageArgs ? { ...suite, args: suite.coverageArgs } : suite;
    if (options.stdio !== "ignore") process.stdout.write(`── ${suite.id} ──\n`);
    try {
      await runCommand(selected, options);
    } catch (error) {
      failures.push(error);
      if (options.stdio !== "ignore") process.stdout.write(`── ${suite.id} FAILED: ${error.message} ──\n`);
    }
  }
  if (failures.length > 0) {
    const summary = failures.map((failure) => failure.suiteId ?? "unknown").join(", ");
    throw Object.assign(new Error(`${failures.length} suite(s) failed: ${summary}`), { failures });
  }
  return { failures };
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
      ...(process.env.DEZIN_TEST_SUITE_TIMEOUT_MS ? { timeoutMs: Number(process.env.DEZIN_TEST_SUITE_TIMEOUT_MS) } : {}),
    })
      .then(() => process.stdout.write("SUITE: PASS\n"))
      .catch((error) => {
        for (const failure of error.failures ?? [error]) {
          process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
        }
        process.stderr.write("SUITE: FAIL\n");
        process.exitCode = 1;
      });
  }
}
