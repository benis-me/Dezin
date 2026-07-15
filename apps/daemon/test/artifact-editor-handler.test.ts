import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { Store } from "../../../packages/core/src/index.ts";
import type { ArtifactMutationCandidateContext } from "../src/artifact-mutation.ts";
import type { ArtifactThumbnailRenderer } from "../src/artifact-thumbnail.ts";
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/app.ts";
import { validateArtifactMutationCandidate } from "../src/artifact-editor-handler.ts";
import { buildRenderAssembly, materializeRenderAssembly } from "../src/render-assembly.ts";
import { projectDir } from "../src/serve-static.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function transparentPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface ArtifactEditorFixture {
  dataDir: string;
  root: string;
  store: Store;
  projectId: string;
  workspaceId: string;
  artifactId: string;
  trackId: string;
  revisionId: string;
  snapshotId: string;
  sourcePath: string;
  source: string;
  renderSpec: Record<string, unknown>;
  close(): void;
}

function createFixture(options: {
  source?: string;
  sourcePath?: string;
  renderSpec?: Record<string, unknown>;
} = {}): ArtifactEditorFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-editor-http-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Artifact editor HTTP", mode: "standard" });
  store.ensureMainVariant(project.id);
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const bundle = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    project: { ...facts.project, mode: "standard" },
    variants: facts.variants,
    successfulRuns: [],
  });
  const artifact = bundle.artifacts[0]!;
  const track = bundle.tracks.find((candidate) => candidate.id === artifact.activeTrackId)!;
  const root = projectDir(dataDir, project.id);
  const sourcePath = options.sourcePath ?? "src/App.jsx";
  const source = options.source
    ?? "export default function App() { return <h1 data-dezin-id=\"headline\">Old title</h1>; }\n";
  const renderSpec = options.renderSpec ?? {
    entry: sourcePath,
    thumbnailFrameId: "desktop",
    frames: [
      { id: "desktop", name: "Desktop", width: 1440, height: 900 },
      { id: "mobile", name: "Mobile", width: 390, height: 844 },
    ],
  };

  mkdirSync(dirname(join(root, sourcePath)), { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin-test@example.invalid"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    scripts: { dev: "vite" },
  }));
  writeFileSync(join(root, sourcePath), source);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  const sourceCommitHash = git(root, ["rev-parse", "HEAD"]);
  const sourceTreeHash = git(root, ["rev-parse", "HEAD^{tree}"]);
  const revision = store.workspace.createArtifactRevision({
    artifactId: artifact.id,
    trackId: track.id,
    parentRevisionId: null,
    sourceCommitHash,
    sourceTreeHash,
    kernelRevisionId: bundle.workspace.activeKernelRevisionId,
    renderSpec,
    quality: { state: "unassessed", score: null, findings: [] },
    dependencies: [],
    resourcePins: [],
  });
  const snapshot = store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: bundle.activeSnapshot.id,
  });
  return {
    dataDir,
    root,
    store,
    projectId: project.id,
    workspaceId: bundle.workspace.id,
    artifactId: artifact.id,
    trackId: track.id,
    revisionId: revision.id,
    snapshotId: snapshot.id,
    sourcePath,
    source,
    renderSpec,
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function withServer(
  fixture: ArtifactEditorFixture,
  extraDeps: Partial<AppDeps>,
  run: (base: string, runtimeSupervisor: ReturnType<typeof createRuntimeSupervisor>) => Promise<void>,
  configureServer?: (server: ReturnType<typeof createApp>) => void,
): Promise<void> {
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir: fixture.dataDir, store: fixture.store });
  const server = createApp({
    ...extraDeps,
    store: fixture.store,
    dataDir: fixture.dataDir,
    runtimeSupervisor,
  });
  configureServer?.(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, runtimeSupervisor);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function candidate(sourcePath: string, source: string): ArtifactMutationCandidateContext {
  return {
    checkoutRoot: "/tmp/dezin-validator-review",
    artifactRoot: ".",
    sourcePath,
    absoluteSourcePath: `/tmp/dezin-validator-review/${sourcePath}`,
    source,
    command: {
      type: "set-text",
      locator: { designNodeId: "headline", sourcePath },
      expectedCurrentValue: "Old title",
      value: "New title",
    },
  };
}

