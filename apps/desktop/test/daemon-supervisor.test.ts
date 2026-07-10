const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createDaemonSupervisor, loadUrlWithRetry } = require("../daemon-supervisor.js");

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

function immediateSchedule(callback) {
  let active = true;
  queueMicrotask(() => {
    if (active) callback();
  });
  return () => {
    active = false;
  };
}

function createManualSchedule() {
  const entries = [];
  return {
    entries,
    schedule(callback, delay) {
      const entry = {
        delay,
        cancelled: false,
        run() {
          if (!entry.cancelled) return callback();
        },
      };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

test("concurrent ensureStarted calls spawn one daemon", async () => {
  const child = fakeChild(101);
  let spawnCalls = 0;
  let ownerId;
  let publishPortFile;
  const portFile = new Promise((resolve) => {
    publishPortFile = resolve;
  });
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      spawnCalls += 1;
      ownerId = options.ownerId;
      return child;
    },
    readPortFile: () => portFile,
    now: () => 1_000,
    schedule: immediateSchedule,
    killProcessGroup() {},
  });

  const first = supervisor.ensureStarted();
  const second = supervisor.ensureStarted();
  await Promise.resolve();

  assert.equal(spawnCalls, 1);
  publishPortFile({ url: "http://127.0.0.1:7457", pid: child.pid, ownerId });
  assert.deepEqual(await Promise.all([first, second]), ["http://127.0.0.1:7457", "http://127.0.0.1:7457"]);
  assert.equal(supervisor.state(), "ready");
});

test("readiness ignores stale portfiles with a different child PID or owner", async () => {
  const child = fakeChild(202);
  let ownerId;
  let reads = 0;
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      ownerId = options.ownerId;
      return child;
    },
    readPortFile() {
      reads += 1;
      if (reads === 1) return { url: "http://127.0.0.1:7001", pid: 999, ownerId };
      if (reads === 2) return { url: "http://127.0.0.1:7002", pid: child.pid, ownerId: "old-owner" };
      return { url: "http://127.0.0.1:7457", pid: child.pid, ownerId };
    },
    now: () => 1_000,
    schedule: immediateSchedule,
    killProcessGroup() {},
  });

  assert.equal(await supervisor.ensureStarted(), "http://127.0.0.1:7457");
  assert.equal(reads, 3);
});

test("a readiness timeout kills the spawned process group", async () => {
  const child = fakeChild(250);
  const killed = [];
  const times = [1_000, 1_000, 21_001];
  const supervisor = createDaemonSupervisor({
    spawnDaemon: () => child,
    readPortFile: () => null,
    now: () => times.shift() ?? 21_001,
    schedule: immediateSchedule,
    killProcessGroup: (pid) => killed.push(pid),
  });

  await assert.rejects(supervisor.ensureStarted(), /Timed out/);
  assert.deepEqual(killed, [child.pid]);
  assert.equal(supervisor.state(), "idle");
});

test("a recreated window reuses the ready daemon child", async () => {
  const child = fakeChild(303);
  let spawnCalls = 0;
  let ownerId;
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      spawnCalls += 1;
      ownerId = options.ownerId;
      return child;
    },
    readPortFile: () => ({ url: "http://127.0.0.1:7457", pid: child.pid, ownerId }),
    now: () => 1_000,
    schedule: immediateSchedule,
    killProcessGroup() {},
  });

  assert.equal(await supervisor.ensureStarted(), "http://127.0.0.1:7457");
  assert.equal(await supervisor.ensureStarted(), "http://127.0.0.1:7457");
  assert.equal(spawnCalls, 1);
});

test("an unexpected exit schedules at most one automatic restart", async () => {
  const children = [fakeChild(401), fakeChild(402)];
  const manual = createManualSchedule();
  let spawnCalls = 0;
  let activeChild;
  let ownerId;
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      ownerId = options.ownerId;
      activeChild = children[spawnCalls];
      spawnCalls += 1;
      return activeChild;
    },
    readPortFile: () => ({ url: "http://127.0.0.1:7457", pid: activeChild.pid, ownerId }),
    now: () => 1_000,
    schedule: manual.schedule,
    killProcessGroup() {},
  });

  await supervisor.ensureStarted();
  children[0].emit("exit", 1, null);

  assert.equal(supervisor.state(), "backoff");
  assert.equal(manual.entries.length, 1);
  assert.ok(manual.entries[0].delay > 0 && manual.entries[0].delay <= 5_000);

  await manual.entries[0].run();
  assert.equal(spawnCalls, 2);
  assert.equal(supervisor.state(), "ready");

  children[1].emit("exit", 1, null);
  assert.equal(manual.entries.length, 1);
  assert.equal(supervisor.state(), "idle");
});

