import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDevServer, ensureProjectPickerBridge, stopAllDevServers, templateDir } from "../src/project-runtime.ts";

async function waitForPortDown(url: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(200) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test dev server port stayed open");
}

async function waitForText(url: string): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return await (await fetch(url, { signal: AbortSignal.timeout(500) })).text();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("test dev server never responded");
}

test("ensureProjectPickerBridge updates only the copied Dezin picker bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-runtime-bridge-"));
  try {
    writeFileSync(
      join(dir, "vite.config.js"),
      `import { defineConfig } from "vite";
const PICKER_BRIDGE = \`<script data-dezin-bridge>old bridge without attrs</script>\`;
export default defineConfig({ server: { host: "127.0.0.1" } });
`,
    );

    assert.equal(await ensureProjectPickerBridge(dir), true);
    const updated = readFileSync(join(dir, "vite.config.js"), "utf8");
    assert.match(updated, /attrs:attrs\(el\)/);
    assert.match(updated, /gridTemplateColumns:s\.gridTemplateColumns/);
    assert.match(updated, /focus-target/);
    assert.match(updated, /selectedBox/);
    assert.match(updated, /#f97316/);
    assert.match(updated, /server: \{ host: "127\.0\.0\.1" \}/);
    assert.doesNotMatch(updated, /old bridge without attrs/);
    assert.doesNotMatch(updated, /\\\\const PICKER_BRIDGE/);
    assert.equal(await ensureProjectPickerBridge(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureProjectPickerBridge repairs a bridge corrupted by replacement tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-runtime-bridge-corrupt-"));
  try {
    const template = readFileSync(join(templateDir(), "vite.config.js"), "utf8");
    const originalSnippet = "v.replace(/[^a-zA-Z0-9_-]/g,'\\\\\\\\$&');";
    const corruptedSnippet =
      "v.replace(/[^a-zA-Z0-9_-]/g,'\\\\\\\\const PICKER_BRIDGE = `<script data-dezin-bridge>old bridge without attrs</script>`;');";
    assert.match(template, /attrs:attrs\(el\)/);
    assert.match(template, /selectedBox/);
    assert.ok(template.includes(originalSnippet));
    writeFileSync(join(dir, "vite.config.js"), template.replace(originalSnippet, corruptedSnippet));

    assert.equal(await ensureProjectPickerBridge(dir), true);
    const updated = readFileSync(join(dir, "vite.config.js"), "utf8");
    assert.equal(updated, template);
    assert.equal(await ensureProjectPickerBridge(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDevServer restarts a cached dev process whose port stopped responding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-runtime-"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { dev: "node server.mjs" },
    }),
  );
  writeFileSync(
    join(dir, "server.mjs"),
    `
import http from "node:http";
const portArg = process.argv[process.argv.indexOf("--port") + 1];
const port = Number(portArg);
const sockets = new Set();
const server = http.createServer((req, res) => {
  if (req.url === "/__close") {
    res.end("closing", () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    });
    return;
  }
  res.end(String(process.pid));
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`,
  );

  try {
    const first = await ensureDevServer("p1", dir, "runtime-test");
    const firstPid = await waitForText(first.url);

    await fetch(new URL("/__close", first.url));
    await waitForPortDown(first.url);

    const second = await ensureDevServer("p1", dir, "runtime-test");
    assert.notEqual(await waitForText(second.url), firstPid);
  } finally {
    stopAllDevServers();
    rmSync(dir, { recursive: true, force: true });
  }
});