function mutationBody(fixture: ArtifactEditorFixture, expected = {}): Record<string, unknown> {
  return {
    expectedHeadRevisionId: fixture.revisionId,
    expectedSnapshotId: fixture.snapshotId,
    command: {
      type: "set-text",
      locator: { designNodeId: "headline", sourcePath: fixture.sourcePath },
      expectedCurrentValue: "Old title",
      value: "New title",
    },
    ...expected,
  };
}

function thumbnailUrl(base: string, fixture: ArtifactEditorFixture, query = ""): string {
  return `${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/revisions/${fixture.revisionId}/thumbnail${query}`;
}

function resourceStorageKey(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

function installResourcePayload(
  fixture: ArtifactEditorFixture,
  input: {
    resourceId: string;
    revisionId: string;
    bytes: Uint8Array;
    mimeType: string;
    manifestChecksum?: string;
    payloadChecksum?: string;
  },
): { publicUrl: string; payloadPath: string } {
  const workspaceKey = resourceStorageKey("dezin-resource-workspace-v1", fixture.workspaceId);
  const revisionKey = resourceStorageKey("dezin-resource-revision-v1", input.revisionId);
  const manifestPath = join(
    "resource-revisions",
    workspaceKey,
    revisionKey,
    "manifest.json",
  );
  const absoluteManifest = join(fixture.dataDir, manifestPath);
  const payloadPath = join(dirname(absoluteManifest), "payload.bin");
  const payloadChecksum = input.payloadChecksum
    ?? createHash("sha256").update(input.bytes).digest("hex");
  const manifestBytes = Buffer.from(`${JSON.stringify({
    protocol: "dezin-resource-revision-payload-v1",
    workspaceId: fixture.workspaceId,
    resourceId: input.resourceId,
    resourceRevisionId: input.revisionId,
    payload: {
      file: "payload.bin",
      mimeType: input.mimeType,
      byteLength: input.bytes.byteLength,
      checksum: payloadChecksum,
    },
  }, null, 2)}\n`);
  const manifestChecksum = input.manifestChecksum
    ?? createHash("sha256").update(manifestBytes).digest("hex");
  mkdirSync(dirname(absoluteManifest), { recursive: true });
  writeFileSync(absoluteManifest, manifestBytes);
  writeFileSync(payloadPath, input.bytes);
  fixture.store.db.prepare(
    `INSERT INTO resources
       (id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at)
     VALUES (?, ?, 'asset', ?, NULL, 'pin-current', NULL, 20, 20)`,
  ).run(input.resourceId, fixture.workspaceId, input.resourceId);
  fixture.store.db.prepare(
    `INSERT INTO resource_revisions
       (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
        checksum, provenance_json, created_by_run_id, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, '{}', NULL, 21)`,
  ).run(
    input.revisionId,
    fixture.workspaceId,
    input.resourceId,
    manifestPath,
    input.resourceId,
    JSON.stringify({ mimeType: input.mimeType }),
    manifestChecksum,
  );
  fixture.store.db.prepare("UPDATE resources SET head_revision_id = ? WHERE id = ?")
    .run(input.revisionId, input.resourceId);
  return {
    publicUrl: `/.dezin/resources/${revisionKey}/payload.png`,
    payloadPath,
  };
}

test("POST artifact mutation publishes by Head and Snapshot CAS without changing the canonical checkout", async () => {
  const fixture = createFixture();
  try {
    const before = {
      head: git(fixture.root, ["rev-parse", "HEAD"]),
      status: git(fixture.root, ["status", "--porcelain=v2", "--untracked-files=all"]),
      source: readFileSync(join(fixture.root, fixture.sourcePath), "utf8"),
    };
    await withServer(fixture, {}, async (base) => {
      const response = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody(fixture)),
      });
      assert.equal(response.status, 201);
      const payload = await response.json() as {
        revision: { id: string; parentRevisionId: string };
        snapshot: { id: string; artifactRevisions: Record<string, string | null> };
      };
      assert.equal(payload.revision.parentRevisionId, fixture.revisionId);
      assert.equal(payload.snapshot.artifactRevisions[fixture.artifactId], payload.revision.id);
    });
    assert.deepEqual({
      head: git(fixture.root, ["rev-parse", "HEAD"]),
      status: git(fixture.root, ["status", "--porcelain=v2", "--untracked-files=all"]),
      source: readFileSync(join(fixture.root, fixture.sourcePath), "utf8"),
    }, before);
  } finally {
    fixture.close();
  }
});

