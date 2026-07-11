import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const OWNED_LEAK_PATTERN = /(?:\bvite(?:-|\b)|\bnpm(?:\s+run)?\s+(?:dev|preview)\b|\bpnpm(?:\s+run)?\s+(?:dev|preview)\b)/i;

async function processGroup(pgid) {
  if (process.platform === "win32") return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || Number(match[2]) !== pgid) return [];
    return [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }];
  });
}

function signalGroup(pid, signal) {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

async function terminateGroup(pid) {
  signalGroup(pid, "SIGTERM");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if ((await processGroup(pid)).length) {
    signalGroup(pid, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export async function runLeakChecked(command, args = [], options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "inherit",
    detached: process.platform !== "win32",
  });
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  let timedOut = false;
  let killTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 1_000);
    killTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();
  const { exitCode, signal } = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => resolveExit({ exitCode: code, signal: exitSignal }));
  });
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  await new Promise((resolveWait) => setTimeout(resolveWait, options.settleMs ?? 250));
  const rows = child.pid ? await processGroup(child.pid) : [];
  const leaks = rows.filter((row) => row.pid !== child.pid && OWNED_LEAK_PATTERN.test(row.command));
  if (leaks.length) {
    await terminateGroup(child.pid);
    const error = Object.assign(new Error(`Owned process leak: ${leaks.map((leak) => `${leak.pid} ${leak.command}`).join("; ")}`), {
      code: "PROCESS_LEAK",
      leaks,
    });
    throw error;
  }
  if (timedOut) {
    await terminateGroup(child.pid);
    throw Object.assign(new Error(`Command exceeded ${timeoutMs} ms`), { code: "COMMAND_TIMEOUT" });
  }
  return { exitCode: exitCode ?? (signal ? 1 : 0), signal, leaks };
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
