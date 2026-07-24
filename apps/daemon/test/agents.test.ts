import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  AGENT_PROVIDERS,
  ProcessGroupCleanupError,
  abortError,
  isAbortError,
  type AgentProvider,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { detectAgents, getAgents, warmAgents, type AgentProber, type AgentInfo } from "../src/agents-handler.ts";
import { shutdownDaemon } from "../src/daemon-shutdown.ts";
import type { RuntimeSupervisor } from "../src/runtime-supervisor.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const onlyClaude: AgentProber = async (command) =>
  command === "claude" ? { available: true, version: "claude 1.2.3" } : { available: false };

const onlyCodeBuddyWithoutAuth: AgentProber = async (command) =>
  command === "codebuddy"
    ? {
        available: true,
        version: "2.126.0",
        readiness: {
          status: "authentication-required",
          reason: "Sign in to CodeBuddy, then rescan agents.",
        },
      }
    : { available: false };

test("warmAgents defers default CLI readiness on a fresh data directory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-agents-lazy-"));
  assert.equal(warmAgents(undefined, dataDir), false);
});

test("warmAgents loads persisted state but defers live readiness until the first catalog request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-agents-lazy-persisted-"));
  writeFileSync(
    join(dataDir, "agents.json"),
    JSON.stringify([
      { id: "claude", command: "claude", available: true, availability: "ready", version: "cached", models: ["opus"] },
    ]),
  );
  let probes = 0;
  const prober: AgentProber = async (command) => {
    probes += 1;
    return command === "claude" ? { available: true, version: "live" } : { available: false };
  };

  assert.equal(warmAgents(prober, dataDir), true);
  assert.equal(probes, 0);
  const agents = await getAgents(prober);
  assert.ok(probes > 0);
  assert.equal(agents.find((agent) => agent.id === "claude")?.version, "live");
});

test("detectAgents probes each known agent + carries known models", async () => {
  const agents = await detectAgents(onlyClaude);
  // claude/codex/gemini lead the list; more candidates may follow.
  assert.deepEqual(agents.slice(0, 3).map((a) => a.id), ["claude", "codex", "gemini"]);
  const claude = agents.find((a) => a.id === "claude")!;
  assert.equal(claude.available, true);
  assert.equal(claude.version, "claude 1.2.3");
  assert.ok(claude.models.includes("opus"), "claude carries its model aliases");
  assert.equal(agents.find((a) => a.id === "codex")!.available, false);
});

test("detectAgents distinguishes an installed CodeBuddy CLI from a signed-in provider", async () => {
  const agents = await detectAgents(onlyCodeBuddyWithoutAuth);
  const codebuddy = agents.find((agent) => agent.id === "codebuddy")!;

  assert.equal(codebuddy.version, "2.126.0");
  assert.equal(codebuddy.available, false);
  assert.equal(codebuddy.availability, "authentication-required");
  assert.match(codebuddy.unavailableReason ?? "", /sign in to codebuddy/i);
});

test("inspectAgent forwards cancellation to provider readiness and rethrows AbortError", async () => {
  const handlers = await import("../src/agents-handler.ts") as unknown as {
    inspectAgent?: (
      provider: AgentProvider,
      prober: AgentProber,
      deep: boolean,
      onPhase?: (phase: "probe" | "readiness" | "models") => void,
      signal?: AbortSignal,
    ) => Promise<AgentInfo>;
  };
  assert.equal(typeof handlers.inspectAgent, "function");

  const readinessEntered = deferred<AbortSignal>();
  const provider: AgentProvider = {
    id: "fixture",
    command: "fixture",
    label: "Fixture",
    seedModels: ["fixture-model"],
    probeReadiness: async (_command, options) => {
      assert.ok(options?.signal);
      readinessEntered.resolve(options.signal);
      await new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      return { status: "ready" };
    },
    createRunner() {
      throw new Error("not used");
    },
    oneShotArgs() {
      return [];
    },
  };
  const controller = new AbortController();
  const scan = handlers.inspectAgent!(
    provider,
    async () => ({ available: true }),
    false,
    undefined,
    controller.signal,
  );

  assert.equal(await readinessEntered.promise, controller.signal);
  controller.abort();
  await assert.rejects(scan, (error) => isAbortError(error));
});

