import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { createRuntimeSupervisor } from "../src/app.ts";
import { ensureDevServer } from "../src/project-runtime.ts";
import { ensureProbeSession, closeAllSharinganSessions } from "../src/sharingan-handler.ts";

async function waitForPortDown(url: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(200) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("preview child remained reachable after runtime shutdown");
}

test("closeAllSharinganSessions closes every live session in the capture registry", async () => {
  const id = "shutdown-guard";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-shutdown-"));
  let closed = 0;
  const fake = { close: async () => { closed += 1; } } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  const open = async () => fake;

  // Open a probe session (phase -> "probing", c.session live, c.probeTimer armed).
  await ensureProbeSession(id, dataDir, open);
  assert.equal(closed, 0);

  await closeAllSharinganSessions();
  assert.equal(closed, 1, "shutdown must close every live session in the capture registry");
});

test("production shutdown waits for Runs before closing preview and Sharingan children", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-shutdown-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Shutdown", mode: "standard" });
  const variant = store.ensureMainVariant(project.id);
  const projectPath = join(dataDir, "projects", project.id);
  mkdirSync(join(projectPath, "node_modules"), { recursive: true });
  writeFileSync(join(projectPath, "package.json"), JSON.stringify({ type: "module", scripts: { dev: "node server.mjs" } }));
  writeFileSync(
    join(projectPath, "server.mjs"),
    `import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((_req, res) => res.end("alive")).listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`,
  );
  let sharinganClosed = 0;
  await ensureProbeSession(
    project.id,
    dataDir,
    async () => ({ close: async () => { sharinganClosed += 1; } }) as unknown as import("../src/sharingan-browser.ts").SharinganSession,
  );
  const preview = await ensureDevServer(project.id, projectPath, `${project.id}:${variant.id}`);
  assert.equal(await (await fetch(preview.url)).text(), "alive");
  const supervisor = createRuntimeSupervisor({ dataDir, store });
  const controller = new AbortController();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  supervisor.registerRun({
    projectId: project.id,
    variantId: variant.id,
    runId: "shutdown-run",
    controller,
    settled,
  });

  let shutdownFinished = false;
  const shuttingDown = supervisor.shutdown().then((allSettled) => {
    shutdownFinished = true;
    return allSettled;
  });
  assert.equal(controller.signal.aborted, true);
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  assert.equal(sharinganClosed, 0, "children remain owned until Run settlement");
  assert.ok(store.getProject(project.id), "Store remains open while runtime settlement is pending");
  assert.equal(await (await fetch(preview.url)).text(), "alive");

  settle();
  assert.equal(await shuttingDown, true);
  assert.equal(sharinganClosed, 1);
  await waitForPortDown(preview.url);
  assert.equal(existsSync(projectPath), true, "shutdown releases children without deleting project data");

  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
