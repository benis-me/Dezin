const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { isAllowedAppNavigation, isSafeExternalUrl } = require("../navigation-policy.js");

test("external URLs are limited to http and https", () => {
  assert.equal(isSafeExternalUrl("https://example.com/docs"), true);
  assert.equal(isSafeExternalUrl("http://example.com/docs"), true);

  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("file:///Users/ben/.ssh/id_rsa"), false);
  assert.equal(isSafeExternalUrl("mailto:hello@example.com"), false);
  assert.equal(isSafeExternalUrl("not a url"), false);
});

test("app navigation stays on the loaded app origin", () => {
  const appUrl = "http://127.0.0.1:7457/";

  assert.equal(isAllowedAppNavigation("http://127.0.0.1:7457/projects/p1", appUrl), true);
  assert.equal(isAllowedAppNavigation("http://127.0.0.1:5173/projects/p1", appUrl), false);
  assert.equal(isAllowedAppNavigation("https://example.com", appUrl), false);
  assert.equal(isAllowedAppNavigation("file:///tmp/preview.html", appUrl), false);
  assert.equal(isAllowedAppNavigation("not a url", appUrl), false);
});

test("desktop renderer keeps isolation and enables the Chromium sandbox", () => {
  const mainSource = readFileSync(join(__dirname, "..", "main.js"), "utf8");

  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /sandbox:\s*true/);
  assert.doesNotMatch(mainSource, /sandbox:\s*false/);
});

test("window creation delegates daemon startup to one application supervisor", () => {
  const mainSource = readFileSync(join(__dirname, "..", "main.js"), "utf8");
  const createWindowSource = mainSource.match(/async function createWindow\(\)[\s\S]*?\n}\n\nfunction buildMenu/)?.[0] ?? "";

  assert.equal((mainSource.match(/createDaemonSupervisor\s*\(/g) ?? []).length, 1);
  assert.match(createWindowSource, /daemonSupervisor\.ensureStarted\(\)/);
  assert.doesNotMatch(createWindowSource, /\bspawn\s*\(/);
});

test("window loading guards its retry and handles asynchronous launch failures", () => {
  const mainSource = readFileSync(join(__dirname, "..", "main.js"), "utf8");

  assert.match(mainSource, /shouldRetry:\s*\(\)\s*=>\s*!window\.isDestroyed\(\)/);
  assert.match(mainSource, /void createWindow\(\)\.catch\(/);
});

test("desktop shutdown targets the daemon process group on every platform", () => {
  const mainSource = readFileSync(join(__dirname, "..", "main.js"), "utf8");

  assert.match(mainSource, /process\.kill\(-pid,\s*"SIGTERM"\)/);
  assert.match(mainSource, /spawnSync\("taskkill",\s*\["\/pid",\s*String\(pid\),\s*"\/t",\s*"\/f"\]/);
});