test("POST set-asset resolves a daemon-owned immutable Resource payload without injected production wiring", async () => {
  const fixture = createFixture({
    sourcePath: "index.html",
    source: "<!doctype html><img data-dezin-id=\"cover\" src=\"old.png\">\n",
    renderSpec: { entry: "index.html", frames: [{ id: "desktop", width: 1440, height: 900 }] },
  });
  const payload = installResourcePayload(fixture, {
    resourceId: "cover-asset",
    revisionId: "cover-asset-v1",
    bytes: PNG,
    mimeType: "image/png",
  });
  try {
    await withServer(fixture, {}, async (base) => {
      const response = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedHeadRevisionId: fixture.revisionId,
          expectedSnapshotId: fixture.snapshotId,
          command: {
            type: "set-asset",
            locator: { designNodeId: "cover", sourcePath: fixture.sourcePath },
            resourceRevisionId: "cover-asset-v1",
          },
        }),
      });
      const responseText = await response.text();
      assert.equal(response.status, 201, responseText);
      const result = JSON.parse(responseText) as { revision: { id: string } };
      const revision = fixture.store.workspace.getArtifactRevision(result.revision.id)!;
      assert.deepEqual(fixture.store.workspace.listArtifactRevisionResourcePins(revision.id), [{
        workspaceId: fixture.workspaceId,
        ownerArtifactId: fixture.artifactId,
        revisionId: revision.id,
        resourceId: "cover-asset",
        resourceRevisionId: "cover-asset-v1",
      }]);
      const committed = git(fixture.root, ["show", `${revision.sourceCommitHash}:index.html`]);
      assert.match(committed, new RegExp(`src=["']${payload.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
      const assembly = buildRenderAssembly(fixture.store, {
        projectId: fixture.projectId,
        revisionId: revision.id,
      }, { dataDir: fixture.dataDir });
      const artifactDir = await materializeRenderAssembly(fixture, assembly);
      assert.deepEqual(readFileSync(join(artifactDir, assembly.resourcePayloads[0]!.mountPath)), PNG);
    });
  } finally {
    fixture.close();
  }
});

test("POST set-asset rejects corrupt or missing immutable payloads before publishing a new Head", async () => {
  const fixture = createFixture({
    sourcePath: "index.html",
    source: "<!doctype html><img data-dezin-id=\"cover\" src=\"old.png\">\n",
  });
  const beforeRevisionCount = Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM artifact_revisions WHERE workspace_id = ?",
  ).get(fixture.workspaceId) as { count: number }).count);
  installResourcePayload(fixture, {
    resourceId: "corrupt-cover",
    revisionId: "corrupt-cover-v1",
    bytes: PNG,
    mimeType: "image/png",
    payloadChecksum: "0".repeat(64),
  });
  const missing = installResourcePayload(fixture, {
    resourceId: "missing-cover",
    revisionId: "missing-cover-v1",
    bytes: PNG,
    mimeType: "image/png",
  });
  rmSync(missing.payloadPath);
  try {
    await withServer(fixture, {}, async (base) => {
      const endpoint = `${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedHeadRevisionId: fixture.revisionId,
          expectedSnapshotId: fixture.snapshotId,
          command: {
            type: "set-asset",
            locator: { designNodeId: "cover", sourcePath: fixture.sourcePath },
            resourceRevisionId: "corrupt-cover-v1",
          },
        }),
      });
      assert.equal(response.status, 422);
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, "artifact_mutation_invalid");
      assert.match(body.error, /payload checksum/i);

      const missingResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedHeadRevisionId: fixture.revisionId,
          expectedSnapshotId: fixture.snapshotId,
          command: {
            type: "set-asset",
            locator: { designNodeId: "cover", sourcePath: fixture.sourcePath },
            resourceRevisionId: "missing-cover-v1",
          },
        }),
      });
      assert.equal(missingResponse.status, 422);
      const missingBody = await missingResponse.json() as { code: string; error: string };
      assert.equal(missingBody.code, "artifact_mutation_invalid");
      assert.match(missingBody.error, /payload.*missing/i);
    });
    assert.equal(fixture.store.workspace.getTrack(fixture.trackId)?.headRevisionId, fixture.revisionId);
    assert.equal(fixture.store.workspace.getWorkspace(fixture.projectId)?.activeSnapshotId, fixture.snapshotId);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions WHERE workspace_id = ?",
    ).get(fixture.workspaceId) as { count: number }).count), beforeRevisionCount);
  } finally {
    fixture.close();
  }
});

