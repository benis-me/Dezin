const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const DEFAULT_WINDOW_STATE = Object.freeze({ width: 1440, height: 920 });
const MIN_WINDOW_STATE = Object.freeze({ width: 920, height: 600 });

function normalizeWindowState(value) {
  if (!value || typeof value !== "object") return DEFAULT_WINDOW_STATE;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return DEFAULT_WINDOW_STATE;
  return {
    width: Math.max(MIN_WINDOW_STATE.width, Math.round(width)),
    height: Math.max(MIN_WINDOW_STATE.height, Math.round(height)),
  };
}

function readWindowState(file) {
  if (!existsSync(file)) return DEFAULT_WINDOW_STATE;
  try {
    return normalizeWindowState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

function writeWindowState(file, bounds) {
  const state = normalizeWindowState(bounds);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

module.exports = {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_STATE,
  normalizeWindowState,
  readWindowState,
  writeWindowState,
};
