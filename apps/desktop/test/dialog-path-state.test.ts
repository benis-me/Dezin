const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createDialogPathState } = require("../dialog-path-state.js");

test("dialog path state loads a persisted directory and falls back to Documents", () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-dialog-path-"));
  try {
    const stateFile = join(dir, "user-data", "dialog-path.json");
    const documentsPath = join(dir, "Documents");
    const picturesPath = join(dir, "Pictures");

    assert.equal(createDialogPathState({ stateFile, fallbackPath: documentsPath }).defaultPath(), documentsPath);

    mkdirSync(join(dir, "user-data"), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify({ lastDirectory: picturesPath })}\n`, "utf8");
    assert.equal(createDialogPathState({ stateFile, fallbackPath: documentsPath }).defaultPath(), picturesPath);

    writeFileSync(stateFile, "{not json", "utf8");
    assert.equal(createDialogPathState({ stateFile, fallbackPath: documentsPath }).defaultPath(), documentsPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful file and folder selections persist their useful directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-dialog-path-"));
  try {
    const stateFile = join(dir, "user-data", "dialog-path.json");
    const state = createDialogPathState({ stateFile, fallbackPath: join(dir, "Documents") });
    const assetFile = join(dir, "assets", "cover.png");
    const projectsFolder = join(dir, "projects");

    state.rememberSelection({ canceled: false, filePaths: [assetFile] }, { directory: false });
    assert.equal(state.defaultPath(), join(dir, "assets"));
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { lastDirectory: join(dir, "assets") });

    state.rememberSelection({ canceled: false, filePaths: [projectsFolder] }, { directory: true });
    assert.equal(state.defaultPath(), projectsFolder);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { lastDirectory: projectsFolder });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelled dialog selections do not update or persist path state", () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-dialog-path-"));
  try {
    const stateFile = join(dir, "user-data", "dialog-path.json");
    const documentsPath = join(dir, "Documents");
    const state = createDialogPathState({ stateFile, fallbackPath: documentsPath });

    state.rememberSelection({ canceled: true, filePaths: [join(dir, "ignored")] }, { directory: true });

    assert.equal(state.defaultPath(), documentsPath);
    assert.equal(existsSync(stateFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
