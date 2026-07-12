import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPrototypeVersionSnapshotResidue,
  prototypeVersionFilesDir,
  prototypeVersionHtmlPath,
  rewritePrototypeVersionAssetUrls,
  writePrototypeVersionSnapshot,
} from "../src/prototype-version-snapshot.ts";

test("Prototype snapshot residue cleanup removes only incomplete and private publications", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-prototype-version-cleanup-"));
  const projectRoot = join(dataDir, "projects", "project-cleanup");
  const versionsDir = join(projectRoot, ".versions");

  try {
    mkdirSync(join(versionsDir, "valid-run.files", "assets"), { recursive: true });
    writeFileSync(join(versionsDir, "valid-run.html"), "<main>valid</main>");
    writeFileSync(join(versionsDir, "valid-run.files", "assets", "valid.png"), "pixels");
    writeFileSync(join(versionsDir, "legacy-run.html"), "<main>legacy html only</main>");

    mkdirSync(join(versionsDir, "orphan-run.files", "assets"), { recursive: true });
    writeFileSync(join(versionsDir, "orphan-run.files", "assets", "orphan.png"), "pixels");
    mkdirSync(join(versionsDir, "run-visual-round-1.files"), { recursive: true });
    writeFileSync(join(versionsDir, "run-visual-round-1.html"), "<main>private review round</main>");
    writeFileSync(join(versionsDir, "run-visual-round-2.html"), "<main>private html residue</main>");
    mkdirSync(join(versionsDir, ".run-crash-123.files.tmp"), { recursive: true });
    writeFileSync(join(versionsDir, ".run-crash-123.html.tmp"), "<main>staged</main>");
    writeFileSync(join(versionsDir, "keep.notes"), "unrelated metadata");
    writeFileSync(join(projectRoot, "index.html"), "<main>live project source</main>");

    cleanupPrototypeVersionSnapshotResidue(dataDir);

    assert.equal(existsSync(join(versionsDir, "orphan-run.files")), false);
    assert.equal(existsSync(join(versionsDir, "run-visual-round-1.files")), false);
    assert.equal(existsSync(join(versionsDir, "run-visual-round-1.html")), false);
    assert.equal(existsSync(join(versionsDir, "run-visual-round-2.html")), false);
    assert.equal(existsSync(join(versionsDir, ".run-crash-123.files.tmp")), false);
    assert.equal(existsSync(join(versionsDir, ".run-crash-123.html.tmp")), false);

    assert.equal(readFileSync(join(versionsDir, "valid-run.html"), "utf8"), "<main>valid</main>");
    assert.equal(readFileSync(join(versionsDir, "valid-run.files", "assets", "valid.png"), "utf8"), "pixels");
    assert.equal(readFileSync(join(versionsDir, "legacy-run.html"), "utf8"), "<main>legacy html only</main>");
    assert.equal(readFileSync(join(versionsDir, "keep.notes"), "utf8"), "unrelated metadata");
    assert.equal(readFileSync(join(projectRoot, "index.html"), "utf8"), "<main>live project source</main>");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Prototype Viewer rewrites quoted inline CSS imports into the immutable Run bundle", () => {
  const rewritten = rewritePrototypeVersionAssetUrls(
    '<style>@import "styles/theme.css"; .hero{background:url("assets/hero.png")}</style>',
    "project-inline-import",
    "run-inline-import",
  );

  assert.match(rewritten, /@import "\/api\/projects\/project-inline-import\/versions\/run-inline-import\/files\/styles\/theme\.css"/);
  assert.match(rewritten, /url\("\/api\/projects\/project-inline-import\/versions\/run-inline-import\/files\/assets\/hero\.png"\)/);
});

test("Prototype snapshots fail closed when recursive CSS depends on an uncaptured symlink asset", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-prototype-version-"));
  const projectId = "project-css-chain";
  const runId = "run-css-chain";
  const root = join(dataDir, "projects", projectId);
  const outside = join(dataDir, "outside-hero.png");
  const html = '<link rel="stylesheet" href="/styles/site.css"><main class="hero">Historical</main>';

  try {
    mkdirSync(join(root, "styles"), { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "styles", "site.css"), '@import "./theme.css";');
    writeFileSync(join(root, "styles", "theme.css"), '.hero{background-image:url("../assets/hero.png")}');
    writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    symlinkSync(outside, join(root, "assets", "hero.png"));

    await assert.rejects(
      writePrototypeVersionSnapshot({ dataDir, projectId, runId, projectRoot: root, html }),
      /assets\/hero\.png/,
    );
    assert.equal(existsSync(prototypeVersionHtmlPath(dataDir, projectId, runId)), false);
    assert.equal(existsSync(prototypeVersionFilesDir(dataDir, projectId, runId)), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a Prototype snapshot is immutable and refuses to replace its prior coherent document and asset bundle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-prototype-version-"));
  const projectId = "project-atomic-snapshot";
  const runId = "run-atomic-snapshot";
  const root = join(dataDir, "projects", projectId);
  const originalHtml = '<img src="assets/hero.png" alt="Original">';
  const originalPixels = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

  try {
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "hero.png"), originalPixels);
    await writePrototypeVersionSnapshot({ dataDir, projectId, runId, projectRoot: root, html: originalHtml });

    await assert.rejects(
      writePrototypeVersionSnapshot({
        dataDir,
        projectId,
        runId,
        projectRoot: root,
        html: '<img src="assets/hero.png"><img src="assets/missing.png">',
      }),
      /already exists/i,
    );

    assert.equal(readFileSync(prototypeVersionHtmlPath(dataDir, projectId, runId), "utf8"), originalHtml);
    assert.deepEqual(
      readFileSync(join(prototypeVersionFilesDir(dataDir, projectId, runId), "assets", "hero.png")),
      originalPixels,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
