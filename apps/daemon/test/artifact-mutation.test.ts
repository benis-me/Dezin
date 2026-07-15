import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Store } from "../../../packages/core/src/index.ts";
import {
  applyArtifactMutation,
  ArtifactMutationConflictError,
  parseArtifactMutationRequest,
} from "../src/artifact-mutation.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createMutationFixture(options: {
  sourcePath?: string;
  source?: string | Uint8Array;
  attributes?: string;
  extraFiles?: Readonly<Record<string, string | Uint8Array>>;
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-artifact-mutation-"));
  const root = join(dataDir, "project");
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin-test@example.invalid"]);
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Artifact mutation", mode: "standard" });
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
  const sourcePath = options.sourcePath ?? "index.html";
  const source = options.source ?? [
    "<!doctype html>",
    "<html><body>",
    "<section data-dezin-id=\"hero\"><h1 data-dezin-id=\"headline\">Old title</h1><img data-dezin-id=\"cover\" src=\"old.png\"></section>",
    "</body></html>",
  ].join("\n");
  mkdirSync(dirname(join(root, sourcePath)), { recursive: true });
  writeFileSync(join(root, sourcePath), source);
  for (const [path, bytes] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  if (options.attributes !== undefined) writeFileSync(join(root, ".gitattributes"), options.attributes);
  git(root, [
    "add",
    sourcePath,
    ...Object.keys(options.extraFiles ?? {}),
    ...(options.attributes === undefined ? [] : [".gitattributes"]),
  ]);
  git(root, ["commit", "-q", "-m", "initial"]);
  const commitHash = git(root, ["rev-parse", "HEAD"]);
  const revision = store.workspace.createArtifactRevision({
    artifactId: artifact.id,
    trackId: track.id,
    parentRevisionId: null,
    sourceCommitHash: commitHash,
    sourceTreeHash: git(root, ["rev-parse", `${commitHash}^{tree}`]),
    kernelRevisionId: bundle.workspace.activeKernelRevisionId,
    renderSpec: { entry: sourcePath, frames: [{ id: "desktop", width: 1440, height: 900 }] },
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
    revision,
    snapshot,
    validateCandidateSource() {},
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function resourcePublicRoot(resourceRevisionId: string): string {
  const key = createHash("sha256")
    .update("dezin-resource-revision-v1")
    .update("\0")
    .update(resourceRevisionId)
    .digest("hex");
  return `/.dezin/resources/${key}/`;
}

function assetDescriptor(
  fixture: ReturnType<typeof createMutationFixture>,
  resourceRevisionId: string,
  overrides: Partial<{
    protocol: "dezin-resource-revision-payload-v1";
    workspaceId: string;
    resourceId: string;
    resourceRevisionId: string;
    resourceKind: "asset" | "file";
    manifestPath: string;
    manifestChecksum: string;
    payloadPath: string;
    payloadChecksum: string;
    byteLength: number;
    mimeType: string;
    mountPath: string;
    publicUrl: string;
  }> = {},
) {
  const row = fixture.store.db.prepare(
    `SELECT revision.resource_id, revision.manifest_path, revision.checksum,
            revision.metadata_json, resource.kind
       FROM resource_revisions revision
       JOIN resources resource
         ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
      WHERE revision.id = ? AND revision.workspace_id = ?`,
  ).get(resourceRevisionId, fixture.workspaceId) as {
    resource_id: string;
    manifest_path: string;
    checksum: string;
    metadata_json: string;
    kind: "asset" | "file";
  };
  const mimeType = (JSON.parse(row.metadata_json) as { mimeType: string }).mimeType;
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/", 2)[1]!.replace("svg+xml", "svg");
  const mountPath = `.dezin/resources/${resourcePublicRoot(resourceRevisionId).split("/").at(-2)!}/payload.${extension}`;
  return {
    protocol: "dezin-resource-revision-payload-v1" as const,
    workspaceId: fixture.workspaceId,
    resourceId: row.resource_id,
    resourceRevisionId,
    resourceKind: row.kind,
    manifestPath: row.manifest_path,
    manifestChecksum: row.checksum,
    payloadPath: `${dirname(row.manifest_path)}/payload.bin`,
    payloadChecksum: createHash("sha256").update(resourceRevisionId).digest("hex"),
    byteLength: 1,
    mimeType,
    mountPath,
    publicUrl: `/${mountPath}`,
    ...overrides,
  };
}

function assetDescriptorAt(
  fixture: ReturnType<typeof createMutationFixture>,
  resourceRevisionId: string,
  publicUrl: string,
) {
  const descriptor = assetDescriptor(fixture, resourceRevisionId);
  assert.match(publicUrl, /^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]+$/);
  return { ...descriptor, mountPath: publicUrl.slice(1), publicUrl };
}

function assetResolver(
  fixture: ReturnType<typeof createMutationFixture>,
  sourceFor: (resourceRevisionId: string) => string = (resourceRevisionId) => (
    `/api/immutable-assets/${resourceRevisionId}`
  ),
) {
  return ({ resourceRevisionId }: { resourceRevisionId: string }) => (
    assetDescriptorAt(fixture, resourceRevisionId, sourceFor(resourceRevisionId))
  );
}

function addResourceRevision(
  fixture: ReturnType<typeof createMutationFixture>,
  id: string,
  mimeType: string,
  kind: "asset" | "file" = "asset",
): string {
  const revisionId = `${id}-r1`;
  fixture.store.db.prepare(
    `INSERT INTO resources
       (id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'pin-current', NULL, 20, 20)`,
  ).run(id, fixture.workspaceId, kind, id);
  fixture.store.db.prepare(
    `INSERT INTO resource_revisions
       (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
        checksum, provenance_json, created_by_run_id, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, '{}', NULL, 21)`,
  ).run(
    revisionId,
    fixture.workspaceId,
    id,
    `assets/${id}.json`,
    id,
    JSON.stringify({ mimeType }),
    `${id}-checksum`,
  );
  fixture.store.db.prepare("UPDATE resources SET head_revision_id = ? WHERE id = ?").run(revisionId, id);
  return revisionId;
}

function addRevisionToResource(
  fixture: ReturnType<typeof createMutationFixture>,
  resourceId: string,
  revisionId: string,
  mimeType: string,
  sequence = 2,
): string {
  fixture.store.db.prepare(
    `INSERT INTO resource_revisions
       (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
        checksum, provenance_json, created_by_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, ?)`,
  ).run(
    revisionId,
    fixture.workspaceId,
    resourceId,
    sequence,
    `assets/${revisionId}.json`,
    revisionId,
    JSON.stringify({ mimeType }),
    `${revisionId}-checksum`,
    21 + sequence,
  );
  fixture.store.db.prepare("UPDATE resources SET head_revision_id = ? WHERE id = ?").run(revisionId, resourceId);
  return revisionId;
}

test("mutation request parsing is exhaustive and rejects smuggled command fields", () => {
  const request = {
    expectedHeadRevisionId: "revision",
    expectedSnapshotId: "snapshot",
    command: {
      type: "set-layout",
      locator: { designNodeId: "hero", sourcePath: "src/App.jsx", selector: "[data-dezin-id=hero]" },
      patch: { alignment: "center" },
    },
  };
  assert.deepEqual(parseArtifactMutationRequest(request), request);
  assert.throws(
    () => parseArtifactMutationRequest({ ...request, command: { ...request.command, shell: "rm -rf" } }),
    /unexpected field shell/i,
  );
  assert.throws(
    () => parseArtifactMutationRequest({ ...request, command: { ...request.command, type: "set-html" } }),
    /unsupported direct mutation command/i,
  );
  assert.throws(
    () => parseArtifactMutationRequest({ ...request, expectedSnapshotId: "" }),
    /expectedSnapshotId must be a bounded non-empty string/i,
  );
  assert.equal(parseArtifactMutationRequest({
    expectedHeadRevisionId: "revision",
    expectedSnapshotId: "snapshot",
    command: {
      type: "set-text",
      locator: { designNodeId: "headline", sourcePath: "src/App.jsx" },
      expectedCurrentValue: "Old title",
      value: "",
    },
  }).command.type, "set-text", "clearing leaf text remains a valid bounded edit");
  assert.throws(
    () => parseArtifactMutationRequest({
      expectedHeadRevisionId: "revision",
      expectedSnapshotId: "snapshot",
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "src/App.jsx" },
        value: "Replacement",
      },
    }),
    /expectedCurrentValue/i,
    "set-text must carry an exact compare-and-swap value",
  );
});