test("POST artifact mutation distinguishes malformed JSON, invalid commands, and foreign paths", async () => {
  const fixture = createFixture();
  try {
    await withServer(fixture, {}, async (base) => {
      const endpoint = `${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`;
      const malformed = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(malformed.status, 400);

      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...mutationBody(fixture), command: { type: "set-html" } }),
      });
      assert.equal(invalid.status, 422);
      assert.equal((await invalid.json() as { code: string }).code, "artifact_mutation_invalid");

      const foreign = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/foreign-artifact/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody(fixture)),
      });
      assert.equal(foreign.status, 404);
      assert.equal((await foreign.json() as { code: string }).code, "artifact_mutation_not_found");

      const malformedForeign = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/foreign-artifact/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(malformedForeign.status, 404, "ownership takes precedence over body parsing");
    });
  } finally {
    fixture.close();
  }
});

test("POST artifact mutation runs a real source parser before publication", async () => {
  const fixture = createFixture({
    source: "export default function App() { return <h1 data-dezin-id=\"headline\">Old title</h1>;\n",
  });
  try {
    await withServer(fixture, {}, async (base) => {
      const response = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody(fixture)),
      });
      assert.equal(response.status, 422);
      const payload = await response.json() as { code: string; error: string };
      assert.equal(payload.code, "artifact_mutation_invalid");
      assert.match(payload.error, /syntax|parse|unterminated|expected/i);
    });
    assert.equal(readFileSync(join(fixture.root, fixture.sourcePath), "utf8"), fixture.source);
  } finally {
    fixture.close();
  }
});

test("candidate parser rejects runtime-invalid early errors in every supported script mode", async () => {
  const invalid = [
    candidate("src/duplicate.js", "const value = 1; const value = 2;"),
    candidate("src/return.jsx", "return <main />;"),
    candidate("src/return.ts", "return 1;"),
    candidate("src/broken.tsx", "export default function App() { return <main>; }"),
  ];
  for (const entry of invalid) {
    await assert.rejects(
      validateArtifactMutationCandidate(entry),
      /syntax|parse|return|declared|expected|unterminated/i,
      entry.sourcePath,
    );
  }
});

test("candidate parser accepts JSX syntax in a .js Artifact source", async () => {
  await validateArtifactMutationCandidate(candidate(
    "src/App.js",
    "export default function App() { return <main data-dezin-id=\"root\">Ready</main>; }",
  ));
});

