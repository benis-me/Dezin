import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../../../packages/core/src/index.ts";
import type { AgentRunner } from "../../../packages/agent/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { trustedDesignPreviewOrigin } from "../src/design/design-http-handler.ts";
import { findDesignExportChrome } from "../src/design/design-export-visual-gate.ts";
import { publishDesignVersion } from "../src/design/design-storage.ts";

interface AbortGate {
  entered: Promise<void>;
  aborted: Promise<void>;
  release(): void;
}

function abortGateRunner(): { runner: AgentRunner; gate: AbortGate } {
  let enter!: () => void;
  let observeAbort!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const aborted = new Promise<void>((resolve) => { observeAbort = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const runner: AgentRunner = {
    id: "http-design-lifecycle-gate",
    async runTurn(input) {
      const signal = input.signal;
      if (!signal) throw new Error("Lifecycle fixture requires an AbortSignal");
      enter();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      observeAbort();
      await released;
      throw signal.reason ?? new DOMException("Design execution cancelled", "AbortError");
    },
  };
  return { runner, gate: { entered, aborted, release } };
}

test("Design Export source origin is derived from the accepted socket instead of Host", () => {
  assert.equal(
    trustedDesignPreviewOrigin({ localAddress: "::ffff:127.0.0.1", localPort: 4321 }),
    "http://127.0.0.1:4321",
  );
  assert.equal(
    trustedDesignPreviewOrigin({ localAddress: "::1", localPort: 4321 }),
    "http://[::1]:4321",
  );
  assert.equal(
    trustedDesignPreviewOrigin({ localAddress: "0.0.0.0", localPort: 4321 }),
    "http://127.0.0.1:4321",
  );
  assert.throws(() => trustedDesignPreviewOrigin({ localAddress: undefined, localPort: 4321 }), /socket/i);
});

test("ordinary Project creation initializes an empty Design canvas without scaffolding Vite", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Blank Design" }),
    });
    assert.equal(response.status, 201);
    const project = await response.json() as { id: string };
    assert.equal(store.getProject(project.id), null);
    const root = join(dataDir, "projects", project.id);
    const metadata = JSON.parse(await readFile(join(root, "design", "metadata.json"), "utf8"));
    assert.equal(metadata.projectId, project.id);
    assert.equal(metadata.name, "Blank Design");
    const designProject = JSON.parse(await readFile(join(root, "design", "project.json"), "utf8"));
    assert.equal(designProject.projectId, project.id);
    assert.deepEqual(designProject.nodes, []);
    await assert.rejects(readFile(join(root, "package.json")));
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Project deletion aborts and awaits detached Node, Main, and Export executions", async (t) => {
  for (const executionKind of ["node", "main", "export"] as const) {
    await t.test(executionKind, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `dezin-design-delete-${executionKind}-`));
      const store = new Store(":memory:");
      const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
      const { runner, gate } = abortGateRunner();
      const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        const created = await json("/api/projects", "POST", { name: `${executionKind} deletion` });
        assert.equal(created.status, 201, await created.clone().text());
        const project = await created.json() as { id: string };
        const projectPath = join(dataDir, "projects", project.id);
        const canvasRoot = `/api/projects/${project.id}/design-canvas`;

        if (executionKind !== "main") {
          const added = await json(canvasRoot, "PUT", {
            expectedRevision: 0,
            intents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } }],
          });
          assert.equal(added.status, 200, await added.clone().text());
        }
        if (executionKind === "export") {
          await publishDesignVersion(dataDir, project.id, {
            nodeId: "node-page",
            html: "<!doctype html><html><head><style>body{margin:0}</style></head><body><main>Ready</main></body></html>",
            contextHash: "a".repeat(64),
            canvasRevision: 1,
            expectedHeadVersionId: null,
            jobId: null,
            runnerId: "fixture",
            model: null,
          });
        }

        const currentCanvas = await (await json(canvasRoot)).json() as { revision: number };
        const startPath = executionKind === "node"
          ? `${canvasRoot}/nodes/node-page/agent/turns`
          : executionKind === "main"
            ? `${canvasRoot}/agent/turns`
            : `${canvasRoot}/exports`;
        const startBody = executionKind === "export"
          ? { canvasRevision: currentCanvas.revision }
          : { message: `Keep ${executionKind} active` };
        const started = await json(startPath, "POST", startBody);
        assert.equal(started.status, 202, await started.clone().text());
        await gate.entered;

        let deletionSettled = false;
        const deleting = json(`/api/projects/${project.id}`, "DELETE").then((response) => {
          deletionSettled = true;
          return response;
        });
        await gate.aborted;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(deletionSettled, false, "deletion must await the aborted execution's actual settlement");
        assert.equal((await readFile(join(projectPath, "design", "metadata.json"), "utf8")).length > 0, true);

        gate.release();
        let deletionTimer: NodeJS.Timeout | undefined;
        const deleted = await Promise.race([
          deleting,
          new Promise<never>((_resolve, reject) => {
            deletionTimer = setTimeout(() => reject(new Error("Project deletion did not drain")), 2_000);
          }),
        ]).finally(() => clearTimeout(deletionTimer));
        assert.equal(deleted.status, 204, await deleted.clone().text());
        await assert.rejects(readFile(join(projectPath, "design", "metadata.json")), { code: "ENOENT" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
      } finally {
        gate.release();
        process.off("unhandledRejection", onUnhandled);
        await runtimeSupervisor.shutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("Design Export HTTP publishes only after the real desktop and mobile visual gate", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Design Export visual gate");
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-export-visual-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const sourceHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{background:#f6f1e8;color:#17202a;font-family:Arial,sans-serif}*{box-sizing:border-box}
    body{margin:0}.page{min-height:100vh;display:grid;place-items:center;padding:48px}h1{margin:0;max-width:9ch;font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.07em}
  </style></head><body><main class="page" data-dezin-export-node-id="node-page"><h1>Socket-bound visual export</h1></main></body></html>`;
  const runner: AgentRunner = {
    id: "http-export-visual-fixture",
    async runTurn(input) {
      const packageJson = {
        name: "dezin-http-visual-export",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        devDependencies: { typescript: "^6.0.3", vite: "^8.0.16" },
      };
      const index = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>";
      const main = `import "./styles.css";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");
const nodeId = new URLSearchParams(window.location.search).get("dezin-node");
if (nodeId !== "node-page") throw new Error("Unknown Design Node route");
const page = document.createElement("main");
page.className = "page";
page.dataset.dezinExportNodeId = "node-page";
const heading = document.createElement("h1");
heading.textContent = "Socket-bound visual export";
page.append(heading);
app.append(page);
`;
      const styles = `:root{background:#f6f1e8;color:#17202a;font-family:Arial,sans-serif}*{box-sizing:border-box}
body{margin:0}.page{min-height:100vh;display:grid;place-items:center;padding:48px}h1{margin:0;max-width:9ch;font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.07em}
`;
      await mkdir(join(input.projectDir, "src"), { recursive: true });
      await Promise.all([
        writeFile(join(input.projectDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
        writeFile(join(input.projectDir, "index.html"), index),
        writeFile(join(input.projectDir, "src", "main.ts"), main),
        writeFile(join(input.projectDir, "src", "styles.css"), styles),
      ]);
      return { text: "Exact fresh implementation", artifactHtml: index, artifactPath: "index.html" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const created = await json("/api/projects", "POST", { name: "Real visual export" });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const added = await json(root, "PUT", {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } }],
    });
    assert.equal(added.status, 200, await added.clone().text());
    await publishDesignVersion(dataDir, project.id, {
      nodeId: "node-page",
      html: sourceHtml,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const canvas = await (await json(root)).json() as { revision: number };
    const startedResponse = await json(`${root}/exports`, "POST", { canvasRevision: canvas.revision }, {
      host: "attacker.invalid:9",
    });
    assert.equal(startedResponse.status, 202, await startedResponse.clone().text());
    const started = await startedResponse.json() as { exportId: string; job: { id: string } };
    const deadline = Date.now() + 20_000;
    let terminal: { status: string; error: string | null; activity: Array<{ kind: string; text: string }> } | undefined;
    while (Date.now() < deadline) {
      const jobs = await (await json(`${root}/jobs`)).json() as Array<{ id: string; status: string; error: string | null; activity: Array<{ kind: string; text: string }> }>;
      terminal = jobs.find((job) => job.id === started.job.id);
      if (terminal && !["queued", "running", "validating"].includes(terminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(terminal?.status, "ready", terminal?.error ?? "visual Export did not finish");
    const finalDir = join(dataDir, "projects", project.id, "design", "exports", started.exportId);
    const manifest = JSON.parse(await readFile(join(finalDir, "dezin-export.json"), "utf8"));
    assert.equal(manifest.visualValidation.passed, true);
    assert.equal(manifest.visualValidation.caseCount, 2);
    assert.ok(terminal?.activity.some((entry) => entry.kind === "status" && /Visual gate passed 2.*receipt [a-f0-9]{64}/.test(entry.text)));
    const receiptBytes = await readFile(join(finalDir, manifest.visualValidation.receiptPath));
    assert.equal(createHash("sha256").update(receiptBytes).digest("hex"), manifest.visualValidation.receiptChecksum);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      projectId: string;
      exportId: string;
      canvasRevision: number;
      thresholds: Record<string, number>;
      cases: Array<{
        nodeId: string;
        viewport: { name: string };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
    };
    assert.equal(receipt.projectId, project.id);
    assert.equal(receipt.exportId, started.exportId);
    assert.equal(receipt.canvasRevision, canvas.revision);
    assert.deepEqual(receipt.thresholds, {
      meanAbsoluteError: 0.04,
      changedPixelRatio: 0.12,
      meanSsim: 0.95,
      p05Ssim: 0.6,
      minimumSsim: 0.5,
    });
    assert.deepEqual(receipt.cases.map((entry) => [entry.nodeId, entry.viewport.name]), [
      ["node-page", "desktop"],
      ["node-page", "mobile"],
    ]);
    const outputs = new Map((manifest.outputFiles as Array<{ path: string; checksum: string; bytes: number }>)
      .map((file) => [file.path, file]));
    assert.equal(outputs.get(manifest.visualValidation.receiptPath)?.checksum, manifest.visualValidation.receiptChecksum);
    for (const visualCase of receipt.cases) {
      for (const evidence of Object.values(visualCase.evidence)) {
        const bytes = await readFile(join(finalDir, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.checksum);
        assert.deepEqual(outputs.get(evidence.path), evidence);
      }
    }
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design Asset batch import commits one Canvas revision and rolls back the whole invalid request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-import-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({ dataDir, store, runtimeSupervisor });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  try {
    const created = await json("/api/projects", "POST", { name: "Atomic import" });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const png = (label: string) => Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(label),
    ]).toString("base64");
    const item = (id: string, name: string, base64: string, x: number) => ({
      asset: { name, mimeType: "image/png", base64 },
      node: { id, kind: "image", name, geometry: { x, y: 24, width: 360, height: 260 } },
    });

    const invalid = await json(`${root}/assets/import`, "POST", {
      expectedRevision: 0,
      items: [
        item("node-one", "one.png", png("one"), 24),
        item("node-bad", "bad.png", "not-canonical-base64", 408),
      ],
    });
    assert.equal(invalid.status, 400, await invalid.clone().text());
    const afterFailure = await (await json(root)).json() as { revision: number; nodes: unknown[] };
    assert.equal(afterFailure.revision, 0);
    assert.deepEqual(afterFailure.nodes, []);
    assert.deepEqual(await (await json(`${root}/assets`)).json(), []);

    const imported = await json(`${root}/assets/import`, "POST", {
      expectedRevision: 0,
      items: [
        item("node-one", "one.png", png("one"), 24),
        item("node-two", "two.png", png("two"), 408),
      ],
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    const canvas = await imported.json() as {
      revision: number;
      undoDepth: number;
      nodeOrder: string[];
      nodes: Array<{ id: string; assetId: string | null; state: string }>;
    };
    assert.equal(canvas.revision, 1);
    assert.equal(canvas.undoDepth, 1);
    assert.deepEqual(canvas.nodeOrder, ["node-one", "node-two"]);
    assert.ok(canvas.nodes.every((node) => node.assetId !== null && node.state === "ready"));
    const assets = await (await json(`${root}/assets`)).json() as Array<{ id: string }>;
    assert.equal(assets.length, 2);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design Canvas HTTP supports CAS, exact preview pins, safe Asset delivery, and Node Agent Jobs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-http-slice-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const runner: AgentRunner = {
    id: "http-writing-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head><style>body{margin:0}</style></head><body>HTTP generated</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "Published through HTTP.", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  const server = createApp({ dataDir, store, runtimeSupervisor, designRunner: runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const json = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  try {
    const createdResponse = await json("/api/projects", "POST", { name: "HTTP canvas" });
    assert.equal(createdResponse.status, 201);
    const project = await createdResponse.json() as { id: string };
    const root = `/api/projects/${project.id}/design-canvas`;
    const initial = await (await json(root)).json() as { revision: number };
    assert.equal(initial.revision, 0);

    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("rangeable-image"),
    ]);
    const assetResponse = await json(`${root}/assets`, "POST", {
      name: "hero.png",
      mimeType: "image/png",
      base64: imageBytes.toString("base64"),
    });
    assert.equal(assetResponse.status, 201);
    const asset = await assetResponse.json() as { id: string; checksum: string; fileName: string };
    const mutatedResponse = await json(root, "PUT", {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-image", kind: "image", assetId: asset.id } },
        { type: "add-node", node: { id: "node-page", kind: "page" } },
      ],
    });
    assert.equal(mutatedResponse.status, 200);
    assert.equal((await json(root, "PUT", { expectedRevision: 0, intents: [{ type: "set-viewport", viewport: { x: 0, y: 0, zoom: 1 } }] })).status, 409);
    assert.equal((await json(`${root}/agent/turns`, "POST", { message: "Arrange", unexpected: true })).status, 400);
    assert.equal((await json(`${root}/exports`, "POST", { canvasRevision: 1 })).status, 409);
    assert.equal((await json(`${root}/nodes/node-page/agent/turns`, "POST", { prompt: "retired alias" })).status, 400);

    const ranged = await fetch(`${base}${root}/assets/${asset.id}/content`, { headers: { range: "bytes=2-7" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("accept-ranges"), "bytes");
    assert.equal(ranged.headers.get("content-range"), `bytes 2-7/${imageBytes.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), imageBytes.subarray(2, 8));
    const headed = await fetch(`${base}${root}/assets/${asset.id}/content`, { method: "HEAD", headers: { range: "bytes=0-3" } });
    assert.equal(headed.status, 206);
    assert.equal(headed.headers.get("content-length"), "4");
    assert.equal((await headed.arrayBuffer()).byteLength, 0);

    const published = await publishDesignVersion(dataDir, project.id, {
      nodeId: "node-page",
      html: `<!doctype html><html><head><style>body{margin:0}</style></head><body><img src="dezin-asset://${asset.id}"></body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const preview = await fetch(`${base}${root}/nodes/node-page/versions/${published.manifest.id}/preview/`);
    assert.equal(preview.status, 200);
    const csp = preview.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "navigate-to 'none'", "sandbox allow-scripts"]) {
      assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const previewHtml = await preview.text();
    const pinnedPath = previewHtml.match(/\/api\/projects\/[^"']+checksum=[a-f0-9]{64}/)?.[0];
    assert.ok(pinnedPath);
    const pinned = await fetch(`${base}${pinnedPath}`);
    assert.equal(pinned.status, 200, await pinned.clone().text());
    assert.deepEqual(Buffer.from(await pinned.arrayBuffer()), imageBytes);
    const wrongPin = await fetch(`${base}${pinnedPath.replace(asset.checksum, "0".repeat(64))}`);
    assert.equal(wrongPin.status, 403);

    const htmlAssetResponse = await json(`${root}/assets`, "POST", {
      name: "unsafe'()\n.html",
      mimeType: "text/html",
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
    });
    assert.equal(htmlAssetResponse.status, 400);
    const safeHtmlAssetResponse = await json(`${root}/assets`, "POST", {
      name: "reference's (exact).html",
      mimeType: "text/html",
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
    });
    assert.equal(safeHtmlAssetResponse.status, 201);
    const safeHtmlAsset = await safeHtmlAssetResponse.json() as { id: string };
    const activeContent = await fetch(`${base}${root}/assets/${safeHtmlAsset.id}/content`);
    assert.match(activeContent.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(activeContent.headers.get("content-disposition") ?? "", /%27|%28|%29/);
    assert.match(activeContent.headers.get("content-security-policy") ?? "", /default-src 'none'/);

    const turn = await json(`${root}/nodes/node-page/agent/turns`, "POST", {
      message: "Generate from HTTP",
      context: { nodeIds: ["node-image"] },
      idempotencyKey: "http-node-turn",
    });
    assert.equal(turn.status, 202);
    const turnBody = await turn.json() as { job: { id: string } };
    const deadline = Date.now() + 2_000;
    let terminal: { status: string } | undefined;
    while (Date.now() < deadline) {
      const jobs = await (await json(`${root}/jobs`)).json() as Array<{ id: string; status: string }>;
      terminal = jobs.find((job) => job.id === turnBody.job.id);
      if (terminal && !["queued", "running", "validating"].includes(terminal.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(terminal?.status, "ready");
    const thread = await (await json(`${root}/nodes/node-page/agent/thread`)).json() as { messages: Array<{ role: string }> };
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);

    assert.equal((await json(`${root}/nodes/node-page/agent/turns`, "POST", { message: "ok", unknown: true })).status, 400);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
