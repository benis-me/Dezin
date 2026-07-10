import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDevServer, ensureProjectPickerBridge, gitDiscardChanges, gitRestoreTree, getSetup, releaseProjectRuntime, setupImportedStandardProject, stopAllDevServers, templateDir } from "../src/project-runtime.ts";

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

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
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
    assert.match(updated, /sync-scroll/);
    assert.match(updated, /type:'scroll'/);
    assert.match(updated, /__dezinScrollSync/);
    assert.match(updated, /installPicker=!window\.__dezinSelect/);
    assert.doesNotMatch(updated, /if\(window\.__dezinSelect\)return/);
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

test("ensureDevServer installs missing dependencies before launching", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-runtime-install-"));
  const depDir = join(root, "local-dep");
  const dir = join(root, "project");
  const postinstallMarker = join(dir, "postinstall-ran.txt");
  mkdirSync(depDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "dezin-local-dep", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(depDir, "index.js"), `export const marker = "dependency-ready";\n`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { dev: "node server.mjs", postinstall: "node postinstall.mjs" },
      dependencies: { "dezin-local-dep": "file:../local-dep" },
    }),
  );
  writeFileSync(join(dir, "postinstall.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(postinstallMarker)}, "ran");\n`);
  writeFileSync(
    join(dir, "server.mjs"),
    `
import http from "node:http";
import { marker } from "dezin-local-dep";
const portArg = process.argv[process.argv.indexOf("--port") + 1];
const port = Number(portArg);
const server = http.createServer((_req, res) => res.end(marker));
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`,
  );

  try {
    assert.equal(existsSync(join(dir, "node_modules")), false);
    const { url } = await ensureDevServer("install-test", dir, "runtime-install-test");
    assert.equal(existsSync(join(dir, "node_modules", "dezin-local-dep")), true);
    assert.equal(existsSync(postinstallMarker), false);
    assert.equal(await waitForText(url), "dependency-ready");
  } finally {
    stopAllDevServers();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureDevServer restarts when a cached git worktree moves to another commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-runtime-git-"));
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
import { readFileSync } from "node:fs";
const portArg = process.argv[process.argv.indexOf("--port") + 1];
const port = Number(portArg);
const body = readFileSync("version.txt", "utf8");
const server = http.createServer((_req, res) => res.end(body));
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`,
  );

  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "version.txt"), "first");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "first"], { cwd: dir });

    const first = await ensureDevServer("git-runtime-test", dir, "runtime-git-test");
    assert.equal(await waitForText(first.url), "first");

    writeFileSync(join(dir, "version.txt"), "second");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "second"], { cwd: dir });

    const second = await ensureDevServer("git-runtime-test", dir, "runtime-git-test");
    assert.equal(await waitForText(second.url), "second");
  } finally {
    stopAllDevServers();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setupImportedStandardProject installs without running imported package scripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-imported-standard-"));
  const marker = join(dir, "postinstall-ran.txt");
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: { postinstall: "node postinstall.mjs" },
      }),
    );
    writeFileSync(join(dir, "postinstall.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);

    await setupImportedStandardProject("import-postinstall-test", dir);

    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseProjectRuntime invalidates and awaits an in-flight setup generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-runtime-release-"));
  const binDir = join(root, "bin");
  const dir = join(root, "project");
  const entered = join(root, "npm-entered.txt");
  const late = join(dir, "late-from-npm.txt");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "release-race", version: "1.0.0" }));
  writeFileSync(
    join(binDir, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(entered)}, "entered");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(late)}, "late");
  setTimeout(() => process.exit(0), 25);
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  let setupFinished = false;
  try {
    const setup = setupImportedStandardProject("release-generation", dir).then(() => {
      setupFinished = true;
    });
    await waitForFile(entered);

    await releaseProjectRuntime("release-generation");

    assert.equal(setupFinished, true, "release waits through the setup continuation after child exit");
    await setup;
    const commits = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(commits, "1", "released setup never resumes into a post-release commit");
    assert.equal(getSetup("release-generation", dir).phase, "installing", "the released runtime generation is absent");
  } finally {
    process.env.PATH = originalPath;
    stopAllDevServers();
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitDiscardChanges reverts the working tree to HEAD but preserves .research", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-discard-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "App.jsx"), "v1");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });

    // A cancelled run's leftovers: a modified tracked file, a new untracked file, and a Dezin-internal
    // .research dir (untracked) that must survive the discard.
    writeFileSync(join(dir, "src", "App.jsx"), "v2-half-written");
    writeFileSync(join(dir, "src", "New.jsx"), "leftover");
    mkdirSync(join(dir, ".research"), { recursive: true });
    writeFileSync(join(dir, ".research", "research.md"), "keep me");
    // A Sharingan capture bundle (untracked) must also survive a failed build's discard, so a retry
    // can reuse it instead of re-capturing.
    mkdirSync(join(dir, ".sharingan"), { recursive: true });
    writeFileSync(join(dir, ".sharingan", "pages.json"), "{}");

    await gitDiscardChanges(dir);

    assert.equal(readFileSync(join(dir, "src", "App.jsx"), "utf8"), "v1", "tracked edit reverted to HEAD");
    assert.equal(existsSync(join(dir, "src", "New.jsx")), false, "untracked leftover removed");
    assert.equal(readFileSync(join(dir, ".research", "research.md"), "utf8"), "keep me", ".research preserved");
    assert.equal(existsSync(join(dir, ".sharingan", "pages.json")), true, ".sharingan capture preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitRestoreTree restores a tree exactly, including removing a file renamed-in after the target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grt-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    git(["config", "diff.renames", "true"]); // git's default in many envs — the bug only bites when rename detection is ON
    writeFileSync(join(dir, "Hero.tsx"), "export const Hero = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "round0"]);
    const round0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    // Round 1 (the worse, last round): pure rename Hero.tsx -> HeroSection.tsx (identical content →
    // git detects R100, which --diff-filter=A misses unless --no-renames is passed).
    rmSync(join(dir, "Hero.tsx"));
    writeFileSync(join(dir, "HeroSection.tsx"), "export const Hero = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "round1"]);
    // Restore the best-scoring round (round0). The rename must not leave HeroSection.tsx behind.
    const res = await gitRestoreTree(dir, round0, "Best-scoring version");
    assert.ok(res.committed, "committed a restore");
    assert.ok(existsSync(join(dir, "Hero.tsx")), "Hero.tsx restored");
    assert.ok(!existsSync(join(dir, "HeroSection.tsx")), "the renamed-in file was removed");
    const diff = execFileSync("git", ["diff", "--name-only", round0, "HEAD"], { cwd: dir }).toString().trim();
    assert.equal(diff, "", "restored tree byte-matches the target commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