test("candidate parser follows HTML optional-end-tag rules while rejecting malformed explicit structure", async () => {
  await validateArtifactMutationCandidate(candidate(
    "index.html",
    "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><main><img src=\"data:,\"></main></body></html>",
  ));
  for (const source of [
    "<!doctype html><ul><li>One<li>Two</ul>",
    "<!doctype html><p>Intro<section>Body</section>",
    "<!doctype html><p>Intro<dialog>Body</dialog>",
    "<!doctype html><table><thead><tr><th>A<th>B<tbody><tr><td>1<td>2</table>",
    "<!doctype html><table><caption>Title<colgroup><col><tbody><tr><td>1</table>",
    "<!doctype html><table><colgroup><col> <tbody><tr><td>1</table>",
    "<!doctype html><select><option>One<option>Two</select>",
    "<!doctype html><select><optgroup label=\"A\"><option>One<hr></select>",
    "<!doctype html><html><head><title>Title</title> <body>Body",
    "<!doctype html><svg><![CDATA[</path>]]><path /></svg>",
  ]) {
    await validateArtifactMutationCandidate(candidate("valid.html", source));
  }
  await assert.rejects(
    validateArtifactMutationCandidate(candidate("broken.html", "<main><span>broken</main>")),
    /syntax|parse|balanced|closing|end tag/i,
  );
  for (const source of [
    "</main>",
    "<main>content</main></main>",
    "<img></img>",
    "<!doctype html><dl><dt>Term</dl>",
  ]) {
    await assert.rejects(
      validateArtifactMutationCandidate(candidate("broken.html", source)),
      /syntax|parse|balanced|closing|end tag/i,
      source,
    );
  }
});

test("candidate HTML parser handles deeply nested bounded documents without overflowing its validation stack", async () => {
  const depth = 12_000;
  await validateArtifactMutationCandidate(candidate(
    "deep.html",
    `<!doctype html>${"<div>".repeat(depth)}content${"</div>".repeat(depth)}`,
  ));
});

test("candidate parser fails closed for Vue and Svelte without their official compilers", async () => {
  await assert.rejects(
    validateArtifactMutationCandidate(candidate("Component.vue", "<template><main>Valid-looking Vue</main></template>")),
    /unsupported|compiler/i,
  );
  await assert.rejects(
    validateArtifactMutationCandidate(candidate("Component.svelte", "<main>Valid-looking Svelte</main>")),
    /unsupported|compiler/i,
  );
});

test("POST artifact mutation returns ordinary CAS conflicts without creating a candidate identity", async () => {
  const fixture = createFixture();
  try {
    await withServer(fixture, {}, async (base) => {
      const response = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody(fixture, { expectedSnapshotId: "stale-snapshot" })),
      });
      assert.equal(response.status, 409);
      const payload = await response.json() as Record<string, unknown>;
      assert.equal(payload.code, "artifact_mutation_conflict");
      assert.equal("candidateRevisionId" in payload, false);
    });
  } finally {
    fixture.close();
  }
});

