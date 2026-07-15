import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLeakChecked } from "./check-process-leaks.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("process leak checker accepts a command that exits cleanly", async () => {
  const result = await runLeakChecked(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.leaks, []);
});

test("process leak checker detects and cleans an owned Vite descendant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dezin-leak-"));
  const pidFile = join(dir, "vite.pid");
  const viteScript = join(dir, "vite-leak.mjs");
  const launcher = join(dir, "launcher.mjs");
  await writeFile(viteScript, `setInterval(() => {}, 1000);`);
  await writeFile(
    launcher,
    `import { spawn } from "node:child_process";
     import { writeFileSync } from "node:fs";
     const child = spawn(process.execPath, [${JSON.stringify(viteScript)}], { stdio: "ignore" });
     writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
     child.unref();`,
  );

  await assert.rejects(
    runLeakChecked(process.execPath, [launcher], { stdio: "ignore", settleMs: 100 }),
    (error) => error?.code === "PROCESS_LEAK" && error?.leaks?.some((leak) => leak.command.includes("vite-leak.mjs")),
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  for (let attempt = 0; attempt < 30 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive(pid), false);
});

test("process leak checker detects a Vite process in a nested detached group", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "dezin-nested-leak-"));
  const pidFile = join(dir, "vite.pid");
  const viteScript = join(dir, "vite-nested-leak.mjs");
  const launcher = join(dir, "launcher.mjs");
  await writeFile(viteScript, "setInterval(() => {}, 1000);");
  await writeFile(
    launcher,
    `import { writeFileSync } from "node:fs";
     import { spawn } from "node:child_process";
     const child = spawn(process.execPath, [${JSON.stringify(viteScript)}], { detached: true, stdio: "ignore" });
     writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
     child.unref();`,
  );

  let pid = 0;
  try {
    await assert.rejects(
      runLeakChecked(process.execPath, [launcher], { stdio: "ignore", settleMs: 100 }),
      (error) => error?.code === "PROCESS_LEAK" && error?.leaks?.some((leak) => leak.command.includes("vite-nested-leak.mjs")),
    );
    pid = Number(await readFile(pidFile, "utf8"));
    for (let attempt = 0; attempt < 30 && alive(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive(pid), false);
  } finally {
    if (!pid) pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid && alive(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("a pre-existing matching Vite process group is never treated as owned", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "dezin-forged-leak-"));
  const viteScript = join(dir, "vite-unrelated.mjs");
  await writeFile(viteScript, "setInterval(() => {}, 1000);");
  const unrelated = spawn(process.execPath, [viteScript], { detached: true, stdio: "ignore" });
  unrelated.unref();
  assert.ok(unrelated.pid);
  try {
    const result = await runLeakChecked(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", settleMs: 100 });
    assert.equal(result.exitCode, 0);
    assert.equal(alive(unrelated.pid), true, "the unrelated process remains alive");
  } finally {
    if (alive(unrelated.pid)) {
      try { process.kill(-unrelated.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("process leak checker escalates a timed-out command that ignores SIGTERM", async () => {
  const started = Date.now();
  await assert.rejects(
    runLeakChecked(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore", timeoutMs: 100 },
    ),
    (error) => error?.code === "COMMAND_TIMEOUT",
  );
  assert.ok(Date.now() - started < 3_000, "timeout escalation remains bounded");
});

test("timeout classification survives a process-table inspection failure", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/dezin-intentionally-missing-path";
  try {
    await assert.rejects(
      runLeakChecked(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { stdio: "ignore", timeoutMs: 100 },
      ),
      (error) => error?.code === "COMMAND_TIMEOUT"
        && error?.cleanupError?.code === "ENOENT",
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("a timeout cleans a nested detached Vite group while preserving the timeout error", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "dezin-timeout-leak-"));
  const pidFile = join(dir, "vite.pid");
  const viteScript = join(dir, "vite-timeout-leak.mjs");
  const launcher = join(dir, "launcher.mjs");
  await writeFile(viteScript, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  await writeFile(
    launcher,
    `import { writeFileSync } from "node:fs";
     import { spawn } from "node:child_process";
     process.on("SIGTERM", () => {});
     const child = spawn(process.execPath, [${JSON.stringify(viteScript)}], { detached: true, stdio: "ignore" });
     writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
     child.unref();
     setInterval(() => {}, 1000);`,
  );

  let pid = 0;
  try {
    await assert.rejects(
      runLeakChecked(process.execPath, [launcher], { stdio: "ignore", settleMs: 100, timeoutMs: 500 }),
      (error) => error?.code === "COMMAND_TIMEOUT"
        && error?.leaks?.some((leak) => leak.command.includes("vite-timeout-leak.mjs")),
    );
    pid = Number(await readFile(pidFile, "utf8"));
    for (let attempt = 0; attempt < 30 && alive(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive(pid), false);
  } finally {
    if (!pid) pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid && alive(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});