test("set-text publishes an immutable Artifact Revision without mutating the canonical checkout", async () => {
  const fixture = createMutationFixture();
  try {
    const before = {
      head: git(fixture.root, ["rev-parse", "HEAD"]),
      status: git(fixture.root, ["status", "--porcelain=v2", "--untracked-files=all"]),
      source: readFileSync(join(fixture.root, "index.html"), "utf8"),
    };

    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "A safer title & proof",
      },
    });

    assert.equal(result.revision.parentRevisionId, fixture.revision.id);
    assert.equal(result.snapshot.parentSnapshotId, fixture.snapshot.id);
    assert.equal(git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]).includes(
      ">A safer title &amp; proof</h1>",
    ), true);
    assert.deepEqual({
      head: git(fixture.root, ["rev-parse", "HEAD"]),
      status: git(fixture.root, ["status", "--porcelain=v2", "--untracked-files=all"]),
      source: readFileSync(join(fixture.root, "index.html"), "utf8"),
    }, before);
  } finally {
    fixture.close();
  }
});

test("set-text rejects a stale expected current value before creating a candidate Revision", async () => {
  const fixture = createMutationFixture();
  try {
    const beforeRevisionCount = Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
    ).get(fixture.artifactId)?.count ?? 0);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "A stale title",
        value: "Replacement",
      },
    }), ArtifactMutationConflictError);

    assert.equal(Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
    ).get(fixture.artifactId)?.count ?? 0), beforeRevisionCount);
  } finally {
    fixture.close();
  }
});

test("a locator cannot escape its Artifact source root or create a candidate Revision", async () => {
  const fixture = createMutationFixture();
  try {
    const beforeCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);
    const before = readFileSync(join(fixture.root, "index.html"), "utf8");

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "../outside.html" },
        expectedCurrentValue: "Old title",
        value: "escaped",
      },
    }), /escapes the Artifact source root/i);

    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), beforeCount);
    assert.equal(readFileSync(join(fixture.root, "index.html"), "utf8"), before);
    assert.equal(git(fixture.root, ["status", "--porcelain=v2", "--untracked-files=all"]), "");
  } finally {
    fixture.close();
  }
});

test("set-accessible-label updates only the located source element", async () => {
  const fixture = createMutationFixture();
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-accessible-label",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        value: "Primary & trusted",
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(candidate, /data-dezin-id="headline" aria-label="Primary &amp; trusted">Old title/);
    assert.doesNotMatch(candidate, /data-dezin-id="hero" aria-label=/);
  } finally {
    fixture.close();
  }
});

test("set-token writes a bounded CSS token reference on the located element", async () => {
  const fixture = createMutationFixture();
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-token",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        property: "color",
        token: "text.primary",
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(candidate, /data-dezin-id="headline" style="color: var\(--text-primary\)">Old title/);
  } finally {
    fixture.close();
  }
});

test("token and layout edits preserve valid JSX style object syntax", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.jsx",
    source: `export function App() {\n  return <section data-dezin-id="hero" style={{ display: "flex" }}><h1>Title</h1></section>;\n}\n`,
  });
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-layout",
        locator: { designNodeId: "hero", sourcePath: "src/App.jsx" },
        patch: { alignment: "center", gap: 8 },
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:src/App.jsx`]);
    assert.match(candidate, /style=\{\{ display: "flex", gap: "8px", alignItems: "center" \}\}/);
    assert.doesNotMatch(candidate, /style="/);
  } finally {
    fixture.close();
  }
});

test("set-text escapes JSX expression delimiters instead of injecting source expressions", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.jsx",
    source: `export function App() { return <h1 data-dezin-id="headline">Old</h1>; }\n`,
  });
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "src/App.jsx" },
        expectedCurrentValue: "Old",
        value: "Count {ready} & <safe>",
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:src/App.jsx`]);
    assert.match(candidate, />Count &#123;ready&#125; &amp; &lt;safe&gt;<\/h1>/);
    assert.doesNotMatch(candidate, />Count \{ready\}/);
  } finally {
    fixture.close();
  }
});

test("set-text rejects a JSX expression even when its source spelling matches the expected runtime text", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.jsx",
    source: `export function App({ title }) { return <h1 data-dezin-id="headline">{title}</h1>; }\n`,
  });
  try {
    const beforeRevisionCount = Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
    ).get(fixture.artifactId)?.count ?? 0);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "src/App.jsx" },
        expectedCurrentValue: "{title}",
        value: "Replacement",
      },
    }), /set-text only supports pure static JSX text/i);

    assert.equal(Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
    ).get(fixture.artifactId)?.count ?? 0), beforeRevisionCount);
  } finally {
    fixture.close();
  }
});

test("JSX tag scanning ignores arrow and comparison operators inside prop expressions", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.jsx",
    source: `export function App({ value }) { return <button data-dezin-id="cta" onClick={() => value > 0}>Go</button>; }\n`,
  });
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-accessible-label",
        locator: { designNodeId: "cta", sourcePath: "src/App.jsx" },
        value: "Continue",
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:src/App.jsx`]);
    assert.match(candidate, /onClick=\{\(\) => value > 0\} aria-label="Continue">Go/);
  } finally {
    fixture.close();
  }
});

test("JSX tag scanning ignores marker-like tags inside regular-expression literals", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.tsx",
    source: [
      "const matcher = /<Card data-dezin-id=\"headline\">/g;",
      "export function App() {",
      "  return <h1 data-dezin-id=\"headline\">Old</h1>;",
      "}",
    ].join("\n"),
  });
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "src/App.tsx" },
        expectedCurrentValue: "Old",
        value: "Real JSX target",
      },
    });
    const committed = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:src/App.tsx`]);
    assert.match(committed, /matcher = \/<Card data-dezin-id="headline">\/g/);
    assert.match(committed, />Real JSX target<\/h1>/);
  } finally {
    fixture.close();
  }
});

test("attribute mutation refuses to duplicate a computed JSX prop", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.jsx",
    source: `export function App({ label }) { return <button data-dezin-id="cta" aria-label={label}>Go</button>; }\n`,
  });
  try {
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-accessible-label",
        locator: { designNodeId: "cta", sourcePath: "src/App.jsx" },
        value: "Continue",
      },
    }), /direct string literal/i);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), 1);
  } finally {
    fixture.close();
  }
});

test("attribute mutation rejects JSX spreads that can shadow the bounded edit", async () => {
  const fixture = createMutationFixture({
    sourcePath: "src/App.jsx",
    source: `export function App(props) { return <button data-dezin-id="cta" aria-label="Old" {...props}>Go</button>; }\n`,
  });
  try {
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-accessible-label",
        locator: { designNodeId: "cta", sourcePath: "src/App.jsx" },
        value: "Continue",
      },
    }), /spread/i);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), 1);
  } finally {
    fixture.close();
  }
});

test("set-layout accepts only the supported layout vocabulary and serializes deterministic CSS", async () => {
  const fixture = createMutationFixture();
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-layout",
        locator: { designNodeId: "hero", sourcePath: "index.html" },
        patch: { width: "fill", padding: 16, gap: 12, alignment: "center", visibility: "hidden" },
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(candidate, /data-dezin-id="hero" style="width: 100%; padding: 16px; gap: 12px; align-items: center; visibility: hidden"/);
  } finally {
    fixture.close();
  }
});

test("set-asset accepts only an owned Resource Revision and carries its immutable pin forward", async () => {
  const fixture = createMutationFixture();
  try {
    fixture.store.db.prepare(
      `INSERT INTO resources
         (id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at)
       VALUES ('asset', ?, 'asset', 'Cover', NULL, 'pin-current', NULL, 20, 20)`,
    ).run(fixture.workspaceId);
    fixture.store.db.prepare(
      `INSERT INTO resource_revisions
         (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
          checksum, provenance_json, created_by_run_id, created_at)
       VALUES ('asset-r1', ?, 'asset', 1, 'assets/cover.json', 'Cover', '{"mimeType":"image/png"}', 'asset-checksum', '{}', NULL, 21)`,
    ).run(fixture.workspaceId);
    fixture.store.db.prepare("UPDATE resources SET head_revision_id = 'asset-r1' WHERE id = 'asset'").run();

    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "asset-r1",
      },
      resolveAssetSource: assetResolver(fixture),
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(candidate, /data-dezin-id="cover" src="\/api\/immutable-assets\/asset-r1" data-dezin-resource-revision="asset-r1"/);
    assert.deepEqual(fixture.store.workspace.listArtifactRevisionResourcePins(result.revision.id), [{
      workspaceId: fixture.workspaceId,
      ownerArtifactId: fixture.artifactId,
      revisionId: result.revision.id,
      resourceId: "asset",
      resourceRevisionId: "asset-r1",
    }]);
  } finally {
    fixture.close();
  }
});

