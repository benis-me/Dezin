const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_WINDOW_STATE, MIN_WINDOW_STATE, readWindowState, writeWindowState } = require("../window-state.js");

test("window state falls back to the default size when nothing valid is persisted", () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-window-state-"));
  try {
    const file = join(dir, "window-state.json");
    assert.deepEqual(readWindowState(file), DEFAULT_WINDOW_STATE);

    writeFileSync(file, "{not json");
    assert.deepEqual(readWindowState(file), DEFAULT_WINDOW_STATE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("window state persists only a sane app window size", () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-window-state-"));
  try {
    const file = join(dir, "nested", "window-state.json");
    writeWindowState(file, { width: 1180.4, height: 760.6, x: 20, y: 30 });

    assert.deepEqual(readWindowState(file), { width: 1180, height: 761 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { width: 1180, height: 761 });

    writeWindowState(file, { width: 200, height: 120 });
    assert.deepEqual(readWindowState(file), MIN_WINDOW_STATE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
