import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPreviewLeaseManager,
  type PreviewChild,
  type PreviewLeaseManagerOptions,
} from "../src/preview-lease.ts";

class FakeChild extends EventEmitter implements PreviewChild {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  exit(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = signal ? null : code;
    this.signalCode = signal;
    this.emit("close", this.exitCode, signal);
  }
}

class FakeClock {
  now = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return { unref() {}, [Symbol.toPrimitive]: () => id } as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(Number(timer));
  };

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
}

function fakeOptions(overrides: Partial<PreviewLeaseManagerOptions> = {}): {
  options: PreviewLeaseManagerOptions;
  children: FakeChild[];
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
} {
  const children: FakeChild[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    children,
    signals,
    options: {
      allocatePort: async () => 4310 + children.length,
      spawnProcess: () => {
        const child = new FakeChild(10_000 + children.length);
        children.push(child);
        return child;
      },
      waitUntilReady: async () => {},
      isProcessGroupAlive: (child) => child.exitCode === null && child.signalCode === null,
      killProcessGroup: (child, signal) => {
        signals.push({ pid: child.pid ?? -1, signal });
        if (signal === "SIGKILL") (child as FakeChild).exit(0, signal);
      },
      readyTimeoutMs: 30,
      stopGraceMs: 5,
      leaseTtlMs: 60_000,
      idleTtlMs: 60_000,
      maxIdle: 4,
      ...overrides,
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

test("concurrent acquire shares one ready process but returns distinct renewable leases", async () => {
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const fixture = fakeOptions({ waitUntilReady: () => ready });
  const manager = createPreviewLeaseManager(fixture.options);
  const scope = { projectId: "p1", variantId: "v1" };

  const firstPending = manager.acquire(scope, "/tmp/project", { fingerprint: "head-a" });
  const secondPending = manager.acquire(scope, "/tmp/project", { fingerprint: "head-a" });
  await Promise.resolve();
  assert.equal(fixture.children.length, 1);
  releaseReady();

  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.notEqual(first.leaseId, second.leaseId);
  assert.equal(first.url, second.url);
  assert.equal(manager.activeCount(), 1);
  const renewed = await manager.renew(first.leaseId);
  assert.equal(renewed?.leaseId, first.leaseId);
  assert.ok((renewed?.expiresAt ?? 0) >= first.expiresAt);
  assert.equal(await manager.release(first.leaseId), true);
  assert.equal(await manager.release(first.leaseId), false);
  await second.release();
  await manager.stopAll();
});

test("a process that never becomes ready rejects and is reaped", async () => {
  const fixture = fakeOptions({ waitUntilReady: async (_url, _child, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const manager = createPreviewLeaseManager(fixture.options);

  await assert.rejects(
    manager.acquire({ projectId: "p-timeout" }, "/tmp/never", { fingerprint: "a" }),
    /preview readiness timed out/i,
  );
  assert.equal(manager.activeCount(), 0);
  assert.deepEqual(fixture.signals.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
});

test("a process that exits before readiness rejects without a registry entry", async () => {
  const fixture = fakeOptions({
    spawnProcess: () => {
      const child = new FakeChild(20_001);
      fixture.children.push(child);
      queueMicrotask(() => child.exit(1));
      return child;
    },
    waitUntilReady: async (_url, _child, signal) => new Promise<void>((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const manager = createPreviewLeaseManager(fixture.options);

  await assert.rejects(
    manager.acquire({ projectId: "p-exit" }, "/tmp/exits", { fingerprint: "a" }),
    /exited before readiness/i,
  );
  assert.equal(manager.activeCount(), 0);
});

test("aborting the only acquire waiter tears down its starting process", async () => {
  const fixture = fakeOptions({ waitUntilReady: async (_url, _child, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const manager = createPreviewLeaseManager(fixture.options);
  const controller = new AbortController();
  const pending = manager.acquire(
    { projectId: "p-abort", variantId: "v1" },
    "/tmp/abort",
    { fingerprint: "a", signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort();

  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(manager.activeCount(), 0);
  assert.deepEqual(fixture.signals.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
});

test("released processes expire after 60 seconds of idle time", async () => {
  const clock = new FakeClock();
  const fixture = fakeOptions({ now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const manager = createPreviewLeaseManager(fixture.options);
  const lease = await manager.acquire({ projectId: "p-idle" }, "/tmp/idle", { fingerprint: "a" });
  await lease.release();

  await clock.advance(59_999);
  assert.equal(manager.activeCount(), 1);
  await clock.advance(1);
  await waitUntil(() => manager.activeCount() === 0, "idle preview teardown did not settle");
  assert.equal(manager.activeCount(), 0);
});

test("idle LRU keeps four processes and never evicts an active lease", async () => {
  const clock = new FakeClock();
  const fixture = fakeOptions({ now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const manager = createPreviewLeaseManager(fixture.options);
  const active = await manager.acquire({ projectId: "active" }, "/tmp/active", { fingerprint: "a" });
  const released: Array<{ projectId: string; leaseId: string }> = [];
  for (let i = 0; i < 5; i += 1) {
    const projectId = `idle-${i}`;
    const lease = await manager.acquire({ projectId }, `/tmp/${projectId}`, { fingerprint: "a" });
    released.push({ projectId, leaseId: lease.leaseId });
    await lease.release();
    await clock.advance(1);
  }

  await waitUntil(() => manager.activeCount() === 5, "idle LRU teardown did not settle");
  assert.equal(manager.activeCount(), 5, "one active process plus four idle processes remain");
  assert.equal(await manager.renew(active.leaseId) !== null, true, "active lease survives idle pressure");
  const spawnedBeforeReuse = fixture.children.length;
  await manager.acquire({ projectId: released[4]!.projectId }, `/tmp/${released[4]!.projectId}`, { fingerprint: "a" });
  assert.equal(fixture.children.length, spawnedBeforeReuse, "most-recent idle process is reused");
  await manager.acquire({ projectId: released[0]!.projectId }, `/tmp/${released[0]!.projectId}`, { fingerprint: "a" });
  assert.equal(fixture.children.length, spawnedBeforeReuse + 1, "true LRU process was evicted");
  await manager.stopAll();
});

test("stopScope matches only the requested hierarchy and stopAll leaves zero", async () => {
  const fixture = fakeOptions();
  const manager = createPreviewLeaseManager(fixture.options);
  await manager.acquire({ projectId: "p1", variantId: "v1" }, "/tmp/p1-v1", { fingerprint: "a" });
  await manager.acquire({ projectId: "p1", variantId: "v2" }, "/tmp/p1-v2", { fingerprint: "a" });
  await manager.acquire({ projectId: "p2", variantId: "v1" }, "/tmp/p2-v1", { fingerprint: "a" });

  await manager.stopScope({ projectId: "p1", variantId: "v1" });
  assert.equal(manager.activeCount(), 2);
  await manager.stopScope({ projectId: "p1" });
  assert.equal(manager.activeCount(), 1);
  await manager.stopAll();
  assert.equal(manager.activeCount(), 0);
});

test("stopScope is an admission barrier for a fresh readiness flight", async () => {
  let readinessCalls = 0;
  const fixture = fakeOptions({
    waitUntilReady: async (_url, _child, signal) => {
      readinessCalls += 1;
      if (readinessCalls > 1) return;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const manager = createPreviewLeaseManager(fixture.options);
  const scope = { projectId: "barrier-fresh", variantId: "v1" };
  const acquiring = manager.acquire(scope, "/tmp/barrier-fresh", { fingerprint: "a" });
  await waitUntil(() => fixture.children.length === 1, "fresh preview never spawned");

  const stopping = manager.stopScope(scope);
  await assert.rejects(manager.acquire(scope, "/tmp/barrier-fresh", { fingerprint: "a" }), /stopping/i);
  await assert.rejects(acquiring);
  await stopping;
  assert.equal(manager.activeCount(), 0);

  const after = await manager.acquire(scope, "/tmp/barrier-fresh", { fingerprint: "a" });
  await after.release();
  await manager.stopAll();
});

test("stopScope prevents cached readiness from handing out a lease after the barrier", async () => {
  const cachedReady = deferred<void>();
  let readinessCalls = 0;
  const fixture = fakeOptions({
    waitUntilReady: async () => {
      readinessCalls += 1;
      if (readinessCalls === 2) await cachedReady.promise;
    },
  });
  const manager = createPreviewLeaseManager(fixture.options);
  const scope = { projectId: "barrier-cached", variantId: "v1" };
  const first = await manager.acquire(scope, "/tmp/barrier-cached", { fingerprint: "a" });
  const cachedAcquire = manager.acquire(scope, "/tmp/barrier-cached", { fingerprint: "a" });
  await waitUntil(() => readinessCalls === 2, "cached readiness did not begin");

  const stopping = manager.stopScope(scope);
  cachedReady.resolve();
  await assert.rejects(cachedAcquire, /stopping/i);
  await stopping;
  assert.equal(await manager.renew(first.leaseId), null);
  assert.equal(manager.activeCount(), 0);
});

test("stopScope blocks a replacement flight after cached readiness fails", async () => {
  const cachedFailure = deferred<void>();
  let readinessCalls = 0;
  const fixture = fakeOptions({
    waitUntilReady: async () => {
      readinessCalls += 1;
      if (readinessCalls === 2) {
        await cachedFailure.promise;
        throw new Error("cached port closed");
      }
    },
  });
  const manager = createPreviewLeaseManager(fixture.options);
  const scope = { projectId: "barrier-replacement", variantId: "v1" };
  await manager.acquire(scope, "/tmp/barrier-replacement", { fingerprint: "a" });
  const replacing = manager.acquire(scope, "/tmp/barrier-replacement", { fingerprint: "a" });
  await waitUntil(() => readinessCalls === 2, "cached readiness did not begin");

  const stopping = manager.stopScope(scope);
  cachedFailure.resolve();
  await assert.rejects(replacing, /stopping/i);
  await stopping;
  assert.equal(fixture.children.length, 1, "no replacement child starts after the stop snapshot");
  assert.equal(manager.activeCount(), 0);
});

test("stopAll is an admission barrier and drains a concurrent flight", async () => {
  const fixture = fakeOptions({
    waitUntilReady: async (_url, _child, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const manager = createPreviewLeaseManager(fixture.options);
  const acquiring = manager.acquire({ projectId: "barrier-all" }, "/tmp/barrier-all", { fingerprint: "a" });
  await waitUntil(() => fixture.children.length === 1, "global preview never spawned");

  const stopping = manager.stopAll();
  await assert.rejects(manager.acquire({ projectId: "other" }, "/tmp/other", { fingerprint: "a" }), /stopping/i);
  await assert.rejects(acquiring);
  await stopping;
  assert.equal(manager.activeCount(), 0);
});

test("ready-to-abort leaves no immortal zero-lease entry", { timeout: 2_000 }, async () => {
  const checkpointEntered = deferred<void>();
  const leaveCheckpoint = deferred<void>();
  const fixture = fakeOptions({
    readyEntryCheckpoint: async () => {
      checkpointEntered.resolve();
      await leaveCheckpoint.promise;
    },
  });
  const manager = createPreviewLeaseManager(fixture.options);
  const controller = new AbortController();
  const acquiring = manager.acquire(
    { projectId: "ready-abort" },
    "/tmp/ready-abort",
    { fingerprint: "a", signal: controller.signal },
  );
  await Promise.race([
    checkpointEntered.promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("ready-entry checkpoint was not reached")), 100)),
  ]);
  controller.abort();
  leaveCheckpoint.resolve();

  await assert.rejects(acquiring, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(manager.activeCount(), 0);
  assert.equal(fixture.children[0]?.exitCode !== null || fixture.children[0]?.signalCode !== null, true);
});

test("early exit aborts and settles the readiness poller loser", async () => {
  let attempts = 0;
  let readinessAborted = false;
  const fixture = fakeOptions({
    readyTimeoutMs: 500,
    spawnProcess: () => {
      const child = new FakeChild(30_001);
      fixture.children.push(child);
      queueMicrotask(() => child.exit(1));
      return child;
    },
    waitUntilReady: async (_url, _child, signal) => {
      while (!signal.aborted) {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      readinessAborted = true;
      throw signal.reason;
    },
  });
  const manager = createPreviewLeaseManager(fixture.options);
  await assert.rejects(manager.acquire({ projectId: "poll-loser" }, "/tmp/poll-loser"), /exited before readiness/i);
  const attemptsAtSettlement = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(readinessAborted, true);
  assert.equal(attempts, attemptsAtSettlement, "readiness work stops before acquire rejection settles");
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no TCP port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("default readiness rejects 404 and accepts an owned 2xx response", async () => {
  for (const status of [404, 204]) {
    const port = await freePort();
    const manager = createPreviewLeaseManager({
      allocatePort: async () => port,
      spawnProcess: ({ port: ownedPort }) => spawn(
        process.execPath,
        ["-e", `const http=require('node:http');const s=http.createServer((_q,r)=>{r.statusCode=${status};r.end()});s.listen(${ownedPort},'127.0.0.1');setInterval(()=>{},1000)`],
        { detached: process.platform !== "win32", stdio: "ignore" },
      ),
      readyTimeoutMs: 600,
      stopGraceMs: 30,
    });
    try {
      if (status === 404) {
        await assert.rejects(manager.acquire({ projectId: "strict-404" }, `/tmp/strict-${status}`), /timed out/i);
      } else {
        const lease = await manager.acquire({ projectId: "strict-204" }, `/tmp/strict-${status}`);
        assert.match(lease.url, new RegExp(`:${port}/$`));
      }
    } finally {
      await manager.stopAll();
    }
  }
});

test("leader exit triggers cleanup of a TERM-resistant detached descendant", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "dezin-preview-orphan-group-"));
  const childPidPath = join(dir, "child.pid");
  const parentScript = join(dir, "parent.mjs");
  writeFileSync(
    parentScript,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setTimeout(() => process.exit(0), 40);
`,
  );
  let leader: ReturnType<typeof spawn> | undefined;
  const manager = createPreviewLeaseManager({
    allocatePort: async () => 4331,
    spawnProcess: () => {
      leader = spawn(process.execPath, [parentScript], { cwd: dir, detached: true, stdio: "ignore" });
      return leader;
    },
    waitUntilReady: async () => {
      await waitUntil(() => {
        try { return Boolean(readFileSync(childPidPath, "utf8")); } catch { return false; }
      }, "descendant pid was not written");
    },
    stopGraceMs: 50,
  });

  let pgid = 0;
  try {
    await manager.acquire({ projectId: "orphan-group" }, dir, { fingerprint: "a" });
    pgid = leader?.pid ?? 0;
    const descendantPid = Number(readFileSync(childPidPath, "utf8"));
    await waitUntil(() => leader?.exitCode !== null, "preview leader did not exit");
    await waitUntil(() => !processGroupExists(pgid), "preview group survived leader cleanup");
    assert.equal(processExists(descendantPid), false);
    await waitUntil(() => manager.activeCount() === 0, "leader cleanup did not retire preview ownership");
    assert.equal(manager.activeCount(), 0);
  } finally {
    if (pgid && processGroupExists(pgid)) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
    await manager.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production process-group teardown removes a real descendant", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "dezin-preview-group-"));
  const childPidPath = join(dir, "child.pid");
  const parentScript = join(dir, "parent.mjs");
  writeFileSync(
    parentScript,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`,
  );
  const manager = createPreviewLeaseManager({
    allocatePort: async () => 4329,
    spawnProcess: () => spawn(process.execPath, [parentScript], { cwd: dir, detached: true, stdio: "ignore" }),
    waitUntilReady: async () => {
      for (let i = 0; i < 50; i += 1) {
        try {
          readFileSync(childPidPath, "utf8");
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      throw new Error("descendant pid was not written");
    },
    stopGraceMs: 50,
  });

  try {
    await manager.acquire({ projectId: "real" }, dir, { fingerprint: "a" });
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    assert.equal(processExists(childPid), true);
    await manager.stopAll();
    for (let i = 0; i < 50 && processExists(childPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(processExists(childPid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL teardown has a hard bound and reports a group that never disappears", async () => {
  const reported: Error[] = [];
  const fixture = fakeOptions({
    isProcessGroupAlive: () => true,
    forceKillWaitMs: 25,
    onTeardownError: (error) => reported.push(error),
  });
  const manager = createPreviewLeaseManager(fixture.options);
  await manager.acquire({ projectId: "unkillable" }, "/tmp/unkillable", { fingerprint: "a" });

  const startedAt = Date.now();
  await assert.rejects(manager.stopAll(), /did not terminate after SIGKILL/i);
  assert.ok(Date.now() - startedAt < 500, "bounded teardown does not hang shutdown");
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.name, "PreviewTeardownError");
  assert.equal(manager.activeCount(), 1, "a live failed group remains owned instead of becoming false success");
  await assert.rejects(manager.stopAll(), /did not terminate after SIGKILL/i);
  assert.equal(reported.length, 2, "a later stop retries the failed teardown instead of reusing a memoized success");
});