test("set-asset consumes the complete immutable Resource payload descriptor", async () => {
  const fixture = createMutationFixture();
  try {
    const resourceRevisionId = addResourceRevision(fixture, "descriptor-asset", "image/png");
    const descriptor = assetDescriptor(fixture, resourceRevisionId);
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId,
      },
      resolveAssetSource: () => descriptor,
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(candidate, new RegExp(`src="${descriptor.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  } finally {
    fixture.close();
  }
});

test("set-asset rejects immutable descriptor drift before candidate insertion", async () => {
  const fixture = createMutationFixture();
  try {
    const resourceRevisionId = addResourceRevision(fixture, "drifting-asset", "image/png");
    const descriptor = assetDescriptor(fixture, resourceRevisionId);
    let resolutions = 0;
    const before = fixture.store.db.prepare("SELECT COUNT(*) AS count FROM artifact_revisions").get() as { count: number };
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId,
      },
      resolveAssetSource: () => (++resolutions === 1
        ? descriptor
        : { ...descriptor, payloadChecksum: "f".repeat(64) }),
    }), /immutable asset descriptor changed before candidate insertion/i);
    assert.equal(resolutions, 2);
    const after = fixture.store.db.prepare("SELECT COUNT(*) AS count FROM artifact_revisions").get() as { count: number };
    assert.equal(after.count, before.count);
  } finally {
    fixture.close();
  }
});

test("set-asset revalidates exact non-archived ownership immediately before candidate insertion", async () => {
  const fixture = createMutationFixture();
  try {
    const resourceRevisionId = addResourceRevision(fixture, "archived-asset", "image/png");
    const descriptor = assetDescriptor(fixture, resourceRevisionId);
    let resolutions = 0;
    const before = fixture.store.db.prepare("SELECT COUNT(*) AS count FROM artifact_revisions").get() as { count: number };
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId,
      },
      resolveAssetSource: () => {
        resolutions += 1;
        if (resolutions === 2) {
          fixture.store.db.prepare("UPDATE resources SET archived_at = 99 WHERE id = ?")
            .run(descriptor.resourceId);
        }
        return descriptor;
      },
    }), /missing, foreign, archived, or not an asset before candidate insertion/i);
    assert.equal(resolutions, 2);
    const after = fixture.store.db.prepare("SELECT COUNT(*) AS count FROM artifact_revisions").get() as { count: number };
    assert.equal(after.count, before.count);
  } finally {
    fixture.close();
  }
});

test("set-asset uses tag-correct attributes and rejects context-dependent source tags", async () => {
  const svg = createMutationFixture({
    sourcePath: "icon.svg",
    source: "<svg><image data-dezin-id=\"cover\" href=\"old.png\" /></svg>\n",
  });
  try {
    const revisionId = addResourceRevision(svg, "svg-image", "image/png");
    const result = await applyArtifactMutation({
      store: svg.store,
      projectRoot: svg.root,
      projectId: svg.projectId,
      artifactId: svg.artifactId,
      validateCandidateSource: svg.validateCandidateSource,
      expectedHeadRevisionId: svg.revision.id,
      expectedSnapshotId: svg.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "icon.svg" },
        resourceRevisionId: revisionId,
      },
      resolveAssetSource: assetResolver(svg),
    });
    const committed = git(svg.root, ["show", `${result.revision.sourceCommitHash}:icon.svg`]);
    assert.match(committed, /<image data-dezin-id="cover" href="\/api\/immutable-assets\/svg-image-r1"/);
    assert.doesNotMatch(committed, /\ssrc=/);
  } finally {
    svg.close();
  }

  const jsxSvg = createMutationFixture({
    sourcePath: "src/Icon.tsx",
    source: `export function Icon() { return <svg><image data-dezin-id="cover" href="old.png" /></svg>; }\n`,
  });
  try {
    const revisionId = addResourceRevision(jsxSvg, "jsx-svg-image", "image/png");
    const result = await applyArtifactMutation({
      store: jsxSvg.store,
      projectRoot: jsxSvg.root,
      projectId: jsxSvg.projectId,
      artifactId: jsxSvg.artifactId,
      validateCandidateSource: jsxSvg.validateCandidateSource,
      expectedHeadRevisionId: jsxSvg.revision.id,
      expectedSnapshotId: jsxSvg.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "src/Icon.tsx" },
        resourceRevisionId: revisionId,
      },
      resolveAssetSource: assetResolver(jsxSvg),
    });
    const committed = git(jsxSvg.root, ["show", `${result.revision.sourceCommitHash}:src/Icon.tsx`]);
    assert.match(committed, /<image data-dezin-id="cover" href="\/api\/immutable-assets\/jsx-svg-image-r1"/);
    assert.doesNotMatch(committed, /\ssrc=/);
  } finally {
    jsxSvg.close();
  }

  for (const invalid of [
    {
      sourcePath: "index.html",
      source: "<main><image data-dezin-id=\"cover\"></image></main>\n",
      label: "html-image",
    },
    {
      sourcePath: "src/App.jsx",
      source: `export function App() { return <Image data-dezin-id="cover" />; }\n`,
      label: "jsx-component-image",
    },
  ]) {
    const fixture = createMutationFixture({ sourcePath: invalid.sourcePath, source: invalid.source });
    try {
      const revisionId = addResourceRevision(fixture, invalid.label, "image/png");
      await assert.rejects(applyArtifactMutation({
        store: fixture.store,
        projectRoot: fixture.root,
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
        validateCandidateSource: fixture.validateCandidateSource,
        expectedHeadRevisionId: fixture.revision.id,
        expectedSnapshotId: fixture.snapshot.id,
        command: {
          type: "set-asset",
          locator: { designNodeId: "cover", sourcePath: invalid.sourcePath },
          resourceRevisionId: revisionId,
        },
        resolveAssetSource: assetResolver(fixture),
      }), /incompatible|SVG|component/i, invalid.label);
    } finally {
      fixture.close();
    }
  }

  const source = createMutationFixture({
    source: "<picture><source data-dezin-id=\"cover\" srcset=\"old.png\"></picture>\n",
  });
  try {
    const revisionId = addResourceRevision(source, "picture-image", "image/png");
    await assert.rejects(applyArtifactMutation({
      store: source.store,
      projectRoot: source.root,
      projectId: source.projectId,
      artifactId: source.artifactId,
      validateCandidateSource: source.validateCandidateSource,
      expectedHeadRevisionId: source.revision.id,
      expectedSnapshotId: source.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: revisionId,
      },
      resolveAssetSource: assetResolver(source),
    }), /set-asset target tag source requires parent context and is unsupported/i);
  } finally {
    source.close();
  }
});

test("set-asset rejects responsive image targets whose rendered source is context-dependent", async () => {
  for (const invalid of [
    {
      label: "html-srcset",
      sourcePath: "index.html",
      source: '<img data-dezin-id="cover" src="fallback.png" srcset="small.png 1x, large.png 2x">\n',
    },
    {
      label: "html-picture",
      sourcePath: "index.html",
      source: '<picture><source srcset="wide.png"><img data-dezin-id="cover" src="fallback.png"></picture>\n',
    },
    {
      label: "jsx-srcset",
      sourcePath: "src/App.tsx",
      source: 'export function App() { return <img data-dezin-id="cover" src="fallback.png" srcSet="wide.png 2x" />; }\n',
    },
  ]) {
    const fixture = createMutationFixture({ sourcePath: invalid.sourcePath, source: invalid.source });
    try {
      const revisionId = addResourceRevision(fixture, invalid.label, "image/png");
      await assert.rejects(applyArtifactMutation({
        store: fixture.store,
        projectRoot: fixture.root,
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
        validateCandidateSource: fixture.validateCandidateSource,
        expectedHeadRevisionId: fixture.revision.id,
        expectedSnapshotId: fixture.snapshot.id,
        command: {
          type: "set-asset",
          locator: { designNodeId: "cover", sourcePath: invalid.sourcePath },
          resourceRevisionId: revisionId,
        },
        resolveAssetSource: assetResolver(fixture),
      }), /responsive|picture|srcset/i, invalid.label);
      assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, fixture.revision.id);
    } finally {
      fixture.close();
    }
  }
});

test("set-asset replaces only the pin owned by the selected element instead of accumulating stale pins", async () => {
  const fixture = createMutationFixture();
  try {
    const firstRevisionId = addResourceRevision(fixture, "first-cover", "image/png");
    const secondRevisionId = addResourceRevision(fixture, "second-cover", "image/png");
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: firstRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });
    assert.deepEqual(first.revision.renderSpec.dezinResourceUsageLedger, {
      protocol: "dezin-resource-usage-ledger-v1",
      sourceTreeHash: first.revision.sourceTreeHash,
      usages: [{
        resourceId: "first-cover",
        resourceRevisionId: firstRevisionId,
        sourcePath: "index.html",
        designNodeId: "cover",
        attribute: "src",
      }],
    });
    assert.deepEqual(
      fixture.store.workspace.getArtifactRevision(first.revision.id)?.renderSpec,
      first.revision.renderSpec,
      "the resource usage ledger must survive the Artifact Revision codec/store roundtrip",
    );
    const second = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: secondRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });

    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionResourcePins(second.revision.id).map((pin) => ({
        resourceId: pin.resourceId,
        resourceRevisionId: pin.resourceRevisionId,
      })),
      [{ resourceId: "second-cover", resourceRevisionId: secondRevisionId }],
    );
  } finally {
    fixture.close();
  }
});

test("direct non-asset mutations rebind a valid Resource usage ledger to the new source tree", async () => {
  const fixture = createMutationFixture();
  try {
    const firstRevisionId = addResourceRevision(fixture, "rebound-cover", "image/png");
    const secondRevisionId = addResourceRevision(fixture, "replacement-cover", "image/png");
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: firstRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });
    const edited = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Ledger rebound",
      },
    });
    const firstLedger = first.revision.renderSpec.dezinResourceUsageLedger as {
      sourceTreeHash: string;
      usages: unknown[];
    };
    const editedLedger = edited.revision.renderSpec.dezinResourceUsageLedger as {
      sourceTreeHash: string;
      usages: unknown[];
    };
    assert.equal(editedLedger.sourceTreeHash, edited.revision.sourceTreeHash);
    assert.notEqual(editedLedger.sourceTreeHash, firstLedger.sourceTreeHash);
    assert.deepEqual(editedLedger.usages, firstLedger.usages);

    const replaced = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: edited.revision.id,
      expectedSnapshotId: edited.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: secondRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });
    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionResourcePins(replaced.revision.id).map((pin) => ({
        resourceId: pin.resourceId,
        resourceRevisionId: pin.resourceRevisionId,
      })),
      [{ resourceId: "replacement-cover", resourceRevisionId: secondRevisionId }],
    );
  } finally {
    fixture.close();
  }
});

test("set-asset refuses to replace one use when another element still requires the old revision of that Resource", async () => {
  const fixture = createMutationFixture({
    source: [
      '<img data-dezin-id="cover" src="/api/immutable-assets/shared-cover-r1" data-dezin-resource-revision="shared-cover-r1">',
      '<img data-dezin-id="thumbnail" src="/api/immutable-assets/shared-cover-r1" data-dezin-resource-revision="shared-cover-r1">',
    ].join("\n"),
  });
  try {
    const oldRevisionId = addResourceRevision(fixture, "shared-cover", "image/png");
    fixture.store.db.prepare(
      `INSERT INTO resource_revisions
         (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
          checksum, provenance_json, created_by_run_id, created_at)
       VALUES ('shared-cover-r2', ?, 'shared-cover', 2, 'assets/shared-cover-r2.json', 'Shared cover v2',
               '{"mimeType":"image/png"}', 'shared-cover-r2-checksum', '{}', NULL, 22)`,
    ).run(fixture.workspaceId);
    const pinnedParent = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: fixture.revision.id,
      sourceCommitHash: fixture.revision.sourceCommitHash,
      sourceTreeHash: fixture.revision.sourceTreeHash,
      kernelRevisionId: fixture.revision.kernelRevisionId,
      renderSpec: {
        ...fixture.revision.renderSpec,
        dezinResourceUsageLedger: {
          protocol: "dezin-resource-usage-ledger-v1",
          sourceTreeHash: fixture.revision.sourceTreeHash,
          usages: [
            {
              resourceId: "shared-cover",
              resourceRevisionId: oldRevisionId,
              sourcePath: "index.html",
              designNodeId: "cover",
              attribute: "src",
            },
            {
              resourceId: "shared-cover",
              resourceRevisionId: oldRevisionId,
              sourcePath: "index.html",
              designNodeId: "thumbnail",
              attribute: "src",
            },
          ],
        },
      },
      quality: fixture.revision.quality,
      dependencies: [],
      resourcePins: [{ resourceId: "shared-cover", resourceRevisionId: oldRevisionId }],
    });
    const pinnedSnapshot = fixture.store.workspace.publishArtifactRevision(pinnedParent.id, {
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
    });

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: pinnedParent.id,
      expectedSnapshotId: pinnedSnapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "shared-cover-r2",
      },
      resolveAssetSource: assetResolver(fixture),
    }), /another element still requires|two revisions/i);
    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, pinnedParent.id);

    const replacementRevisionId = addResourceRevision(fixture, "independent-cover", "image/png");
    const replacement = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: pinnedParent.id,
      expectedSnapshotId: pinnedSnapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: replacementRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });
    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionResourcePins(replacement.revision.id)
        .map((pin) => ({ resourceId: pin.resourceId, resourceRevisionId: pin.resourceRevisionId }))
        .sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
      [
        { resourceId: "independent-cover", resourceRevisionId: replacementRevisionId },
        { resourceId: "shared-cover", resourceRevisionId: oldRevisionId },
      ],
      "replacing one of several uses with a different Resource must retain the old pin",
    );
    assert.deepEqual(
      (replacement.revision.renderSpec.dezinResourceUsageLedger as { usages: unknown[] }).usages,
      [
        {
          resourceId: "independent-cover",
          resourceRevisionId: replacementRevisionId,
          sourcePath: "index.html",
          designNodeId: "cover",
          attribute: "src",
        },
        {
          resourceId: "shared-cover",
          resourceRevisionId: oldRevisionId,
          sourcePath: "index.html",
          designNodeId: "thumbnail",
          attribute: "src",
        },
      ],
    );
  } finally {
    fixture.close();
  }
});

test("set-asset keeps the old pin when CSS or JavaScript directly references its canonical Resource URL", async () => {
  const oldRevisionId = "closure-asset-r1";
  const oldUrl = `${resourcePublicRoot(oldRevisionId)}payload.png`;
  for (const [path, directReference] of [
    ["styles/theme.css", `.hero { background-image: url("${oldUrl}"); }\n`],
    ["src/resource.ts", `export const retainedAsset = ${JSON.stringify(oldUrl)};\n`],
  ] as const) {
    const fixture = createMutationFixture({
      source: `<img data-dezin-id="cover" src="${oldUrl}" data-dezin-resource-revision="${oldRevisionId}">\n`,
      extraFiles: { [path]: directReference },
    });
    try {
      assert.equal(addResourceRevision(fixture, "closure-asset", "image/png"), oldRevisionId);
      addRevisionToResource(fixture, "closure-asset", "closure-asset-r2", "image/png");
      const pinnedParent = fixture.store.workspace.createArtifactRevision({
        artifactId: fixture.revision.artifactId,
        trackId: fixture.revision.trackId,
        parentRevisionId: fixture.revision.id,
        sourceCommitHash: fixture.revision.sourceCommitHash,
        sourceTreeHash: fixture.revision.sourceTreeHash,
        kernelRevisionId: fixture.revision.kernelRevisionId,
        renderSpec: {
          ...fixture.revision.renderSpec,
          dezinResourceUsageLedger: {
            protocol: "dezin-resource-usage-ledger-v1",
            sourceTreeHash: fixture.revision.sourceTreeHash,
            usages: [{
              resourceId: "closure-asset",
              resourceRevisionId: oldRevisionId,
              sourcePath: "index.html",
              designNodeId: "cover",
              attribute: "src",
            }],
          },
        },
        quality: fixture.revision.quality,
        dependencies: [],
        resourcePins: [{ resourceId: "closure-asset", resourceRevisionId: oldRevisionId }],
      });
      const pinnedSnapshot = fixture.store.workspace.publishArtifactRevision(pinnedParent.id, {
        expectedHeadRevisionId: fixture.revision.id,
        expectedSnapshotId: fixture.snapshot.id,
      });

      await assert.rejects(applyArtifactMutation({
        store: fixture.store,
        projectRoot: fixture.root,
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
        validateCandidateSource: fixture.validateCandidateSource,
        expectedHeadRevisionId: pinnedParent.id,
        expectedSnapshotId: pinnedSnapshot.id,
        command: {
          type: "set-asset",
          locator: { designNodeId: "cover", sourcePath: "index.html" },
          resourceRevisionId: "closure-asset-r2",
        },
        resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
          `${resourcePublicRoot(resourceRevisionId)}payload.png`
        )),
      }), /still requires|directly references|two revisions/i, path);
      assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, pinnedParent.id);
    } finally {
      fixture.close();
    }
  }
});

test("set-asset cannot treat escaped and concatenated runtime references as proof that an old pin is unused", async () => {
  const oldRevisionId = "computed-closure-r1";
  const oldUrl = `${resourcePublicRoot(oldRevisionId)}payload.png`;
  const mountKey = oldUrl.split("/")[3]!;
  const hiddenRuntimeReference = [
    `const retainedAsset = "\\x2f.dezin/resources/${mountKey.slice(0, 20)}"`,
    `  + "${mountKey.slice(20)}/payload.png";`,
    "void retainedAsset;",
  ].join("\n");
  assert.equal(hiddenRuntimeReference.includes(oldUrl), false);
  assert.equal(hiddenRuntimeReference.includes(mountKey), false);
  assert.equal(Function(`${hiddenRuntimeReference}; return retainedAsset;`)(), oldUrl);

  const fixture = createMutationFixture({
    source: `<img data-dezin-id="cover" src="${oldUrl}" data-dezin-resource-revision="${oldRevisionId}">\n`,
    extraFiles: { "src/runtime-reference.js": hiddenRuntimeReference },
  });
  try {
    assert.equal(addResourceRevision(fixture, "computed-closure", "image/png"), oldRevisionId);
    addRevisionToResource(fixture, "computed-closure", "computed-closure-r2", "image/png");
    const pinnedParent = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: fixture.revision.id,
      sourceCommitHash: fixture.revision.sourceCommitHash,
      sourceTreeHash: fixture.revision.sourceTreeHash,
      kernelRevisionId: fixture.revision.kernelRevisionId,
      renderSpec: fixture.revision.renderSpec,
      quality: fixture.revision.quality,
      dependencies: [],
      resourcePins: [{ resourceId: "computed-closure", resourceRevisionId: oldRevisionId }],
    });
    const pinnedSnapshot = fixture.store.workspace.publishArtifactRevision(pinnedParent.id, {
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
    });
    const revisionCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: pinnedParent.id,
      expectedSnapshotId: pinnedSnapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "computed-closure-r2",
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    }), /resource usage ledger|unique owner/i);
    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, pinnedParent.id);
    assert.equal(fixture.store.workspace.getWorkspace(fixture.projectId)?.activeSnapshotId, pinnedSnapshot.id);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), revisionCount);
  } finally {
    fixture.close();
  }
});

test("a generated ledger cannot launder an escaped runtime reference before a same-Resource revision replacement", async () => {
  const firstRevisionId = "laundered-runtime-r1";
  const firstUrl = `${resourcePublicRoot(firstRevisionId)}payload.png`;
  const mountKey = firstUrl.split("/")[3]!;
  const fixture = createMutationFixture({
    extraFiles: {
      "src/runtime-reference.js": [
        `const retainedAsset = "\\x2f.dezin/resources/${mountKey.slice(0, 20)}"`,
        `  + "${mountKey.slice(20)}/payload.png";`,
        "void retainedAsset;",
      ].join("\n"),
    },
  });
  try {
    assert.equal(addResourceRevision(fixture, "laundered-runtime", "image/png"), firstRevisionId);
    addRevisionToResource(fixture, "laundered-runtime", "laundered-runtime-r2", "image/png");
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: firstRevisionId,
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    });
    const revisionCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "laundered-runtime-r2",
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    }), /cannot prove.*dynamic|same Resource.*revision|closure/i);
    assert.equal(fixture.store.workspace.getTrack(first.revision.trackId)?.headRevisionId, first.revision.id);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), revisionCount);
  } finally {
    fixture.close();
  }
});

test("a generated ledger cannot launder an entity, percent, and backslash-normalized Resource URL", async () => {
  const firstRevisionId = "entity-runtime-r1";
  const firstUrl = `${resourcePublicRoot(firstRevisionId)}payload.png`;
  const mountKey = firstUrl.split("/")[3]!;
  const encodedMountKey = `%${mountKey.codePointAt(0)!.toString(16)}${mountKey.slice(1)}`;
  const fixture = createMutationFixture({
    source: [
      "<!doctype html>",
      "<html><body>",
      '<h1 data-dezin-id="headline">Old title</h1>',
      '<img data-dezin-id="cover" src="old.png">',
      `<img data-dezin-id="untracked-copy" src="&#92;.dezin&#92;resources&#92;${encodedMountKey}&#92;payload.png">`,
      "</body></html>",
    ].join("\n"),
  });
  try {
    assert.equal(addResourceRevision(fixture, "entity-runtime", "image/png"), firstRevisionId);
    addRevisionToResource(fixture, "entity-runtime", "entity-runtime-r2", "image/png");
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: firstRevisionId,
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    });

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "entity-runtime-r2",
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    }), /still directly references|cannot remove the old Resource pin/i);
    assert.equal(fixture.store.workspace.getTrack(first.revision.trackId)?.headRevisionId, first.revision.id);
  } finally {
    fixture.close();
  }
});

test("a different-Resource replacement conservatively retains a pin hidden behind a dynamic reference", async () => {
  const firstRevisionId = "retained-runtime-r1";
  const firstUrl = `${resourcePublicRoot(firstRevisionId)}payload.png`;
  const mountKey = firstUrl.split("/")[3]!;
  const fixture = createMutationFixture({
    extraFiles: {
      "src/runtime-reference.js": [
        `const retainedAsset = "\\x2f.dezin/resources/${mountKey.slice(0, 20)}"`,
        `  + "${mountKey.slice(20)}/payload.png";`,
        "void retainedAsset;",
      ].join("\n"),
    },
  });
  try {
    assert.equal(addResourceRevision(fixture, "retained-runtime", "image/png"), firstRevisionId);
    const replacementRevisionId = addResourceRevision(fixture, "replacement-runtime", "image/png");
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: firstRevisionId,
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    });
    const replacement = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: replacementRevisionId,
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    });

    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionResourcePins(replacement.revision.id)
        .map((pin) => ({ resourceId: pin.resourceId, resourceRevisionId: pin.resourceRevisionId }))
        .sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
      [
        { resourceId: "replacement-runtime", resourceRevisionId: replacementRevisionId },
        { resourceId: "retained-runtime", resourceRevisionId: firstRevisionId },
      ],
    );
    assert.deepEqual(
      (replacement.revision.renderSpec.dezinResourceUsageLedger as {
        retainedPins?: Array<{ resourceId: string; resourceRevisionId: string }>;
      }).retainedPins,
      [{ resourceId: "retained-runtime", resourceRevisionId: firstRevisionId }],
    );
  } finally {
    fixture.close();
  }
});

test("a non-asset mutation rejects pinned parents that have no Resource usage ledger", async () => {
  const fixture = createMutationFixture();
  try {
    const resourceRevisionId = addResourceRevision(fixture, "missing-ledger", "image/png");
    const pinnedParent = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: fixture.revision.id,
      sourceCommitHash: fixture.revision.sourceCommitHash,
      sourceTreeHash: fixture.revision.sourceTreeHash,
      kernelRevisionId: fixture.revision.kernelRevisionId,
      renderSpec: fixture.revision.renderSpec,
      quality: fixture.revision.quality,
      dependencies: [],
      resourcePins: [{ resourceId: "missing-ledger", resourceRevisionId }],
    });
    const pinnedSnapshot = fixture.store.workspace.publishArtifactRevision(pinnedParent.id, {
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
    });
    const revisionCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: pinnedParent.id,
      expectedSnapshotId: pinnedSnapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Must not publish",
      },
    }), /Resource usage ledger.*(?:missing|required)|(?:missing|required).*Resource usage ledger/i);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), revisionCount);
  } finally {
    fixture.close();
  }
});

test("a Resource usage ledger cannot omit an Artifact Revision Resource pin", async () => {
  const fixture = createMutationFixture();
  try {
    const resourceRevisionId = addResourceRevision(fixture, "incomplete-ledger", "image/png");
    const pinnedParent = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: fixture.revision.id,
      sourceCommitHash: fixture.revision.sourceCommitHash,
      sourceTreeHash: fixture.revision.sourceTreeHash,
      kernelRevisionId: fixture.revision.kernelRevisionId,
      renderSpec: {
        ...fixture.revision.renderSpec,
        dezinResourceUsageLedger: {
          protocol: "dezin-resource-usage-ledger-v1",
          sourceTreeHash: fixture.revision.sourceTreeHash,
          usages: [],
        },
      },
      quality: fixture.revision.quality,
      dependencies: [],
      resourcePins: [{ resourceId: "incomplete-ledger", resourceRevisionId }],
    });
    const pinnedSnapshot = fixture.store.workspace.publishArtifactRevision(pinnedParent.id, {
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
    });

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: pinnedParent.id,
      expectedSnapshotId: pinnedSnapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Must not publish",
      },
    }), /Resource usage ledger.*(?:omit|complete|pin)|pin.*Resource usage ledger/i);
  } finally {
    fixture.close();
  }
});

test("set-asset rejects a Resource usage ledger copied across an external source-tree change", async () => {
  const fixture = createMutationFixture();
  try {
    const oldRevisionId = addResourceRevision(fixture, "stale-ledger-cover", "image/png");
    const nextRevisionId = addRevisionToResource(
      fixture,
      "stale-ledger-cover",
      "stale-ledger-cover-r2",
      "image/png",
    );
    const oldUrl = `${resourcePublicRoot(oldRevisionId)}payload.png`;
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: oldRevisionId,
      },
      resolveAssetSource: assetResolver(fixture, () => oldUrl),
    });
    assert.equal(
      (first.revision.renderSpec.dezinResourceUsageLedger as { sourceTreeHash: string }).sourceTreeHash,
      first.revision.sourceTreeHash,
    );

    git(fixture.root, ["checkout", "-q", first.revision.sourceCommitHash]);
    const mountKey = oldUrl.split("/")[3]!;
    writeFileSync(
      join(fixture.root, "runtime-reference.js"),
      `const retained = "\\x2f.dezin/resources/${mountKey.slice(0, 20)}" + "${mountKey.slice(20)}/payload.png";\n`,
    );
    git(fixture.root, ["add", "runtime-reference.js"]);
    git(fixture.root, ["commit", "-q", "-m", "external source change"]);
    const externalCommitHash = git(fixture.root, ["rev-parse", "HEAD"]);
    const externalParent = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: first.revision.id,
      sourceCommitHash: externalCommitHash,
      sourceTreeHash: git(fixture.root, ["rev-parse", `${externalCommitHash}^{tree}`]),
      kernelRevisionId: first.revision.kernelRevisionId,
      renderSpec: first.revision.renderSpec,
      quality: first.revision.quality,
      dependencies: [],
      resourcePins: [{ resourceId: "stale-ledger-cover", resourceRevisionId: oldRevisionId }],
    });
    const externalSnapshot = fixture.store.workspace.publishArtifactRevision(externalParent.id, {
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
    });
    const revisionCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: externalParent.id,
      expectedSnapshotId: externalSnapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: nextRevisionId,
      },
      resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
        `${resourcePublicRoot(resourceRevisionId)}payload.png`
      )),
    }), /resource usage ledger.*(?:stale|source tree)|source tree.*resource usage ledger/i);
    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, externalParent.id);
    assert.equal(fixture.store.workspace.getWorkspace(fixture.projectId)?.activeSnapshotId, externalSnapshot.id);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), revisionCount);
  } finally {
    fixture.close();
  }
});

test("all direct mutations reject a malformed Resource usage ledger before validation or publication", async () => {
  const fixture = createMutationFixture();
  try {
    const resourceRevisionId = addResourceRevision(fixture, "malformed-ledger-cover", "image/png");
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });
    const malformedParent = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: first.revision.id,
      sourceCommitHash: first.revision.sourceCommitHash,
      sourceTreeHash: first.revision.sourceTreeHash,
      kernelRevisionId: first.revision.kernelRevisionId,
      renderSpec: {
        ...first.revision.renderSpec,
        dezinResourceUsageLedger: {
          protocol: "dezin-resource-usage-ledger-v1",
          sourceTreeHash: first.revision.sourceTreeHash,
          usages: "not-an-array",
        },
      },
      quality: first.revision.quality,
      dependencies: [],
      resourcePins: [{ resourceId: "malformed-ledger-cover", resourceRevisionId }],
    });
    const malformedSnapshot = fixture.store.workspace.publishArtifactRevision(malformedParent.id, {
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
    });
    let candidateValidated = false;
    const revisionCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: malformedParent.id,
      expectedSnapshotId: malformedSnapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Must not publish",
      },
      validateCandidateSource: () => {
        candidateValidated = true;
      },
    }), /resource usage ledger usages/i);
    assert.equal(candidateValidated, false);
    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, malformedParent.id);
    assert.equal(fixture.store.workspace.getWorkspace(fixture.projectId)?.activeSnapshotId, malformedSnapshot.id);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), revisionCount);
  } finally {
    fixture.close();
  }
});

test("set-asset closure scanning cannot be disabled by Git binary classification", async () => {
  const oldRevisionId = "binary-closure-asset-r1";
  const oldUrl = `${resourcePublicRoot(oldRevisionId)}payload.png`;
  for (const variant of [
    {
      label: "gitattributes-binary-css",
      path: "styles/theme.css",
      bytes: `.hero { background-image: url("${oldUrl}"); }\n`,
      attributes: "styles/theme.css binary\n",
    },
    {
      label: "nul-detected-binary-js",
      path: "src/resource.js",
      bytes: Buffer.concat([
        Buffer.from(`export const retainedAsset = ${JSON.stringify(oldUrl)};\n`, "utf8"),
        Buffer.from([0]),
      ]),
      attributes: undefined,
    },
  ] as const) {
    const fixture = createMutationFixture({
      source: `<img data-dezin-id="cover" src="${oldUrl}" data-dezin-resource-revision="${oldRevisionId}">\n`,
      extraFiles: { [variant.path]: variant.bytes },
      ...(variant.attributes === undefined ? {} : { attributes: variant.attributes }),
    });
    try {
      assert.equal(addResourceRevision(fixture, "binary-closure-asset", "image/png"), oldRevisionId);
      addRevisionToResource(fixture, "binary-closure-asset", "binary-closure-asset-r2", "image/png");
      const pinnedParent = fixture.store.workspace.createArtifactRevision({
        artifactId: fixture.revision.artifactId,
        trackId: fixture.revision.trackId,
        parentRevisionId: fixture.revision.id,
        sourceCommitHash: fixture.revision.sourceCommitHash,
        sourceTreeHash: fixture.revision.sourceTreeHash,
        kernelRevisionId: fixture.revision.kernelRevisionId,
        renderSpec: {
          ...fixture.revision.renderSpec,
          dezinResourceUsageLedger: {
            protocol: "dezin-resource-usage-ledger-v1",
            sourceTreeHash: fixture.revision.sourceTreeHash,
            usages: [{
              resourceId: "binary-closure-asset",
              resourceRevisionId: oldRevisionId,
              sourcePath: "index.html",
              designNodeId: "cover",
              attribute: "src",
            }],
          },
        },
        quality: fixture.revision.quality,
        dependencies: [],
        resourcePins: [{ resourceId: "binary-closure-asset", resourceRevisionId: oldRevisionId }],
      });
      const pinnedSnapshot = fixture.store.workspace.publishArtifactRevision(pinnedParent.id, {
        expectedHeadRevisionId: fixture.revision.id,
        expectedSnapshotId: fixture.snapshot.id,
      });

      await assert.rejects(applyArtifactMutation({
        store: fixture.store,
        projectRoot: fixture.root,
        projectId: fixture.projectId,
        artifactId: fixture.artifactId,
        validateCandidateSource: fixture.validateCandidateSource,
        expectedHeadRevisionId: pinnedParent.id,
        expectedSnapshotId: pinnedSnapshot.id,
        command: {
          type: "set-asset",
          locator: { designNodeId: "cover", sourcePath: "index.html" },
          resourceRevisionId: "binary-closure-asset-r2",
        },
        resolveAssetSource: assetResolver(fixture, (resourceRevisionId) => (
          `${resourcePublicRoot(resourceRevisionId)}payload.png`
        )),
      }), /still requires|directly references|two revisions/i, variant.label);
      assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, pinnedParent.id);
    } finally {
      fixture.close();
    }
  }
});

test("set-asset pin reconciliation ignores unrelated tracked media larger than the text scan budget", async () => {
  const fixture = createMutationFixture({
    extraFiles: { "assets/unrelated-video.mp4": Buffer.alloc(40 * 1024 * 1024, 0xa5) },
  });
  try {
    const firstRevisionId = addResourceRevision(fixture, "large-media-cover", "image/png");
    const secondRevisionId = addRevisionToResource(
      fixture,
      "large-media-cover",
      "large-media-cover-r2",
      "image/png",
    );
    const first = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: firstRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });
    const second = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: first.revision.id,
      expectedSnapshotId: first.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: secondRevisionId,
      },
      resolveAssetSource: assetResolver(fixture),
    });

    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionResourcePins(second.revision.id).map((pin) => ({
        resourceId: pin.resourceId,
        resourceRevisionId: pin.resourceRevisionId,
      })),
      [{ resourceId: "large-media-cover", resourceRevisionId: secondRevisionId }],
    );
  } finally {
    fixture.close();
  }
});

test("a concurrent Head advance wins and the stale direct edit cannot overwrite it", async () => {
  const fixture = createMutationFixture();
  try {
    let concurrentRevisionId = "";
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "stale edit",
      },
      validateCandidateSource: () => {
        const concurrent = fixture.store.workspace.createArtifactRevision({
          artifactId: fixture.revision.artifactId,
          trackId: fixture.revision.trackId,
          parentRevisionId: fixture.revision.id,
          sourceCommitHash: fixture.revision.sourceCommitHash,
          sourceTreeHash: fixture.revision.sourceTreeHash,
          kernelRevisionId: fixture.revision.kernelRevisionId,
          renderSpec: fixture.revision.renderSpec,
          quality: fixture.revision.quality,
          dependencies: [],
          resourcePins: [],
        });
        concurrentRevisionId = concurrent.id;
        fixture.store.workspace.publishArtifactRevision(concurrent.id, {
          expectedHeadRevisionId: fixture.revision.id,
          expectedSnapshotId: fixture.snapshot.id,
        });
      },
    }), (error: unknown) => error instanceof ArtifactMutationConflictError && /Head changed after/i.test(error.message));

    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, concurrentRevisionId);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), 2, "the losing mutation must not create a candidate Revision");
    assert.equal(git(fixture.root, ["for-each-ref", "--format=%(refname)", "refs/dezin/artifact-candidates"]), "");
  } finally {
    fixture.close();
  }
});

test("a concurrent active Snapshot advance is rechecked before a candidate Revision is inserted", async () => {
  const fixture = createMutationFixture();
  try {
    let winningSnapshotId = "";
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "stale candidate",
      },
      validateCandidateSource: () => {
        const snapshot = fixture.store.workspace.publishSnapshot(fixture.projectId, {
          expectedSnapshotId: fixture.snapshot.id,
          reason: "concurrent-checkpoint",
          provenance: {
            kind: "plan-checkpoint",
            proposalId: "concurrent-proposal",
            planId: "concurrent-plan",
            checkpointId: "concurrent-checkpoint",
          },
        });
        winningSnapshotId = snapshot.id;
      },
    }), (error: unknown) => error instanceof ArtifactMutationConflictError && /Snapshot changed after/i.test(error.message));

    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, fixture.revision.id);
    assert.equal(fixture.store.workspace.getWorkspace(fixture.projectId)?.activeSnapshotId, winningSnapshotId);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), 1, "a known stale Snapshot must not create a candidate Revision");
    assert.equal(git(fixture.root, ["for-each-ref", "--format=%(refname)", "refs/dezin/artifact-candidates"]), "");
  } finally {
    fixture.close();
  }
});

test("a committed symlink cannot redirect a locator outside the Artifact source root", async () => {
  const fixture = createMutationFixture();
  try {
    writeFileSync(join(fixture.dataDir, "outside.html"), "<h1 data-dezin-id=\"headline\">Outside</h1>");
    symlinkSync("../outside.html", join(fixture.root, "linked.html"));
    git(fixture.root, ["add", "linked.html"]);
    git(fixture.root, ["commit", "-q", "-m", "add malicious source link"]);
    const linkedCommit = git(fixture.root, ["rev-parse", "HEAD"]);
    const linkedRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.revision.artifactId,
      trackId: fixture.revision.trackId,
      parentRevisionId: fixture.revision.id,
      sourceCommitHash: linkedCommit,
      sourceTreeHash: git(fixture.root, ["rev-parse", "HEAD^{tree}"]),
      kernelRevisionId: fixture.revision.kernelRevisionId,
      renderSpec: fixture.revision.renderSpec,
      quality: fixture.revision.quality,
      dependencies: [],
      resourcePins: [],
    });
    const linkedSnapshot = fixture.store.workspace.publishArtifactRevision(linkedRevision.id, {
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
    });

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: linkedRevision.id,
      expectedSnapshotId: linkedSnapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "linked.html" },
        expectedCurrentValue: "Outside",
        value: "must not escape",
      },
    }), /regular source file/i);
    assert.equal(readFileSync(join(fixture.dataDir, "outside.html"), "utf8"), "<h1 data-dezin-id=\"headline\">Outside</h1>");
  } finally {
    fixture.close();
  }
});

test("invalid UTF-8 source fails closed without creating or rewriting a candidate", async () => {
  const source = Buffer.concat([
    Buffer.from("<h1 data-dezin-id=\"headline\">Old</h1>\n", "utf8"),
    Buffer.from([0xc3, 0x28]),
  ]);
  const fixture = createMutationFixture({ source });
  try {
    const before = readFileSync(join(fixture.root, "index.html"));
    const beforeCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old",
        value: "Must not publish",
      },
    }), /valid UTF-8/i);
    assert.deepEqual(readFileSync(join(fixture.root, "index.html")), before);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), beforeCount);
    assert.equal(git(fixture.root, ["for-each-ref", "--format=%(refname)", "refs/dezin/artifact-candidates"]), "");
  } finally {
    fixture.close();
  }
});

test("direct mutation rejects an oversized tracked source before candidate validation", async () => {
  const prefix = '<h1 data-dezin-id="headline">Old</h1>\n<!--';
  const fixture = createMutationFixture({
    source: `${prefix}${"x".repeat((4 * 1024 * 1024) - prefix.length + 1)}-->\n`,
  });
  try {
    let validated = false;
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old",
        value: "Must not be read and published",
      },
      validateCandidateSource: () => {
        validated = true;
      },
    }), /source size is out of bounds/i);
    assert.equal(validated, false);
    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, fixture.revision.id);
  } finally {
    fixture.close();
  }
});

test("candidate validation fails before a candidate Revision is created", async () => {
  const fixture = createMutationFixture();
  try {
    const beforeCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "invalid candidate",
      },
      validateCandidateSource: ({ source }) => {
        assert.match(source, /invalid candidate/);
        throw new Error("candidate failed source validation");
      },
    }), /candidate failed source validation/);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), beforeCount);
    assert.equal(git(fixture.root, ["status", "--porcelain=v2", "--untracked-files=all"]), "");
  } finally {
    fixture.close();
  }
});

test("direct mutation refuses to publish when no candidate source validator is supplied", async () => {
  const fixture = createMutationFixture();
  try {
    const beforeCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count);
    const input = {
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "must be validated",
      },
    } as unknown as Parameters<typeof applyArtifactMutation>[0];
    await assert.rejects(applyArtifactMutation(input), /requires a candidate source validator/i);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count), beforeCount);
  } finally {
    fixture.close();
  }
});

test("stable locator ignores marker-like text inside attributes and mutates the real source attribute", async () => {
  const fixture = createMutationFixture({
    source: [
      "<!doctype html>",
      "<p title='x data-dezin-id=\"headline\"'>Decoy</p>",
      "<!-- data-dezin-id=\"headline\" -->",
      "<h1 data-dezin-id=\"headline\">Old</h1>",
    ].join("\n"),
  });
  try {
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old",
        value: "Real target",
      },
    });
    const candidate = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(candidate, /<p title='x data-dezin-id="headline"'>Decoy<\/p>/);
    assert.match(candidate, /<h1 data-dezin-id="headline">Real target<\/h1>/);
  } finally {
    fixture.close();
  }
});

test("attribute mutations ignore attribute-like text nested inside another literal", async () => {
  const fixture = createMutationFixture({
    source: "<button data-dezin-id=\"headline\" title=' aria-label=\"decoy\" style=\"color: red\"'>Old</button>\n",
  });
  try {
    const labelled = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-accessible-label",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        value: "Real label",
      },
    });
    const committed = git(fixture.root, ["show", `${labelled.revision.sourceCommitHash}:index.html`]);
    assert.match(committed, /title=' aria-label="decoy" style="color: red"'/);
    assert.match(committed, / aria-label="Real label">/);

    const styled = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: labelled.revision.id,
      expectedSnapshotId: labelled.snapshot.id,
      command: {
        type: "set-token",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        property: "color",
        token: "text.primary",
      },
    });
    const styledSource = git(fixture.root, ["show", `${styled.revision.sourceCommitHash}:index.html`]);
    assert.match(styledSource, /title=' aria-label="decoy" style="color: red"'/);
    assert.match(styledSource, / style="color: var\(--text-primary\)">/);
  } finally {
    fixture.close();
  }
});

test("set-text rejects executable raw-text targets", async () => {
  const fixture = createMutationFixture({
    source: "<script data-dezin-id=\"headline\">0</script>\n",
  });
  try {
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "0",
        value: "globalThis.injected = true",
      },
    }), /set-text target tag script is unsupported/i);
  } finally {
    fixture.close();
  }
});

test("attribute and style commands require an explicit safe tag allowlist", async () => {
  const fixture = createMutationFixture({ source: "<widget data-dezin-id=\"headline\">Old</widget>\n" });
  try {
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-layout",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        patch: { width: "fill" },
      },
    }), /set-layout target tag widget is unsupported/i);
  } finally {
    fixture.close();
  }
});

test("set-asset requires a media MIME and a compatible media target", async () => {
  const fixture = createMutationFixture({
    source: "<div data-dezin-id=\"cover\"></div>\n",
  });
  try {
    fixture.store.db.prepare(
      `INSERT INTO resources
         (id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at)
       VALUES ('unsafe-file', ?, 'file', 'Script', NULL, 'pin-current', NULL, 20, 20)`,
    ).run(fixture.workspaceId);
    fixture.store.db.prepare(
      `INSERT INTO resource_revisions
         (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
          checksum, provenance_json, created_by_run_id, created_at)
       VALUES ('unsafe-file-r1', ?, 'unsafe-file', 1, 'files/script.json', 'Script',
               '{"mimeType":"application/javascript"}', 'unsafe-checksum', '{}', NULL, 21)`,
    ).run(fixture.workspaceId);
    fixture.store.db.prepare(
      "UPDATE resources SET head_revision_id = 'unsafe-file-r1' WHERE id = 'unsafe-file'",
    ).run();

    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "unsafe-file-r1",
      },
      resolveAssetSource: assetResolver(fixture),
    }), /set-asset requires an image, audio, or video Resource MIME/i);
  } finally {
    fixture.close();
  }

  const nonMediaTarget = createMutationFixture({
    source: "<div data-dezin-id=\"cover\"></div>\n",
  });
  try {
    nonMediaTarget.store.db.prepare(
      `INSERT INTO resources
         (id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at)
       VALUES ('image', ?, 'asset', 'Image', NULL, 'pin-current', NULL, 20, 20)`,
    ).run(nonMediaTarget.workspaceId);
    nonMediaTarget.store.db.prepare(
      `INSERT INTO resource_revisions
         (id, workspace_id, resource_id, sequence, manifest_path, summary, metadata_json,
          checksum, provenance_json, created_by_run_id, created_at)
       VALUES ('image-r1', ?, 'image', 1, 'assets/image.json', 'Image',
               '{"mimeType":"image/png"}', 'image-checksum', '{}', NULL, 21)`,
    ).run(nonMediaTarget.workspaceId);
    nonMediaTarget.store.db.prepare("UPDATE resources SET head_revision_id = 'image-r1' WHERE id = 'image'").run();
    await assert.rejects(applyArtifactMutation({
      store: nonMediaTarget.store,
      projectRoot: nonMediaTarget.root,
      projectId: nonMediaTarget.projectId,
      artifactId: nonMediaTarget.artifactId,
      validateCandidateSource: nonMediaTarget.validateCandidateSource,
      expectedHeadRevisionId: nonMediaTarget.revision.id,
      expectedSnapshotId: nonMediaTarget.snapshot.id,
      command: {
        type: "set-asset",
        locator: { designNodeId: "cover", sourcePath: "index.html" },
        resourceRevisionId: "image-r1",
      },
      resolveAssetSource: assetResolver(nonMediaTarget),
    }), /set-asset target tag div is incompatible with image\/png/i);
  } finally {
    nonMediaTarget.close();
  }
});

test("set-asset fails closed for media MIME types without bounded structural validation", async (t) => {
  for (const [label, mimeType] of [
    ["avif", "image/avif"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["mpeg-audio", "audio/mpeg"],
    ["mp4-video", "video/mp4"],
  ] as const) {
    await t.test(label, async () => {
      const fixture = createMutationFixture();
      try {
        const resourceRevisionId = addResourceRevision(fixture, `unverified-${label}`, mimeType);
        await assert.rejects(applyArtifactMutation({
          store: fixture.store,
          projectRoot: fixture.root,
          projectId: fixture.projectId,
          artifactId: fixture.artifactId,
          validateCandidateSource: fixture.validateCandidateSource,
          expectedHeadRevisionId: fixture.revision.id,
          expectedSnapshotId: fixture.snapshot.id,
          command: {
            type: "set-asset",
            locator: { designNodeId: "cover", sourcePath: "index.html" },
            resourceRevisionId,
          },
          resolveAssetSource: assetResolver(fixture),
        }), /bounded structural validation is unavailable/i);
      } finally {
        fixture.close();
      }
    });
  }
});

test("Git hooks cannot expand a direct mutation beyond its exact source file", async () => {
  const fixture = createMutationFixture();
  try {
    const hookPath = join(fixture.root, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nprintf 'hooked\\n' > outside.txt\ngit add outside.txt\n");
    chmodSync(hookPath, 0o755);
    const referenceHookPath = join(fixture.root, ".git", "hooks", "reference-transaction");
    writeFileSync(referenceHookPath, "#!/bin/sh\nprintf 'hooked\\n' > reference-hooked.txt\n");
    chmodSync(referenceHookPath, 0o755);
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Hook-safe",
      },
    });
    assert.equal(existsSync(join(fixture.root, "outside.txt")), false);
    assert.equal(existsSync(join(fixture.root, "reference-hooked.txt")), false);
    assert.doesNotMatch(git(fixture.root, ["ls-tree", "-r", "--name-only", result.revision.sourceCommitHash]), /outside\.txt/);
  } finally {
    fixture.close();
  }
});

test("a clean filter cannot change the committed bytes after candidate validation", async () => {
  const fixture = createMutationFixture({ attributes: "index.html filter=evil\n" });
  try {
    git(fixture.root, ["config", "filter.evil.clean", "sed 's/validated/FILTERED/g'"]);
    git(fixture.root, ["config", "filter.evil.smudge", "cat"]);
    git(fixture.root, ["config", "filter.evil.required", "true"]);
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: ({ source }) => assert.match(source, /validated/),
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "validated",
      },
    });
    const committed = git(fixture.root, ["show", `${result.revision.sourceCommitHash}:index.html`]);
    assert.match(committed, />validated<\/h1>/);
    assert.doesNotMatch(committed, /FILTERED/);
  } finally {
    fixture.close();
  }
});

test("a post-insert publication failure returns an explicit retained candidate identity", async () => {
  const fixture = createMutationFixture();
  const workspace = fixture.store.workspace as unknown as {
    publishArtifactRevision: typeof fixture.store.workspace.publishArtifactRevision;
  };
  const originalPublish = workspace.publishArtifactRevision;
  try {
    workspace.publishArtifactRevision = () => {
      throw new Error("synthetic publication failure");
    };
    let candidateRevisionId = "";
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Retained candidate",
      },
    }), (error: unknown) => {
      const candidate = error as {
        name?: string;
        candidateRevisionId?: string;
        candidateRef?: string;
        cause?: unknown;
      };
      assert.equal(candidate.name, "ArtifactMutationCandidateError");
      assert.equal(typeof candidate.candidateRevisionId, "string");
      assert.match(candidate.candidateRef ?? "", /^refs\/dezin\/artifact-revisions\//);
      assert.match(String(candidate.cause), /synthetic publication failure/);
      candidateRevisionId = candidate.candidateRevisionId ?? "";
      return true;
    });
    assert.equal(fixture.store.workspace.getArtifactRevision(candidateRevisionId)?.id, candidateRevisionId);
  } finally {
    workspace.publishArtifactRevision = originalPublish;
    fixture.close();
  }
});

test("an abort after candidate insertion cannot publish and retains an inspectable candidate", async () => {
  const fixture = createMutationFixture();
  const controller = new AbortController();
  const workspace = fixture.store.workspace as unknown as {
    createArtifactRevision: typeof fixture.store.workspace.createArtifactRevision;
  };
  const originalCreate = workspace.createArtifactRevision;
  try {
    workspace.createArtifactRevision = ((input) => {
      const revision = originalCreate.call(fixture.store.workspace, input);
      controller.abort(new Error("synthetic late cancellation"));
      return revision;
    }) as typeof workspace.createArtifactRevision;
    let retainedRevisionId = "";
    let retainedRef = "";
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      signal: controller.signal,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Cancelled before publication",
      },
    }), (error: unknown) => {
      const candidate = error as {
        name?: string;
        candidateRevisionId?: string;
        candidateRef?: string;
        cause?: unknown;
      };
      assert.equal(candidate.name, "ArtifactMutationCandidateError");
      assert.match(String(candidate.cause), /synthetic late cancellation/);
      retainedRevisionId = candidate.candidateRevisionId ?? "";
      retainedRef = candidate.candidateRef ?? "";
      return true;
    });
    assert.equal(fixture.store.workspace.getTrack(fixture.revision.trackId)?.headRevisionId, fixture.revision.id);
    assert.equal(fixture.store.workspace.getWorkspace(fixture.projectId)?.activeSnapshotId, fixture.snapshot.id);
    assert.equal(fixture.store.workspace.getArtifactRevision(retainedRevisionId)?.id, retainedRevisionId);
    assert.match(git(fixture.root, ["rev-parse", retainedRef]), /^[0-9a-f]{40,64}$/);
  } finally {
    workspace.createArtifactRevision = originalCreate;
    fixture.close();
  }
});

test("a failed revision-ref write reports the candidate ref that actually exists", async () => {
  const fixture = createMutationFixture();
  try {
    const dezinRefs = join(fixture.root, ".git", "refs", "dezin");
    mkdirSync(dezinRefs, { recursive: true });
    writeFileSync(join(dezinRefs, "artifact-revisions"), "blocks-the-revision-ref-directory\n");
    let retainedRef = "";
    await assert.rejects(applyArtifactMutation({
      store: fixture.store,
      projectRoot: fixture.root,
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      validateCandidateSource: fixture.validateCandidateSource,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: { designNodeId: "headline", sourcePath: "index.html" },
        expectedCurrentValue: "Old title",
        value: "Retain the real ref",
      },
    }), (error: unknown) => {
      const candidate = error as { name?: string; candidateRef?: string; candidateRevisionId?: string };
      assert.equal(candidate.name, "ArtifactMutationCandidateError");
      assert.match(candidate.candidateRef ?? "", /^refs\/dezin\/artifact-candidates\//);
      assert.equal(typeof candidate.candidateRevisionId, "string");
      retainedRef = candidate.candidateRef ?? "";
      return true;
    });
    assert.match(git(fixture.root, ["rev-parse", retainedRef]), /^[0-9a-f]{40,64}$/);
  } finally {
    fixture.close();
  }
});
