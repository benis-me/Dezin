import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectStandardArtifactCandidate } from "../src/orchestration/standard-artifact-quality-evaluator.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function repository(files: Readonly<Record<string, string | Buffer>>): {
  root: string;
  candidate: { commitHash: string; treeHash: string };
} {
  const root = mkdtempSync(join(tmpdir(), "dezin-quality-sidecar-reference-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "candidate");
  return {
    root,
    candidate: {
      commitHash: git(root, "rev-parse", "HEAD"),
      treeHash: git(root, "rev-parse", "HEAD^{tree}"),
    },
  };
}

async function inspect(
  root: string,
  candidate: { commitHash: string; treeHash: string },
  immutableSharinganSidecar = true,
): Promise<string> {
  const result = await inspectStandardArtifactCandidate({
    repositoryDir: root,
    worktreeDir: root,
    candidate,
    immutableSharinganSidecar,
    signal: new AbortController().signal,
  });
  return result.status;
}

for (const fixture of [
  ["index.html", '<img src="/_assets/source.png" alt="Source">\n'],
  ["index.html", '<img src="_assets/source.png" alt="Relative source">\n'],
  ["src/page.html", '<img src="../_assets/source.png" alt="Parent-relative source">\n'],
  ["src/styles.css", ".hero { background-image: url('/_assets/source.png'); }\n"],
  ["src/styles.css", ".hero { background-image: url('./_assets/source.png'); }\n"],
  ["src/App.tsx", 'export const App = () => <img src="/_assets/source.png" />;\n'],
] as const) {
  test(`candidate inspection rejects committed ${fixture[0]} references to the immutable asset sidecar`, async () => {
    const { root, candidate } = repository({ [fixture[0]]: fixture[1] });
    try {
      // The immutable resource is visible during QA, but it is not part of the
      // candidate commit and will be hidden before candidate publication.
      write(root, ".sharingan/pages.json", '{"pages":[]}\n');
      write(root, "public/_assets/source.png", "immutable resource\n");

      const status = await inspect(root, candidate);
      assert.match(status, /immutable Sharingan asset sidecar/);
      assert.match(status, new RegExp(fixture[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(status, /immutable resource/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("candidate inspection ignores sidecar contents and accepts candidate-owned copied asset paths", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": 'export const App = () => <img src="/assets/copied-source.png" />;\n',
    "public/assets/copied-source.png": "candidate-owned copy\n",
  });
  try {
    write(root, ".sharingan/pages.json", '{"asset":"/_assets/source.png"}\n');
    write(root, "public/_assets/source.css", "body{background:url('/_assets/source.png')}\n");

    assert.equal(await inspect(root, candidate), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate inspection does not reject ordinary identifiers containing _assets", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": [
      "const cached_assets = new Map();",
      'export const App = () => <img src="/assets/copied-source.png" data-cache={cached_assets.size} />;',
      "",
    ].join("\n"),
    "public/assets/copied-source.png": "candidate-owned copy\n",
  });
  try {
    assert.equal(await inspect(root, candidate), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate inspection does not traverse source-shaped symlinks", async () => {
  const external = mkdtempSync(join(tmpdir(), "dezin-quality-sidecar-external-"));
  const root = mkdtempSync(join(tmpdir(), "dezin-quality-sidecar-reference-"));
  try {
    writeFileSync(join(external, "outside.tsx"), 'export const safe = "/assets/owned.png";\n');
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@dezin.local");
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync(join(external, "outside.tsx"), join(root, "src", "Escape.tsx"));
    git(root, "add", "src/Escape.tsx");
    git(root, "commit", "-q", "-m", "candidate");
    const candidate = {
      commitHash: git(root, "rev-parse", "HEAD"),
      treeHash: git(root, "rev-parse", "HEAD^{tree}"),
    };
    rmSync(external, { recursive: true, force: true });

    assert.match(await inspect(root, candidate), /unsafe candidate source blob/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("Sharingan candidate inspection rejects an asset symlink into the hidden sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-quality-sidecar-reference-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@dezin.local");
    write(root, "index.html", '<img src="/assets/source.png" alt="Source">\n');
    mkdirSync(join(root, "public", "assets"), { recursive: true });
    symlinkSync("../_assets/source.png", join(root, "public", "assets", "source.png"));
    git(root, "add", "index.html", "public/assets/source.png");
    git(root, "commit", "-q", "-m", "candidate");
    const candidate = {
      commitHash: git(root, "rev-parse", "HEAD"),
      treeHash: git(root, "rev-parse", "HEAD^{tree}"),
    };
    write(root, ".sharingan/pages.json", '{"pages":[]}\n');
    write(root, "public/_assets/source.png", "immutable resource\n");

    assert.match(await inspect(root, candidate), /unsafe candidate source blob: public\/assets\/source\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate inspection rejects binary content disguised as source without leaking bytes", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": Buffer.from("secret-prefix\0/_assets/source.png\n", "utf8"),
  });
  try {
    const status = await inspect(root, candidate);
    assert.match(status, /unsafe candidate source blob/);
    assert.doesNotMatch(status, /secret-prefix/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate inspection scans tracked dependency source without leaking its contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-quality-sidecar-reference-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@dezin.local");
    write(root, "src/App.tsx", 'export const App = () => <img src="/assets/owned.png" />;\n');
    write(root, "node_modules/example/index.tsx", 'export const leaked = "/_assets/dependency.png";\n');
    git(root, "add", "src/App.tsx");
    git(root, "add", "-f", "node_modules/example/index.tsx");
    git(root, "commit", "-q", "-m", "candidate");
    const candidate = {
      commitHash: git(root, "rev-parse", "HEAD"),
      treeHash: git(root, "rev-parse", "HEAD^{tree}"),
    };

    const status = await inspect(root, candidate);
    assert.match(status, /immutable Sharingan asset sidecar reference: node_modules\/example\/index\.tsx/);
    assert.doesNotMatch(status, /dependency\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate inspection does not treat a runtime vendor segment as a dependency boundary", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": 'export { VendorApp } from "./vendor/App.tsx";\n',
    "src/vendor/App.tsx": 'export const VendorApp = () => <img src="/_assets/source.png" />;\n',
  });
  try {
    const status = await inspect(root, candidate);
    assert.match(status, /immutable Sharingan asset sidecar reference: src\/vendor\/App\.tsx/);
    assert.doesNotMatch(status, /source\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate inspection ignores explanatory JS, CSS, and HTML comments", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": [
      "// Never ship /_assets/source.png; copy the asset first.",
      'export const App = () => <img src="/assets/copied-source.png" />;',
      "",
    ].join("\n"),
    "src/styles.css": [
      "/* Never use url('/_assets/source.png') in candidate CSS. */",
      ".hero { background: var(--surface); }",
      "",
    ].join("\n"),
    "index.html": [
      "<!-- /_assets/source.png belongs to the immutable reference only. -->",
      '<main data-note="<!-- preserved attribute text -->">Candidate-owned content</main>',
      "",
    ].join("\n"),
  });
  try {
    assert.equal(await inspect(root, candidate), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment-like delimiters inside strings cannot hide a later sidecar reference", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": [
      'const marker = "/* not a comment */";',
      'const source = "/_assets/source.png";',
      "export const App = () => <img src={source} data-marker={marker} />;",
      "",
    ].join("\n"),
  });
  try {
    assert.match(await inspect(root, candidate), /immutable Sharingan asset sidecar reference: src\/App\.tsx:2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Sharingan candidate inspection accepts its own committed public/_assets contract", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": 'export const App = () => <img src="/_assets/owned.png" />;\n',
    "public/_assets/owned.png": "candidate-owned asset\n",
  });
  try {
    assert.equal(await inspect(root, candidate, false), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Sharingan candidate inspection reports real public/_assets mutations", async () => {
  const { root, candidate } = repository({
    "src/App.tsx": 'export const App = () => <img src="/assets/owned.png" />;\n',
    "public/_assets/owned.png": "candidate-owned asset\n",
  });
  try {
    write(root, "public/_assets/owned.png", "mutated candidate-owned asset\n");
    assert.match(await inspect(root, candidate, false), /public\/_assets\/owned\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