test("POST artifact mutation preserves retained candidate identity when publication loses CAS", async () => {
  const fixture = createFixture();
  const workspace = fixture.store.workspace as unknown as {
    publishArtifactRevision: (revisionId: string, expected: {
      expectedHeadRevisionId: string | null;
      expectedSnapshotId: string;
    }) => unknown;
  };
  const publish = workspace.publishArtifactRevision.bind(workspace);
  let intercepted = false;
  workspace.publishArtifactRevision = (revisionId, expected) => {
    if (!intercepted && revisionId !== fixture.revisionId) {
      intercepted = true;
      const parent = fixture.store.workspace.getArtifactRevision(fixture.revisionId)!;
      const concurrent = fixture.store.workspace.createArtifactRevision({
        artifactId: fixture.artifactId,
        trackId: fixture.trackId,
        parentRevisionId: fixture.revisionId,
        sourceCommitHash: parent.sourceCommitHash,
        sourceTreeHash: parent.sourceTreeHash,
        kernelRevisionId: parent.kernelRevisionId,
        renderSpec: parent.renderSpec,
        quality: { state: "unassessed", score: null, findings: [] },
        dependencies: [],
        resourcePins: [],
      });
      publish(concurrent.id, expected);
    }
    return publish(revisionId, expected);
  };
  try {
    await withServer(fixture, {}, async (base) => {
      const response = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody(fixture)),
      });
      assert.equal(response.status, 409);
      const payload = await response.json() as {
        code: string;
        candidateRevisionId: string;
        candidateRef: string;
      };
      assert.equal(payload.code, "artifact_mutation_candidate_retained");
      assert.ok(payload.candidateRevisionId);
      assert.match(payload.candidateRef, /^refs\/dezin\/artifact-revisions\//);
      assert.ok(fixture.store.workspace.getArtifactRevision(payload.candidateRevisionId));
      assert.ok(git(fixture.root, ["show-ref", "--verify", payload.candidateRef]));
    });
  } finally {
    fixture.close();
  }
});

test("GET artifact thumbnail returns immutable PNG headers and honors weak If-None-Match", async () => {
  const fixture = createFixture();
  let renders = 0;
  const renderer: ArtifactThumbnailRenderer = (target) => {
    renders += 1;
    assert.equal(target.projectId, fixture.projectId);
    assert.equal(target.artifactId, fixture.artifactId);
    assert.equal(target.revisionId, fixture.revisionId);
    assert.equal(target.frame.id, "desktop");
    return { bytes: PNG, contentType: "image/png", targetChecksum: target.targetChecksum };
  };
  try {
    await withServer(fixture, { artifactThumbnailRenderer: renderer } as Partial<AppDeps>, async (base) => {
      const first = await fetch(thumbnailUrl(base, fixture));
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("content-type"), "image/png");
      assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.equal(first.headers.get("x-content-type-options"), "nosniff");
      const etag = first.headers.get("etag");
      assert.ok(etag);
      assert.deepEqual(Buffer.from(await first.arrayBuffer()), PNG);

      const second = await fetch(thumbnailUrl(base, fixture), {
        headers: { "if-none-match": `W/${etag}` },
      });
      assert.equal(second.status, 304);
      assert.equal(await second.text(), "");
      assert.equal(second.headers.get("etag"), etag);
      assert.equal(renders, 1);
    });
  } finally {
    fixture.close();
  }
});

test("GET artifact thumbnail validates ownership and query parameters before rendering", async () => {
  const fixture = createFixture();
  let renders = 0;
  const renderer: ArtifactThumbnailRenderer = (target) => {
    renders += 1;
    return { bytes: PNG, contentType: "image/png", targetChecksum: target.targetChecksum };
  };
  try {
    await withServer(fixture, { artifactThumbnailRenderer: renderer } as Partial<AppDeps>, async (base) => {
      const duplicate = await fetch(thumbnailUrl(base, fixture, "?frame=desktop&frame=mobile"));
      assert.equal(duplicate.status, 422);
      const unexpected = await fetch(thumbnailUrl(base, fixture, "?future=1"));
      assert.equal(unexpected.status, 422);
      const emptyState = await fetch(thumbnailUrl(base, fixture, "?state="));
      assert.equal(emptyState.status, 422);
      const foreignArtifact = await fetch(
        `${base}/api/projects/${fixture.projectId}/artifacts/foreign/revisions/${fixture.revisionId}/thumbnail?future=1`,
      );
      assert.equal(foreignArtifact.status, 404, "ownership takes precedence over query parsing");
      const foreignRevision = await fetch(
        `${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/revisions/foreign/thumbnail`,
      );
      assert.equal(foreignRevision.status, 404);
      assert.equal(renders, 0);
    });
  } finally {
    fixture.close();
  }
});

