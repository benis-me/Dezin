const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

function readLastDirectory(stateFile, fallbackPath) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    if (typeof parsed.lastDirectory === "string" && parsed.lastDirectory.trim()) return parsed.lastDirectory;
  } catch {
    // Missing or invalid state falls back to the user's Documents directory.
  }
  return fallbackPath;
}

function createDialogPathState({ stateFile, fallbackPath }) {
  let lastDirectory = readLastDirectory(stateFile, fallbackPath);

  function rememberSelection(result, { directory = false } = {}) {
    if (result?.canceled || !Array.isArray(result?.filePaths)) return;
    const selectedPath = result.filePaths.find((path) => typeof path === "string" && path.trim());
    if (!selectedPath) return;

    lastDirectory = directory ? selectedPath : dirname(selectedPath);
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, `${JSON.stringify({ lastDirectory })}\n`, "utf8");
    } catch {
      // Keep the in-memory path useful even if persistence is unavailable.
    }
  }

  return {
    defaultPath: () => lastDirectory,
    rememberSelection,
  };
}

module.exports = { createDialogPathState };
