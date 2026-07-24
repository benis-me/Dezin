import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { applyArtifactMutation } from "../src/artifact-mutation.ts";
import {
  ArtifactElementSelectionProvenanceError,
  resolveArtifactElementSelectionProvenance,
} from "../src/orchestration/artifact-element-selection-provenance.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFlatSelectionFixture(options: {
  contextPackHash?: string | null;
  renderEntry?: string;
  canonicalRootExists?: boolean;
  blockingCanonicalAncestor?: boolean;
  generatedDependencyFiles?: number;
  markerSourcePath?: string;
  canonicalSource?: boolean;
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-flat-selection-provenance-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Flat selection provenance", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const artifactId = "flat-selection-component";
  const trackId = "flat-selection-component-track";
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-flat-selection-component",
      type: "add-node",
      node: {
        id: "flat-selection-component-node",
        kind: "component",
        name: "Flat Selection Component",
        artifactId,
        createIdentity: { initialTrackId: trackId },
      },
    }],
  });
  const artifact = store.workspace.getArtifact(artifactId)!;
  const repository = join(dataDir, "projects", project.id);
  mkdirSync(repository, { recursive: true });
  const markerSourcePath = options.markerSourcePath ?? (options.canonicalSource ? "src/App.jsx" : "index.html");
  const markerRepositoryPath = options.canonicalSource
    ? join(artifact.sourceRoot, markerSourcePath)
    : markerSourcePath;
  mkdirSync(join(repository, markerRepositoryPath, ".."), { recursive: true });
  writeFileSync(join(repository, "index.html"), "<!doctype html><main>Preview</main>\n", "utf8");
  writeFileSync(
    join(repository, markerRepositoryPath),
    "<button data-dezin-id=\"flat-action\">Continue</button>\n",
    "utf8",
  );
  const generatedDependencyFiles = options.generatedDependencyFiles ?? 0;
  if (generatedDependencyFiles > 0) {
    const dependencyRoot = join(repository, "node_modules", "fixture-package");
    mkdirSync(dependencyRoot, { recursive: true });
    for (let index = 0; index < generatedDependencyFiles; index += 1) {
      writeFileSync(join(dependencyRoot, `generated-${index}.js`), `export default ${index};\n`, "utf8");
    }
  }
  if (options.canonicalRootExists && !options.canonicalSource) {
    const canonicalRoot = join(repository, artifact.sourceRoot);
    mkdirSync(canonicalRoot, { recursive: true });
    writeFileSync(join(canonicalRoot, "placeholder.txt"), "canonical root exists\n", "utf8");
  }
  if (options.blockingCanonicalAncestor) {
    writeFileSync(
      join(repository, artifact.sourceRoot.split("/", 1)[0]!),
      "not a directory\n",
      "utf8",
    );
  }
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "Dezin Test"]);
  git(repository, ["config", "user.email", "dezin-test@example.invalid"]);
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "-q", "-m", "flat generated component"]);
  const sourceCommitHash = git(repository, ["rev-parse", "HEAD"]);
  const revision = store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash,
    sourceTreeHash: git(repository, ["rev-parse", "HEAD^{tree}"]),
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { entry: options.renderEntry ?? markerSourcePath },
    quality: { state: "unassessed", score: null, findings: [] },
    contextPackHash: options.contextPackHash === undefined ? "f".repeat(64) : options.contextPackHash,
    dependencies: [],
    resourcePins: [],
  });
  const snapshot = store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  return {
    dataDir,
    store,
    projectId: project.id,
    workspaceId: initial.id,
    artifactId,
    artifact,
    revision,
    snapshot,
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("selection provenance indexes older flat Context-Pack revisions from their physical root", async () => {
  const fixture = createFlatSelectionFixture();
  try {
    const manifest = await resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    });

    assert.equal(manifest.sourceArtifactId, fixture.artifactId);
    assert.equal(manifest.sourceArtifactRevisionId, fixture.revision.id);
    assert.equal(manifest.sourcePath, "index.html");
    assert.match(manifest.selectionManifestHash, /^[0-9a-f]{64}$/);
    assert.equal(
      fixture.store.workspace.getArtifactRevision(fixture.revision.id)?.artifactRoot,
      fixture.artifact.sourceRoot,
      "selection compatibility must not rewrite sealed Revision ownership",
    );
  } finally {
    fixture.close();
  }
});

