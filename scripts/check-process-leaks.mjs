import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const OWNED_LEAK_PATTERN = /(?:\bvite(?:-|\b)|\bnpm(?:\s+run)?\s+(?:dev|preview)\b|\bpnpm(?:\s+run)?\s+(?:dev|preview)\b)/i;

async function processTable() {
  if (process.platform === "win32") return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }];
  });
}

async function processGroup(pgid) {
  return (await processTable()).filter((row) => row.pgid === pgid);
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

async function processHasOwnerMarker(pid, markerAssignment) {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.includes(markerAssignment);
  } catch {
    return false;
  }
}

async function markedProcessGroup(pgid, markerAssignment, requireLeakPattern) {
  const rows = await processGroup(pgid);
  const candidates = requireLeakPattern ? rows.filter((row) => OWNED_LEAK_PATTERN.test(row.command)) : rows;
  const ownership = await Promise.all(candidates.map(async (row) => ({
    row,
    owned: await processHasOwnerMarker(row.pid, markerAssignment),
  })));
  return ownership.filter(({ owned }) => owned).map(({ row }) => row);
}

async function terminateMarkedGroup(pgid, markerAssignment, requireLeakPattern) {
  if (!(await markedProcessGroup(pgid, markerAssignment, requireLeakPattern)).length) return [];
  signalGroup(pgid, "SIGTERM");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  // Re-authorize immediately before escalation. A stale or forged registry PID is never enough
  // to signal a process group, and a reused PGID cannot inherit this guard's random marker.
  if ((await markedProcessGroup(pgid, markerAssignment, requireLeakPattern)).length) {
    signalGroup(pgid, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return markedProcessGroup(pgid, markerAssignment, requireLeakPattern);
}

async function findOwnedLeaks(markerAssignment, childPid) {
  const candidates = (await processTable()).filter(
    (row) => row.pid !== childPid && OWNED_LEAK_PATTERN.test(row.command),
  );
  const ownership = await Promise.all(candidates.map(async (row) => ({
    row,
    owned: await processHasOwnerMarker(row.pid, markerAssignment),
  })));
  return ownership.filter(({ owned }) => owned).map(({ row }) => row);
}

async function cleanupOwnedGroups(leaks, childPid, markerAssignment) {
  const leakGroups = Array.from(new Set(leaks.map((leak) => leak.pgid)));
  const survivors = (await Promise.all(leakGroups.map(
    (pgid) => terminateMarkedGroup(pgid, markerAssignment, true),
  ))).flat();
  if (childPid && !leakGroups.includes(childPid)) {
    survivors.push(...await terminateMarkedGroup(childPid, markerAssignment, false));
  }
  return survivors;
}

async function runLeakCheckedWithMarker(command, args, options, markerName, markerValue) {
  const baseEnv = { ...process.env, ...options.env };
  const markerAssignment = `${markerName}=${markerValue}`;
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...baseEnv,
      [markerName]: markerValue,
    },
    stdio: options.stdio ?? "inherit",
    detached: process.platform !== "win32",
  });
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  let timedOut = false;
  let timeoutCleanupPromise;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutCleanupPromise = terminateMarkedGroup(child.pid, markerAssignment, false)
      .then((survivors) => {
        // A process may have removed its marker or inspection may have raced startup. The
        // ChildProcess handle is still safe to terminate directly; only group signalling
        // requires marker re-authorization.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return survivors;
      })
      .catch((error) => {
        // If process-table inspection itself failed, terminate only the exact ChildProcess
        // handle. Never fall back to an unverified process-group signal.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        throw error;
      });
    // The child exit is awaited first, but register a rejection handler immediately so a
    // fast inspection failure cannot become an unhandled rejection in the meantime.
    void timeoutCleanupPromise.catch(() => {});
  }, timeoutMs);
  timeout.unref?.();
  let exitCode;
  let signal;
  let childWaitError;
  try {
    ({ exitCode, signal } = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, exitSignal) => resolveExit({ exitCode: code, signal: exitSignal }));
    }));
  } catch (error) {
    childWaitError = error;
  } finally {
    clearTimeout(timeout);
  }
  let timeoutCleanupError;
  if (timeoutCleanupPromise) {
    try {
      await timeoutCleanupPromise;
    } catch (error) {
      timeoutCleanupError = error;
    }
  }
  if (childWaitError && !timedOut) throw childWaitError;
  await new Promise((resolveWait) => setTimeout(resolveWait, options.settleMs ?? 250));
  let leaks = [];
  let leakDiscoveryError;
  try {
    leaks = await findOwnedLeaks(markerAssignment, child.pid);
  } catch (error) {
    leakDiscoveryError = error;
  }
  if (timedOut) {
    let cleanupSurvivors = [];
    let cleanupError = timeoutCleanupError ?? leakDiscoveryError ?? childWaitError;
    try {
      cleanupSurvivors = await cleanupOwnedGroups(leaks, child.pid, markerAssignment);
    } catch (error) {
      cleanupError ??= error;
    }
    throw Object.assign(new Error(`Command exceeded ${timeoutMs} ms`), {
      code: "COMMAND_TIMEOUT",
      leaks,
      cleanupSurvivors,
      cleanupError,
    });
  }
  if (leakDiscoveryError) throw leakDiscoveryError;
  if (leaks.length) {
    const cleanupSurvivors = await cleanupOwnedGroups(leaks, child.pid, markerAssignment);
    const error = Object.assign(new Error(`Owned process leak: ${leaks.map((leak) => `${leak.pid} ${leak.command}`).join("; ")}`), {
      code: "PROCESS_LEAK",
      leaks,
      cleanupSurvivors,
    });
    throw error;
  }
  return { exitCode: exitCode ?? (signal ? 1 : 0), signal, leaks };
}

export async function runLeakChecked(command, args = [], options = {}) {
  const markerToken = randomBytes(16).toString("hex");
  const markerName = `DEZIN_PROCESS_LEAK_OWNER_${markerToken.toUpperCase()}`;
  const markerValue = randomBytes(16).toString("hex");
  return runLeakCheckedWithMarker(command, args, options, markerName, markerValue);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const separator = process.argv.indexOf("--");
  const command = separator >= 0 ? process.argv[separator + 1] : undefined;
  const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
  if (!command) {
    process.stderr.write("Usage: node scripts/check-process-leaks.mjs -- <command> [...args]\n");
    process.exitCode = 2;
  } else {
    runLeakChecked(command, args)
      .then(({ exitCode }) => {
        process.stdout.write("PROCESS LEAKS: PASS\n");
        process.exitCode = exitCode;
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
