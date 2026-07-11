import assert from "node:assert/strict";
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