test("GET artifact thumbnail maps invalid image bytes to 422 and renderer failures to 503", async () => {
  const fixture = createFixture();
  const renderer: ArtifactThumbnailRenderer = (target) => {
    if (target.frame.id === "desktop") {
      return { bytes: Buffer.from("not-a-png"), contentType: "image/png", targetChecksum: target.targetChecksum };
    }
    throw new Error("renderer offline");
  };
  try {
    await withServer(fixture, { artifactThumbnailRenderer: renderer } as Partial<AppDeps>, async (base) => {
      const invalid = await fetch(thumbnailUrl(base, fixture));
      assert.equal(invalid.status, 422);
      assert.equal((await invalid.json() as { code: string }).code, "artifact_thumbnail_invalid");
      const failed = await fetch(thumbnailUrl(base, fixture, "?frame=mobile"));
      assert.equal(failed.status, 503);
      assert.equal((await failed.json() as { code: string }).code, "artifact_thumbnail_renderer_unavailable");
    });
  } finally {
    fixture.close();
  }
});

test("production thumbnail rendering acquires the exact immutable Revision, captures the required frame, and releases its lease", async () => {
  const fixture = createFixture({
    renderSpec: {
      entry: "src/App.jsx",
      thumbnailFrameId: "desktop",
      frames: [
        { id: "desktop", name: "Desktop", width: 1440, height: 900, background: "#123456" },
        { id: "mobile", name: "Mobile", width: 390, height: 844 },
      ],
    },
  });
  let released = 0;
  let capturedPath = "";
  try {
    await withServer(fixture, {
      ensureDevServer: async (projectId, _dir, _runtimeKey, signal, _manager, options) => {
        assert.equal(projectId, fixture.projectId);
        assert.equal(signal?.aborted, false);
        assert.equal(options?.immutableSource, true);
        assert.equal(options?.runtimeIdentity?.artifactId, fixture.artifactId);
        assert.equal(options?.runtimeIdentity?.revisionId, fixture.revisionId);
        return {
          leaseId: "thumbnail-lease",
          url: "http://127.0.0.1:65535/immutable-preview",
          expiresAt: Date.now() + 30_000,
          async release() { released += 1; },
        };
      },
      artifactThumbnailCapture: async (_url, outPath, frame, signal) => {
        assert.deepEqual(frame, {
          width: 1440,
          height: 900,
          frameId: "desktop",
          background: "#123456",
        });
        assert.equal(signal?.aborted, false);
        capturedPath = outPath;
        writeFileSync(outPath, transparentPng(frame.width, frame.height));
        return true;
      },
    } as Partial<AppDeps>, async (base) => {
      const response = await fetch(thumbnailUrl(base, fixture));
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.readUInt32BE(16), 1440);
      assert.equal(bytes.readUInt32BE(20), 900);
    });
    assert.equal(released, 1);
    assert.ok(capturedPath);
    assert.equal(existsSync(capturedPath), false, "temporary thumbnail files are removed after capture");
  } finally {
    fixture.close();
  }
});

test("production thumbnail rendering fails closed when a required interaction state cannot be applied", async () => {
  const fixture = createFixture();
  let captures = 0;
  try {
    await withServer(fixture, {
      artifactThumbnailCapture: async () => {
        captures += 1;
        return true;
      },
    } as Partial<AppDeps>, async (base) => {
      const response = await fetch(thumbnailUrl(base, fixture, "?state=hover"));
      assert.equal(response.status, 422);
      assert.equal((await response.json() as { code: string }).code, "artifact_thumbnail_invalid");
    });
    assert.equal(captures, 0);
  } finally {
    fixture.close();
  }
});