test("stop kills the ready daemon process group", async () => {
  const child = fakeChild(501);
  let ownerId;
  const killed = [];
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      ownerId = options.ownerId;
      return child;
    },
    readPortFile: () => ({ url: "http://127.0.0.1:7457", pid: child.pid, ownerId }),
    now: () => 1_000,
    schedule: immediateSchedule,
    killProcessGroup: (pid) => killed.push(pid),
  });

  await supervisor.ensureStarted();
  const stopping = supervisor.stop();

  assert.equal(supervisor.state(), "stopping");
  await stopping;
  assert.deepEqual(killed, [child.pid]);
  assert.equal(supervisor.state(), "idle");
});

test("stop cancels a pending automatic restart", async () => {
  const child = fakeChild(601);
  const manual = createManualSchedule();
  let spawnCalls = 0;
  let ownerId;
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      spawnCalls += 1;
      ownerId = options.ownerId;
      return child;
    },
    readPortFile: () => ({ url: "http://127.0.0.1:7457", pid: child.pid, ownerId }),
    now: () => 1_000,
    schedule: manual.schedule,
    killProcessGroup() {},
  });

  await supervisor.ensureStarted();
  child.emit("exit", 1, null);
  assert.equal(manual.entries.length, 1);

  await supervisor.stop();
  assert.equal(manual.entries[0].cancelled, true);
  await manual.entries[0].run();
  assert.equal(spawnCalls, 1);
  assert.equal(supervisor.state(), "idle");
});

test("stop waits for a pending spawn and kills its process group", async () => {
  const child = fakeChild(701);
  let releaseSpawn;
  const spawned = new Promise((resolve) => {
    releaseSpawn = () => resolve(child);
  });
  const killed = [];
  const supervisor = createDaemonSupervisor({
    spawnDaemon: () => spawned,
    readPortFile: () => ({ url: "http://127.0.0.1:7457", pid: child.pid, ownerId: "unused" }),
    now: () => 1_000,
    schedule: immediateSchedule,
    killProcessGroup: (pid) => killed.push(pid),
  });

  const starting = supervisor.ensureStarted();
  const stopping = supervisor.stop();
  assert.equal(supervisor.state(), "stopping");

  releaseSpawn();
  await assert.rejects(starting, /stopping/);
  await stopping;
  assert.deepEqual(killed, [child.pid]);
  assert.equal(supervisor.state(), "idle");
});

test("stop is terminal and prevents a later daemon spawn", async () => {
  const child = fakeChild(801);
  let ownerId;
  let spawnCalls = 0;
  const killed = [];
  const supervisor = createDaemonSupervisor({
    spawnDaemon(options) {
      spawnCalls += 1;
      ownerId = options.ownerId;
      return child;
    },
    readPortFile: () => ({ url: "http://127.0.0.1:7457", pid: child.pid, ownerId }),
    now: () => 1_000,
    schedule: immediateSchedule,
    killProcessGroup: (pid) => killed.push(pid),
  });

  await supervisor.ensureStarted();
  await supervisor.stop();
  await assert.rejects(supervisor.ensureStarted(), /stopped/);
  await supervisor.stop();

  assert.deepEqual(killed, [child.pid]);
  assert.equal(spawnCalls, 1);
  assert.equal(supervisor.state(), "idle");
});

test("load retry stops after one retry", async () => {
  let attempts = 0;
  const loadError = new Error("load failed");

  await assert.rejects(
    loadUrlWithRetry(async () => {
      attempts += 1;
      throw loadError;
    }),
    loadError,
  );

  assert.equal(attempts, 2);
});

test("load retry is cancelled when its retry guard turns false", async () => {
  let attempts = 0;
  const loadError = new Error("window destroyed");

  await assert.rejects(
    loadUrlWithRetry(
      async () => {
        attempts += 1;
        throw loadError;
      },
      { shouldRetry: () => false },
    ),
    loadError,
  );

  assert.equal(attempts, 1);
});