test("inspectAgent forwards cancellation to provider model discovery", async () => {
  const handlers = await import("../src/agents-handler.ts") as unknown as {
    inspectAgent: (
      provider: AgentProvider,
      prober: AgentProber,
      deep: boolean,
      onPhase?: (phase: "probe" | "readiness" | "models") => void,
      signal?: AbortSignal,
    ) => Promise<AgentInfo>;
  };
  const discoveryEntered = deferred<AbortSignal>();
  const provider = {
    id: "fixture",
    command: "fixture",
    label: "Fixture",
    seedModels: ["fixture-model"],
    async discoverModels(_command: string, _deep?: boolean, signal?: AbortSignal) {
      assert.ok(signal);
      discoveryEntered.resolve(signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      return [];
    },
    createRunner() {
      throw new Error("not used");
    },
    oneShotArgs() {
      return [];
    },
  } as AgentProvider;
  const controller = new AbortController();
  const scan = handlers.inspectAgent(
    provider,
    async () => ({ available: true }),
    true,
    undefined,
    controller.signal,
  );

  assert.equal(await discoveryEntered.promise, controller.signal);
  controller.abort();
  await assert.rejects(scan, (error) => isAbortError(error));
});

test("detectAgents waits for every provider cleanup before rejecting cancellation", async () => {
  const claudeEntered = deferred<void>();
  const codeBuddyEntered = deferred<void>();
  const releaseCodeBuddyCleanup = deferred<void>();
  const controller = new AbortController();
  const scan = detectAgents(async (command, signal) => {
    if (command !== "claude" && command !== "codebuddy") return { available: false };
    if (command === "claude") claudeEntered.resolve();
    else codeBuddyEntered.resolve();
    await new Promise<void>((resolve) => {
      signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    if (command === "codebuddy") await releaseCodeBuddyCleanup.promise;
    throw abortError();
  }, false, controller.signal);
  await Promise.all([claudeEntered.promise, codeBuddyEntered.promise]);
  controller.abort();

  const settledEarly = await Promise.race([
    scan.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  assert.equal(settledEarly, false);
  releaseCodeBuddyCleanup.resolve();
  await assert.rejects(scan, (error) => isAbortError(error));
});

test("closing an agents request aborts its readiness scan", async () => {
  const store = new Store(":memory:");
  const probeEntered = deferred<AbortSignal>();
  const releaseProbe = deferred<void>();
  const prober: AgentProber = async (command, signal) => {
    if (command !== "claude") return { available: false };
    assert.ok(signal);
    probeEntered.resolve(signal);
    await Promise.race([
      releaseProbe.promise,
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    ]);
    return { available: false };
  };
  const server = createApp({
    store,
    dataDir: mkdtempSync(join(tmpdir(), "dezin-agents-request-abort-")),
    agentProber: prober,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const requestController = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/api/agents`, {
    signal: requestController.signal,
  }).catch(() => undefined);

  try {
    const readinessSignal = await probeEntered.promise;
    requestController.abort();
    const cancelled = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (readinessSignal.aborted) {
          resolve(true);
          return;
        }
        readinessSignal.addEventListener("abort", () => resolve(true), { once: true });
      }),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(cancelled, true);
  } finally {
    releaseProbe.resolve();
    await request;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("one cancelled catalog waiter does not abort a shared scan while another waiter remains", async () => {
  warmAgents(undefined, mkdtempSync(join(tmpdir(), "dezin-agents-shared-scan-")));
  const probeEntered = deferred<AbortSignal>();
  const releaseProbe = deferred<void>();
  const prober: AgentProber = async (command, signal) => {
    if (command !== "claude") return { available: false };
    assert.ok(signal);
    probeEntered.resolve(signal);
    await Promise.race([
      releaseProbe.promise,
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    ]);
    return { available: true, version: "shared-live" };
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = getAgents(prober, false, firstController.signal);
  const readinessSignal = await probeEntered.promise;
  const second = getAgents(prober, false, secondController.signal);

  firstController.abort();
  await assert.rejects(first, (error) => isAbortError(error));
  assert.equal(readinessSignal.aborted, false);
  releaseProbe.resolve();

  const agents = await second;
  assert.equal(agents.find((agent) => agent.id === "claude")?.version, "shared-live");
});

test("a new catalog request does not join an already-aborted inflight scan", async () => {
  warmAgents(undefined, mkdtempSync(join(tmpdir(), "dezin-agents-replace-aborted-")));
  const firstProbeEntered = deferred<void>();
  const releaseFirstProbe = deferred<void>();
  let claudeAttempts = 0;
  const prober: AgentProber = async (command, signal) => {
    if (command !== "claude") return { available: false };
    claudeAttempts += 1;
    if (claudeAttempts === 1) {
      firstProbeEntered.resolve();
      await releaseFirstProbe.promise;
      signal?.throwIfAborted();
    }
    return { available: true, version: `attempt-${claudeAttempts}` };
  };
  const controller = new AbortController();
  const first = getAgents(prober, false, controller.signal);
  await firstProbeEntered.promise;
  controller.abort();
  await assert.rejects(first, (error) => isAbortError(error));

  const second = await getAgents(prober);
  assert.equal(second.find((agent) => agent.id === "claude")?.version, "attempt-2");
  releaseFirstProbe.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("an older shallow scan cannot overwrite a newer forced scan result", async () => {
  warmAgents(undefined, mkdtempSync(join(tmpdir(), "dezin-agents-scan-order-")));
  const oldProbeEntered = deferred<void>();
  const releaseOldProbe = deferred<void>();
  const oldScan = getAgents(async (command) => {
    if (command !== "claude") return { available: false };
    oldProbeEntered.resolve();
    await releaseOldProbe.promise;
    return { available: true, version: "old-shallow" };
  });
  await oldProbeEntered.promise;

  const freshScanPromise = getAgents(
    async (command) => command === "claude"
      ? { available: true, version: "new-deep" }
      : { available: false },
    true,
  );
  releaseOldProbe.resolve();
  await oldScan;
  const freshScan = await freshScanPromise;
  assert.equal(freshScan.find((agent) => agent.id === "claude")?.version, "new-deep");

  const cached = await getAgents(async () => {
    throw new Error("the current cache should be reusable");
  });
  assert.equal(cached.find((agent) => agent.id === "claude")?.version, "new-deep");
});

test("streaming deep rescan is the canonical scan reused by GET and forced rescan", async () => {
  const store = new Store(":memory:");
  const firstProbeEntered = deferred<void>();
  const releaseFirstProbe = deferred<void>();
  let probes = 0;
  const prober: AgentProber = async (command) => {
    probes += 1;
    if (probes === 1) {
      firstProbeEntered.resolve();
      await releaseFirstProbe.promise;
    }
    return command === "claude"
      ? { available: true, version: "coordinated-deep" }
      : { available: false };
  };
  const server = createApp({
    store,
    dataDir: mkdtempSync(join(tmpdir(), "dezin-agents-stream-coordinator-")),
    agentProber: prober,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const streamRequest = fetch(`${base}/api/agents/rescan-stream`, { method: "POST" });
    await firstProbeEntered.promise;
    const listRequest = fetch(`${base}/api/agents`);
    const forcedRequest = fetch(`${base}/api/agents/rescan`, { method: "POST" });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(probes, 1, "all concurrent catalog requests reuse the streaming deep scan");
    releaseFirstProbe.resolve();
    const [streamResponse, listResponse, forcedResponse] = await Promise.all([
      streamRequest,
      listRequest,
      forcedRequest,
    ]);
    assert.equal(streamResponse.status, 200);
    assert.equal(listResponse.status, 200);
    assert.equal(forcedResponse.status, 200);
    await streamResponse.text();
    const listed = (await listResponse.json()) as AgentInfo[];
    const forced = (await forcedResponse.json()) as AgentInfo[];
    assert.equal(listed.find((agent) => agent.id === "claude")?.version, "coordinated-deep");
    assert.equal(forced.find((agent) => agent.id === "claude")?.version, "coordinated-deep");
    assert.equal(probes, AGENT_PROVIDERS.length);

    const cachedResponse = await fetch(`${base}/api/agents`);
    assert.equal(cachedResponse.status, 200);
    assert.equal(probes, AGENT_PROVIDERS.length, "deep result remains the current cache");
  } finally {
    releaseFirstProbe.resolve();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    store.close();
  }
});

test("daemon shutdown waits for delayed provider cleanup before closing Store", async () => {
  warmAgents(undefined, mkdtempSync(join(tmpdir(), "dezin-agents-delayed-cleanup-")));
  const probeEntered = deferred<void>();
  const cleanupEntered = deferred<void>();
  const releaseCleanup = deferred<void>();
  const scan = getAgents(async (command, signal) => {
    if (command !== "claude") return { available: false };
    probeEntered.resolve();
    await new Promise<void>((resolve) => {
      signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    cleanupEntered.resolve();
    await releaseCleanup.promise;
    throw abortError();
  });
  const scanOutcome = scan.then(() => undefined, (error: unknown) => error);
  await probeEntered.promise;
  const server = http.createServer();
  let storeClosed = false;
  const shuttingDown = shutdownDaemon({
    server,
    runtimeSupervisor: {
      shutdown: async () => true,
    } as unknown as RuntimeSupervisor,
    closeStore: () => {
      storeClosed = true;
    },
    timeoutMs: 500,
  });

  await cleanupEntered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(storeClosed, false);
  releaseCleanup.resolve();
  assert.equal(await shuttingDown, true);
  assert.equal(storeClosed, true);
  assert.equal(isAbortError(await scanOutcome), true);
});

test("daemon shutdown reports a provider process-group cleanup failure", async () => {
  warmAgents(undefined, mkdtempSync(join(tmpdir(), "dezin-agents-cleanup-failure-")));
  const probeEntered = deferred<void>();
  const scan = getAgents(async (command, signal) => {
    if (command !== "claude") return { available: false };
    probeEntered.resolve();
    await new Promise<void>((resolve) => {
      signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new ProcessGroupCleanupError("fixture", Promise.resolve());
  });
  const scanOutcome = scan.then(() => undefined, (error: unknown) => error);
  await probeEntered.promise;
  const server = http.createServer();
  const result = await shutdownDaemon({
    server,
    runtimeSupervisor: {
      shutdown: async () => true,
    } as unknown as RuntimeSupervisor,
    closeStore() {},
    timeoutMs: 500,
  });

  assert.equal(result, false);
  assert.ok(await scanOutcome instanceof ProcessGroupCleanupError);
});

test("daemon shutdown aborts an in-flight agents readiness scan before closing connections", async () => {
  const store = new Store(":memory:");
  const probeEntered = deferred<AbortSignal>();
  const releaseProbe = deferred<void>();
  const prober: AgentProber = async (command, signal) => {
    if (command !== "claude") return { available: false };
    assert.ok(signal);
    probeEntered.resolve(signal);
    await Promise.race([
      releaseProbe.promise,
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    ]);
    return { available: false };
  };
  const server = createApp({
    store,
    dataDir: mkdtempSync(join(tmpdir(), "dezin-agents-shutdown-abort-")),
    agentProber: prober,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const request = fetch(`http://127.0.0.1:${port}/api/agents`).catch(() => undefined);
  const readinessSignal = await probeEntered.promise;

  const shuttingDown = shutdownDaemon({
    server,
    runtimeSupervisor: {
      shutdown: async () => true,
    } as unknown as RuntimeSupervisor,
    closeStore: () => store.close(),
    timeoutMs: 250,
  });
  const cancelled = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (readinessSignal.aborted) {
        resolve(true);
        return;
      }
      readinessSignal.addEventListener("abort", () => resolve(true), { once: true });
    }),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  releaseProbe.resolve();
  await request;
  await shuttingDown;

  assert.equal(cancelled, true);
});

test("GET /api/agents reports availability via the injected prober", async () => {
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "dezin-agents-")), agentProber: onlyClaude });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    assert.equal(res.status, 200);
    const agents = (await res.json()) as AgentInfo[];
    assert.ok(agents.length >= 3);
    const claude = agents.find((a) => a.id === "claude")!;
    assert.equal(claude.available, true);
    assert.equal(claude.version, "claude 1.2.3");
    assert.equal(agents.find((a) => a.id === "gemini")!.available, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("GET /api/agents reconciles persisted providers and refreshes stale availability before serving them", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-agents-persisted-"));
  writeFileSync(
    join(dataDir, "agents.json"),
    JSON.stringify([
      { id: "claude", command: "claude", available: true, version: "claude cached", models: ["opus"] },
      { id: "aider", command: "aider", available: true, version: "aider cached", models: [] },
    ]),
  );
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir, agentProber: onlyClaude });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    assert.equal(res.status, 200);
    const agents = (await res.json()) as AgentInfo[];

    assert.equal(agents.some((a) => a.id === "aider"), false);
    assert.ok(agents.some((a) => a.id === "kimi"));
    assert.ok(agents.some((a) => a.id === "trae"));
    assert.ok(agents.some((a) => a.id === "pi"));
    assert.ok(agents.some((a) => a.id === "hermes"));
    assert.equal(agents.find((a) => a.id === "claude")?.version, "claude 1.2.3");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("GET /api/agents fails a legacy signed-in CodeBuddy cache closed until live readiness succeeds", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-agents-codebuddy-auth-"));
  writeFileSync(
    join(dataDir, "agents.json"),
    JSON.stringify([
      { id: "codebuddy", command: "codebuddy", available: true, version: "2.113.0", models: ["gpt-5.5"] },
    ]),
  );
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir, agentProber: onlyCodeBuddyWithoutAuth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    assert.equal(res.status, 200);
    const agents = (await res.json()) as AgentInfo[];
    const codebuddy = agents.find((agent) => agent.id === "codebuddy")!;

    assert.equal(codebuddy.version, "2.126.0");
    assert.equal(codebuddy.available, false);
    assert.equal(codebuddy.availability, "authentication-required");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