test("selection provenance excludes generated dependency roots before flat file-budget accounting", async () => {
  const fixture = createFlatSelectionFixture({
    generatedDependencyFiles: 4_097,
    markerSourcePath: "src/components/FullBleedMediaStage.jsx",
  });
  try {
    const manifest = await resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    });

    assert.equal(manifest.sourcePath, "src/components/FullBleedMediaStage.jsx");
  } finally {
    fixture.close();
  }
});

test("canonical-root provenance returns an Artifact-relative path accepted by direct mutation", async () => {
  const fixture = createFlatSelectionFixture({ canonicalSource: true });
  try {
    const manifest = await resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    });

    assert.equal(manifest.sourcePath, "src/App.jsx");
    const result = await applyArtifactMutation({
      store: fixture.store,
      projectRoot: join(fixture.dataDir, "projects", fixture.projectId),
      projectId: fixture.projectId,
      artifactId: fixture.artifactId,
      expectedHeadRevisionId: fixture.revision.id,
      expectedSnapshotId: fixture.snapshot.id,
      command: {
        type: "set-text",
        locator: {
          designNodeId: manifest.designNodeId,
          sourcePath: manifest.sourcePath,
        },
        expectedCurrentValue: "Continue",
        value: "Continue now",
      },
      validateCandidateSource: () => {},
    });
    assert.match(
      git(
        join(fixture.dataDir, "projects", fixture.projectId),
        ["show", `${result.revision.sourceCommitHash}:${fixture.artifact.sourceRoot}/${manifest.sourcePath}`],
      ),
      /Continue now/,
    );
  } finally {
    fixture.close();
  }
});

test("selection provenance rejects flat fallback without Context-Pack ownership", async () => {
  const fixture = createFlatSelectionFixture({ contextPackHash: null });
  try {
    await assert.rejects(resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    }), (error: unknown) => {
      assert.ok(error instanceof ArtifactElementSelectionProvenanceError);
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /Artifact source root is unavailable/i);
      assert.doesNotMatch(error.message, new RegExp(fixture.dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  } finally {
    fixture.close();
  }
});

test("selection provenance requires the declared flat render entry", async () => {
  const fixture = createFlatSelectionFixture({ renderEntry: "missing-preview.html" });
  try {
    await assert.rejects(resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    }), (error: unknown) => {
      assert.ok(error instanceof ArtifactElementSelectionProvenanceError);
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /flat generation entry is unavailable/i);
      assert.doesNotMatch(error.message, new RegExp(fixture.dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  } finally {
    fixture.close();
  }
});

test("selection provenance never falls back when the canonical Artifact root exists", async () => {
  const fixture = createFlatSelectionFixture({ canonicalRootExists: true });
  try {
    await assert.rejects(resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    }), (error: unknown) => {
      assert.ok(error instanceof ArtifactElementSelectionProvenanceError);
      assert.equal(error.code, "not-found");
      return true;
    });
  } finally {
    fixture.close();
  }
});

test("selection provenance rejects a blob that blocks the canonical Artifact root", async () => {
  const fixture = createFlatSelectionFixture({ blockingCanonicalAncestor: true });
  try {
    await assert.rejects(resolveArtifactElementSelectionProvenance({
      store: fixture.store,
      dataDir: fixture.dataDir,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      revisionId: fixture.revision.id,
      designNodeId: "flat-action",
      signal: new AbortController().signal,
    }), (error: unknown) => {
      assert.ok(error instanceof ArtifactElementSelectionProvenanceError);
      assert.equal(error.code, "invalid-source");
      assert.match(error.message, /source root.*(?:ancestor|directory)/i);
      assert.doesNotMatch(error.message, new RegExp(fixture.dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  } finally {
    fixture.close();
  }
});
