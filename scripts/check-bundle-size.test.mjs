import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBundle } from "./check-bundle-size.mjs";

async function fixture(manifest, assets) {
  const distDir = await mkdtemp(join(tmpdir(), "dezin-bundle-"));
  await mkdir(join(distDir, ".vite"), { recursive: true });
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, ".vite", "manifest.json"), JSON.stringify(manifest));
  await Promise.all(Object.entries(assets).map(([name, body]) => writeFile(join(distDir, "assets", name), body)));
  return distDir;
}

test("bundle checker rejects an oversized initial static chunk", async () => {
  const distDir = await fixture(
    { "index.html": { file: "assets/index.js", isEntry: true } },
    { "index.js": randomBytes(501 * 1024) },
  );
  await assert.rejects(checkBundle({ distDir }), /initial chunk.*500(?:\.0)? KiB minified/i);
});

test("bundle checker rejects initial gzip and aggregate gzip regressions", async () => {
  const initialGzipDir = await fixture(
    { "index.html": { file: "assets/index.js", isEntry: true } },
    { "index.js": randomBytes(181 * 1024) },
  );
  await assert.rejects(checkBundle({ distDir: initialGzipDir }), /initial chunk.*180(?:\.0)? KiB gzip/i);

  const totalDir = await fixture(
    {
      "index.html": { file: "assets/index.js", isEntry: true, dynamicImports: ["src/screens/MoodboardScreen.tsx"] },
      "src/screens/MoodboardScreen.tsx": { file: "assets/moodboard.js", isDynamicEntry: true },
    },
    { "index.js": randomBytes(40 * 1024), "moodboard.js": randomBytes(80 * 1024) },
  );
  await assert.rejects(
    checkBundle({ distDir: totalDir, budgets: { totalJsGzipBaseline: 100 * 1024 } }),
    /total JS.*baseline \+ 5%/i,
  );
});

test("Home and Settings initial graphs cannot pull lazy editor or canvas chunks", async () => {
  const homeDistDir = await fixture(
    {
      "index.html": { file: "assets/index.js", isEntry: true, imports: ["src/screens/HomeScreen.tsx"] },
      "src/screens/HomeScreen.tsx": { file: "assets/home.js", imports: ["src/moodboard/MoodboardCanvas.tsx"] },
      "src/moodboard/MoodboardCanvas.tsx": { file: "assets/canvas.js" },
    },
    { "index.js": "export{}", "home.js": "export{}", "canvas.js": "export{}" },
  );
  await assert.rejects(checkBundle({ distDir: homeDistDir }), /HomeScreen.*MoodboardCanvas/i);

  const settingsDistDir = await fixture(
    {
      "index.html": { file: "assets/index.js", isEntry: true },
      "src/screens/SettingsScreen.tsx": { file: "assets/settings.js", isDynamicEntry: true, imports: ["src/screens/WorkspaceScreen.tsx"] },
      "src/screens/WorkspaceScreen.tsx": { file: "assets/workspace.js" },
    },
    { "index.js": "export{}", "settings.js": "export{}", "workspace.js": "export{}" },
  );
  await assert.rejects(checkBundle({ distDir: settingsDistDir }), /SettingsScreen.*WorkspaceScreen/i);
});
