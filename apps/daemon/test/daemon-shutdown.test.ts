import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { shutdownDaemon } from "../src/daemon-shutdown.ts";

test("daemon shutdown shares one deadline across a stuck SSE connection and hung resource hook", async () => {
  const store = new Store(":memory:");
  let resourceHookEntered = false;
  const supervisor = new RuntimeSupervisor({
    dataDir: "/tmp/dezin-shutdown-deadline",
    store,
    shutdownResources: () => {
      resourceHookEntered = true;
      return new Promise<void>(() => {});
    },
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("data: connected\n\n");
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sse = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(`${base}/events`, resolve);
    request.on("error", reject);
  });
  sse.resume();
  let sseClosed = false;
  sse.on("close", () => { sseClosed = true; });

  let storeClosed = false;
  const startedAt = Date.now();
  const shuttingDown = shutdownDaemon({
    server,
    runtimeSupervisor: supervisor,
    timeoutMs: 40,
    closeStore: () => {
      storeClosed = true;
      store.close();
    },
  });

  await assert.rejects(fetch(`${base}/health`), "server.close starts before shutdown waits");
  const result = await Promise.race([
    shuttingDown,
    new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 500)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.notEqual(result, "test-timeout", "shutdown is bounded even when both layers are stuck");
  assert.equal(result, false, "the timeout is reported to the caller");
  assert.equal(resourceHookEntered, true, "resource cleanup is attempted within the same deadline");
  assert.equal(storeClosed, true, "Store.close runs from the shutdown finally block");
  assert.equal(sseClosed, true, "closeAllConnections tears down the stuck SSE response");
  assert.ok(Date.now() - startedAt < 400, "the single deadline bounds the full shutdown path");
});
