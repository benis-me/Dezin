import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchElectronParent } from "../src/electron-parent-lifecycle.ts";

test("an Electron-owned daemon shuts down exactly once when its parent IPC disconnects", () => {
  const parent = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: () => void;
  };
  parent.connected = true;
  parent.send = () => {};
  const reasons: string[] = [];

  watchElectronParent({
    enabled: true,
    parent,
    shutdown: (reason) => reasons.push(reason),
  });
  parent.emit("disconnect");
  parent.emit("disconnect");

  assert.deepEqual(reasons, ["Electron parent disconnected"]);
});

test("a standalone daemon never adopts an unrelated process disconnect lifecycle", () => {
  const parent = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: () => void;
  };
  parent.connected = true;
  parent.send = () => {};
  let shutdowns = 0;

  watchElectronParent({
    enabled: false,
    parent,
    shutdown: () => { shutdowns += 1; },
  });
  parent.emit("disconnect");

  assert.equal(shutdowns, 0);
  assert.equal(parent.listenerCount("disconnect"), 0);
});

test("an Electron daemon observes a parent that disconnected before its listener was installed", () => {
  const parent = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: () => void;
  };
  parent.connected = false;
  parent.send = () => {};
  const reasons: string[] = [];

  watchElectronParent({
    enabled: true,
    parent,
    shutdown: (reason) => reasons.push(reason),
  });

  assert.deepEqual(reasons, ["Electron parent disconnected"]);
  assert.equal(parent.listenerCount("disconnect"), 0);
});

test("normal daemon shutdown can detach the Electron parent watcher", () => {
  const parent = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: () => void;
  };
  parent.connected = true;
  parent.send = () => {};
  let shutdowns = 0;

  const stopWatching = watchElectronParent({
    enabled: true,
    parent,
    shutdown: () => { shutdowns += 1; },
  });
  stopWatching();
  parent.emit("disconnect");

  assert.equal(shutdowns, 0);
  assert.equal(parent.listenerCount("disconnect"), 0);
});

test("an Electron-owned daemon releases its IPC watcher when startup fails", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-electron-startup-failure-"));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "--no-warnings",
      new URL("../src/start.ts", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        DEZIN_DATA_DIR: dataDir,
        DEZIN_ELECTRON: "1",
        // Invalid by design: server.listen throws synchronously after the IPC
        // watcher has been installed, exercising the startup rollback path.
        DEZIN_PORT: "-1",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 3_000).unref();
      }),
    ]);
    if (exit === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }

    assert.notEqual(exit, null, "startup failure must not stay alive behind the Electron IPC channel");
    assert.equal(exit?.code, 1);
    assert.equal(exit?.signal, null);
    assert.match(stderr, /Dezin daemon failed to start/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
});