test("artifact thumbnail rejects a context-dependent frame background before capture", async () => {
  const fixture = createFixture({
    renderSpec: {
      entry: "src/App.jsx",
      thumbnailFrameId: "desktop",
      frames: [
        { id: "desktop", name: "Desktop", width: 1440, height: 900, background: "currentColor" },
      ],
    },
  });
  let captures = 0;
  try {
    await withServer(fixture, {
      artifactThumbnailCapture: async () => {
        captures += 1;
        return true;
      },
    } as Partial<AppDeps>, async (base) => {
      const response = await fetch(thumbnailUrl(base, fixture));
      assert.equal(response.status, 422);
      assert.equal((await response.json() as { code: string }).code, "artifact_thumbnail_invalid");
    });
    assert.equal(captures, 0);
  } finally {
    fixture.close();
  }
});

test("GET artifact thumbnail propagates request cancellation to the renderer", async () => {
  const fixture = createFixture();
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let abortedResolve!: () => void;
  const aborted = new Promise<void>((resolve) => { abortedResolve = resolve; });
  const renderer: ArtifactThumbnailRenderer = async (_target, { signal }): Promise<never> => {
    startedResolve();
    return await new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        abortedResolve();
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  try {
    let writesAfterClose = 0;
    await withServer(fixture, { artifactThumbnailRenderer: renderer } as Partial<AppDeps>, async (base) => {
      const controller = new AbortController();
      const request = fetch(thumbnailUrl(base, fixture, "?frame=mobile"), { signal: controller.signal });
      await started;
      controller.abort(new Error("test request cancelled"));
      await assert.rejects(request, /cancelled|abort/i);
      await aborted;
      await new Promise((resolve) => setImmediate(resolve));
    }, (server) => {
      server.prependListener("request", (_req, res) => {
        let closed = false;
        res.once("close", () => { closed = true; });
        const writeHead = res.writeHead;
        res.writeHead = ((...args: unknown[]) => {
          if (closed) writesAfterClose += 1;
          return Reflect.apply(writeHead, res, args);
        }) as typeof res.writeHead;
      });
    });
    assert.equal(writesAfterClose, 0, "a disconnected client must not receive a late error response");
  } finally {
    fixture.close();
  }
});

test("GET artifact thumbnail maps active runtime-scope cancellation to 409", async () => {
  const fixture = createFixture();
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const renderer: ArtifactThumbnailRenderer = async (_target, { signal }): Promise<never> => {
    startedResolve();
    return await new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new Error("runtime scope cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  try {
    await withServer(fixture, { artifactThumbnailRenderer: renderer } as Partial<AppDeps>, async (base, supervisor) => {
      const request = fetch(thumbnailUrl(base, fixture));
      await started;
      supervisor.cancelOperations({ projectId: fixture.projectId });
      const response = await request;
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /runtime scope|cancel/i);
    });
  } finally {
    fixture.close();
  }
});

test("GET artifact thumbnail returns 503 when rendering is explicitly unavailable", async () => {
  const fixture = createFixture();
  try {
    await withServer(fixture, { artifactThumbnailRenderer: null } as Partial<AppDeps>, async (base) => {
      const response = await fetch(thumbnailUrl(base, fixture));
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { code: string }).code, "artifact_thumbnail_renderer_unavailable");
    });
  } finally {
    fixture.close();
  }
});

test("an injected candidate validator participates in mutation publication", async () => {
  const fixture = createFixture();
  const observed: { candidate?: ArtifactMutationCandidateContext } = {};
  try {
    await withServer(fixture, {
      artifactMutationValidator(candidate) {
        observed.candidate = candidate;
        throw new Error("project-specific validation failed");
      },
    } as Partial<AppDeps>, async (base) => {
      const response = await fetch(`${base}/api/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody(fixture)),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json() as { code: string }).code, "artifact_mutation_invalid");
    });
    assert.equal(observed.candidate?.sourcePath, fixture.sourcePath);
    assert.match(observed.candidate?.source ?? "", /New title/);
  } finally {
    fixture.close();
  }
});
