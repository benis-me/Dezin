import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { getDesignCanvas } from "../src/design/design-storage.ts";
import { getDesignProject } from "../src/design/design-project-store.ts";
import {
  FigmaImportError,
  importFigmaDesignProject,
  recoverFigmaImports,
} from "../src/design/figma-import.ts";
import type { FigmaRestClient } from "../src/design/figma-rest-client.ts";
import { FigmaUrlError } from "../src/design/figma-url.ts";
import { Store } from "../../../packages/core/src/index.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";

const execFile = promisify(execFileCallback);

const input = {
  schemaVersion: 1 as const,
  idempotencyKey: "figma-import-happy-1",
  url: "https://www.figma.com/design/AbC123xyZ/Product-System",
  depth: 4,
  rightsAcknowledged: true as const,
};

function clientFixture(calls: string[]): FigmaRestClient {
  const file = {
    version: "42",
    name: "Product System",
    role: "viewer",
    editorType: "figma",
    linkAccess: "view",
    lastModified: "2026-08-11T00:00:00Z",
    document: { id: "0:0", name: "Product System", type: "DOCUMENT", children: [] },
    components: {},
    componentSets: {},
    styles: {},
  };
  return {
    async getMetadata() {
      calls.push("metadata");
      return { file: { key: "AbC123xyZ", name: "Product System", version: "42" }, mainFileKey: "AbC123xyZ" };
    },
    async getFileVersion(request) { calls.push(`file:${request.version}`); return file; },
    async getLocalVariables() {
      calls.push("variables");
      return { kind: "unavailable", status: 403, reason: "Figma Variables are unavailable (HTTP 403)." };
    },
  };
}

async function allRegularFileText(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const path = join(root, String(entry));
    if ((await stat(path)).isFile()) chunks.push(await readFile(path, "utf8").catch(() => ""));
  }
  return chunks.join("\n");
}

test("Figma import version-fences one snapshot, publishes three material artifacts, and exact replay is offline", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-import-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const token = "figd_private_token_0123456789";
  let credentialCalls = 0;
  const options = {
    dataDir,
    input,
    client: clientFixture(calls),
    credentialProvider: async () => {
      credentialCalls += 1;
      if (credentialCalls > 1) throw new Error("ready replay must not resolve credentials");
      return {
        token,
        mode: "personal-access-token" as const,
        source: "local" as const,
        subject: "pat-0123456789abcdef",
      };
    },
    now: () => 1_000,
  };

  const first = await importFigmaDesignProject(options);
  assert.equal(first.reused, false);
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  assert.equal(first.manifest.source.resolvedVersion, "42");
  assert.equal(first.manifest.tokenAuthority, "style-values-inferred");
  assert.ok(first.manifest.incomplete.includes("variables-http-403"));
  assert.deepEqual(first.manifest.artifacts.map((artifact) => artifact.kind), [
    "raw-file", "design-document", "tokens", "components",
  ]);
  const canvas = await getDesignCanvas(dataDir, first.manifest.projectId);
  assert.deepEqual(canvas.nodes.map((node) => [node.kind, node.name]), [
    ["document", "Design.md"],
    ["file", "tokens.json"],
    ["file", "components.json"],
  ]);
  assert.equal(canvas.revision, first.manifest.canvasRevision);

  const manifestPath = join(
    dataDir, "projects", first.manifest.projectId, "design", "imports", first.manifest.importId, "manifest.json",
  );
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), first.manifest);
  assert.equal((await allRegularFileText(dataDir)).includes(token), false);

  const replay = await importFigmaDesignProject(options);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.manifest, first.manifest);
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  assert.equal((await getDesignCanvas(dataDir, first.manifest.projectId)).revision, canvas.revision);
  assert.equal(credentialCalls, 1);
});

test("normalization failures cannot persist or return PAT material embedded in hostile upstream keys", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-normalize-secret-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const token = "figd_private_token_0123456789";
  const encoded = Buffer.from(token).toString("base64");
  const client: FigmaRestClient = {
    async getMetadata() { return { file: { version: "42" } }; },
    async getFileVersion() {
      return {
        version: "42",
        name: "Hostile",
        editorType: "figma",
        document: { id: "0:0", name: "Hostile", type: "DOCUMENT", children: [] },
        components: { [token]: 1 },
        componentSets: {}, styles: {},
      };
    },
    async getLocalVariables() {
      return { kind: "available", body: { meta: { variableCollections: {}, variables: {} } } };
    },
  };
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-normalize-secret-1" },
    client,
    credentialProvider: async () => ({
      token,
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  }), (error: unknown) => error instanceof FigmaImportError
    && error.code === "upstream"
    && error.message === "Figma response could not be normalized safely"
    && !error.message.includes(token)
    && !error.message.includes(encoded));
  const durable = await allRegularFileText(dataDir);
  assert.equal(durable.includes(token), false);
  assert.equal(durable.includes(encoded), false);
});

test("credential canaries reject upstream metadata Versions before any second outbound request", async (t) => {
  for (const useBase64 of [false, true]) {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-outbound-secret-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const token = "figd_private_token_0123456789";
    const leaked = useBase64 ? Buffer.from(token).toString("base64") : token;
    let metadataCalls = 0;
    let laterCalls = 0;
    await assert.rejects(importFigmaDesignProject({
      dataDir,
      input: { ...input, idempotencyKey: `figma-outbound-secret-${useBase64}` },
      client: {
        async getMetadata() { metadataCalls += 1; return { file: { version: leaked } }; },
        async getFileVersion() { laterCalls += 1; throw new Error("must not fetch a secret-bearing Version"); },
        async getLocalVariables() { laterCalls += 1; throw new Error("must not fetch Variables"); },
      },
      credentialProvider: async () => ({
        token,
        mode: "personal-access-token",
        source: "local",
        subject: "pat-0123456789abcdef",
      }),
    }), (error: unknown) => error instanceof FigmaImportError
      && error.code === "upstream"
      && error.message === "Figma response contained credential material and was rejected");
    assert.equal(metadataCalls, 1);
    assert.equal(laterCalls, 0);
    const durable = await allRegularFileText(dataDir);
    assert.equal(durable.includes(token), false);
    assert.equal(durable.includes(Buffer.from(token).toString("base64")), false);
  }
});

test("malformed or mismatched Figma responses are fixed safe upstream failures, never request errors", async (t) => {
  const cases: Array<{ label: string; client: FigmaRestClient }> = [
    {
      label: "malformed-meta",
      client: {
        async getMetadata() { return { file: { version: 42 } }; },
        async getFileVersion() { throw new Error("must not fetch malformed metadata"); },
        async getLocalVariables() { throw new Error("must not fetch malformed metadata"); },
      },
    },
    {
      label: "mismatched-meta-key",
      client: {
        async getMetadata() { return { file: { key: "WrongKey9", version: "42" } }; },
        async getFileVersion() { throw new Error("must not fetch mismatched metadata"); },
        async getLocalVariables() { throw new Error("must not fetch mismatched metadata"); },
      },
    },
    {
      label: "malformed-file",
      client: {
        async getMetadata() { return { file: { version: "42" } }; },
        async getFileVersion() { return { version: "42", editorType: 1 }; },
        async getLocalVariables() { throw new Error("must not fetch malformed file"); },
      },
    },
  ];
  for (const fixture of cases) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-figma-${fixture.label}-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    await assert.rejects(importFigmaDesignProject({
      dataDir,
      input: { ...input, idempotencyKey: `figma-${fixture.label}-1` },
      client: fixture.client,
      credentialProvider: async () => ({
        token: "figd_private_token_0123456789",
        mode: "personal-access-token",
        source: "local",
        subject: "pat-0123456789abcdef",
      }),
    }), (error: unknown) => error instanceof FigmaImportError
      && error.code === "upstream"
      && !/invalid-input|must not fetch/.test(error.message));
  }
});

test("signed Figma scalar URLs use a safe Project and manifest title", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-scalar-url-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const remote = "Project prefix https://s3.amazonaws.com/private/render?X-Amz-Signature=secret trailing text";
  const client: FigmaRestClient = {
    async getMetadata() { return { file: { version: "42" } }; },
    async getFileVersion() {
      return {
        version: "42", name: remote, role: remote, linkAccess: remote, lastModified: remote, editorType: "figma",
        document: { id: "0:0", name: remote, type: "DOCUMENT", children: [{ id: "1:2", name: remote, type: "CANVAS" }] },
        components: { "2:2": { name: remote, key: remote } }, componentSets: {}, styles: {},
      };
    },
    async getLocalVariables() { return { kind: "available", body: { meta: { variableCollections: {}, variables: {} } } }; },
  };
  const imported = await importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-scalar-url-1" },
    client,
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  });
  assert.equal(imported.manifest.source.fileName, "Untitled Figma import");
  assert.equal((await getDesignProject(dataDir, imported.manifest.projectId))?.name, "Untitled Figma import");
  const durable = await allRegularFileText(dataDir);
  assert.equal(durable.includes("s3.amazonaws.com"), false);
  assert.equal(durable.includes("X-Amz-Signature"), false);
});

test("explicit Project names containing embedded signed URLs fail before durable or remote side effects", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-explicit-scalar-url-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: {
      ...input,
      idempotencyKey: "figma-explicit-scalar-url-1",
      name: "Prefix https://s3.amazonaws.com/private/render?X-Amz-Signature=secret suffix",
    },
    client: {
      async getMetadata() { calls += 1; throw new Error("must not fetch"); },
      async getFileVersion() { calls += 1; throw new Error("must not fetch"); },
      async getLocalVariables() { calls += 1; throw new Error("must not fetch"); },
    },
    credentialProvider: async () => { calls += 1; throw new Error("must not resolve credential"); },
  }), (error: unknown) => error instanceof FigmaImportError && error.code === "invalid-input");
  assert.equal(calls, 0);
  await assert.rejects(stat(join(dataDir, "figma-import-jobs")), { code: "ENOENT" });
});

test("configured PAT canaries reject persisted request fields before accepting a new receipt", async (t) => {
  const token = "figd_private_token_0123456789";
  const fixtures = [
    {
      label: "name",
      value: { ...input, idempotencyKey: "figma-request-canary-name-1", name: token },
    },
    {
      label: "idempotency-key",
      value: { ...input, idempotencyKey: token },
    },
    {
      label: "url-slug",
      value: {
        ...input,
        idempotencyKey: "figma-request-canary-slug-1",
        url: `https://www.figma.com/design/AbC123xyZ/${token}`,
      },
    },
  ];
  for (const fixture of fixtures) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-figma-request-canary-${fixture.label}-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    let credentialCalls = 0;
    let remoteCalls = 0;
    await assert.rejects(importFigmaDesignProject({
      dataDir,
      input: fixture.value,
      client: {
        async getMetadata() { remoteCalls += 1; throw new Error("must not fetch"); },
        async getFileVersion() { remoteCalls += 1; throw new Error("must not fetch"); },
        async getLocalVariables() { remoteCalls += 1; throw new Error("must not fetch"); },
      },
      credentialProvider: async () => {
        credentialCalls += 1;
        return {
          token,
          mode: "personal-access-token",
          source: "local",
          subject: "pat-0123456789abcdef",
        };
      },
    }), (error: unknown) => error instanceof FigmaImportError
      && error.code === "invalid-input"
      && !error.message.includes(token));
    assert.equal(credentialCalls, 1);
    assert.equal(remoteCalls, 0);
    assert.equal((await allRegularFileText(dataDir)).includes(token), false);
    assert.deepEqual(
      (await readdir(join(dataDir, "figma-import-jobs"))).filter((entry) => !entry.startsWith(".")),
      [],
    );
  }
});

test("new Figma authority directories fsync their direct parent before publication", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-directory-fsync-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const durableDirectories: Array<{ path: string; parent: string }> = [];
  const result = await importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-directory-fsync-1" },
    client: clientFixture([]),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      afterAuthorityDirectoryDurable: (path, parent) => { durableDirectories.push({ path, parent }); },
    },
  });
  const jobs = join(dataDir, "figma-import-jobs");
  const design = join(dataDir, "projects", result.manifest.projectId, "design");
  assert.ok(durableDirectories.some((entry) => entry.path === jobs && entry.parent === dataDir));
  assert.ok(durableDirectories.some((entry) => entry.path.endsWith(".lease-queue") && entry.parent === jobs));
  assert.ok(durableDirectories.some((entry) => entry.path === join(design, "imports") && entry.parent === design));
});

test("Figma metadata drift retries the entire fenced round once and then pins the second stable Version", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-drift-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const metadataVersions = ["1", "2", "2", "2"];
  const fileVersions: string[] = [];
  const client: FigmaRestClient = {
    async getMetadata() {
      const version = metadataVersions.shift()!;
      return { file: { key: "AbC123xyZ", version }, mainFileKey: "AbC123xyZ" };
    },
    async getFileVersion(request) {
      fileVersions.push(request.version);
      return {
        version: request.version,
        name: "Drifted file",
        editorType: "figma",
        document: { id: "0:0", name: "Drifted file", type: "DOCUMENT", children: [] },
        components: {}, componentSets: {}, styles: {},
      };
    },
    async getLocalVariables() {
      return { kind: "available", body: { meta: { variableCollections: {}, variables: {} } } };
    },
  };
  const result = await importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-drift-1" },
    client,
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "environment",
      subject: "pat-0123456789abcdef",
    }),
  });
  assert.deepEqual(fileVersions, ["1", "2"]);
  assert.equal(result.manifest.source.resolvedVersion, "2");
  assert.equal(metadataVersions.length, 0);
});

test("Figma branch imports fetch the branch identity and fail closed unless its mainFileKey matches", async (t) => {
  const branchInput = {
    ...input,
    idempotencyKey: "figma-branch-1",
    url: "https://www.figma.com/design/MainKey1/branch/BranchKey2/Branch-Name",
  };
  for (const [mainFileKey, succeeds] of [["MainKey1", true], ["WrongMain", false]] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-branch-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const fileRequests: Array<{ fileKey: string; branchData?: boolean }> = [];
    const client: FigmaRestClient = {
      async getMetadata(request) {
        assert.equal(request.fileKey, "BranchKey2");
        return { file: { version: "branch-v1" } };
      },
      async getFileVersion(request) {
        fileRequests.push(request);
        return {
          version: "branch-v1",
          name: "Branch Name from API",
          mainFileKey,
          editorType: "figma",
          document: { id: "0:0", name: "Branch", type: "DOCUMENT", children: [] },
          components: {}, componentSets: {}, styles: {},
        };
      },
      async getLocalVariables() {
        return { kind: "available", body: { meta: { variableCollections: {}, variables: {} } } };
      },
    };
    const operation = importFigmaDesignProject({
      dataDir,
      input: { ...branchInput, idempotencyKey: `${branchInput.idempotencyKey}-${succeeds}` },
      client,
      credentialProvider: async () => ({
        token: "figd_private_token_0123456789",
        mode: "personal-access-token",
        source: "local",
        subject: "pat-0123456789abcdef",
      }),
    });
    if (succeeds) {
      const imported = await operation;
      assert.equal(imported.manifest.source.fileKey, "MainKey1");
      assert.equal(imported.manifest.source.branchKey, "BranchKey2");
      assert.equal(imported.manifest.source.fileName, "Branch Name from API");
      assert.deepEqual(fileRequests.map(({ fileKey, branchData }) => ({ fileKey, branchData })), [
        { fileKey: "BranchKey2", branchData: true },
      ]);
    } else {
      await assert.rejects(operation, (error: unknown) =>
        error instanceof FigmaImportError && error.code === "upstream" && /main file/.test(error.message));
    }
  }
});

test("same Figma import key cannot be rebound before credentials or remote APIs are touched", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-conflict-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const base = {
    dataDir,
    input: { ...input, idempotencyKey: "figma-conflict-1" },
    client: clientFixture(calls),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token" as const,
      source: "local" as const,
      subject: "pat-0123456789abcdef",
    }),
  };
  await importFigmaDesignProject(base);
  let forbiddenCalls = 0;
  await assert.rejects(importFigmaDesignProject({
    ...base,
    input: { ...base.input, depth: 5 },
    client: {
      async getMetadata() { forbiddenCalls += 1; throw new Error("must not fetch"); },
      async getFileVersion() { forbiddenCalls += 1; throw new Error("must not fetch"); },
      async getLocalVariables() { forbiddenCalls += 1; throw new Error("must not fetch"); },
    },
    credentialProvider: async () => { forbiddenCalls += 1; throw new Error("must not resolve credential"); },
  }), (error: unknown) => error instanceof FigmaImportError && error.code === "conflict");
  assert.equal(forbiddenCalls, 0);
});

test("a crash after the atomic Asset batch resumes from staged authority without Figma or PAT access", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-crash-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const crashInput = { ...input, idempotencyKey: "figma-crash-1" };
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: crashInput,
    client: clientFixture(calls),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      simulateProcessCrash: true,
      afterPhase: (phase) => {
        if (phase === "artifacts-imported") throw new Error("simulated process exit");
      },
    },
  }), /simulated process exit/);
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  const recovered = await importFigmaDesignProject({
    dataDir,
    input: crashInput,
    client: {
      async getMetadata() { throw new Error("recovery must be offline"); },
      async getFileVersion() { throw new Error("recovery must be offline"); },
      async getLocalVariables() { throw new Error("recovery must be offline"); },
    },
    credentialProvider: async () => { throw new Error("recovery must not resolve PAT"); },
  });
  assert.equal(recovered.reused, true);
  assert.equal((await getDesignCanvas(dataDir, recovered.manifest.projectId)).revision, recovered.manifest.canvasRevision);
});

test("snapshot and final import directory rename crash windows roll forward from exact local authority", async (t) => {
  for (const window of ["snapshot", "import"] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), `dezin-figma-${window}-rename-crash-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const calls: string[] = [];
    const crashInput = { ...input, idempotencyKey: `figma-${window}-rename-crash-1` };
    await assert.rejects(importFigmaDesignProject({
      dataDir,
      input: crashInput,
      client: clientFixture(calls),
      credentialProvider: async () => ({
        token: "figd_private_token_0123456789",
        mode: "personal-access-token",
        source: "local",
        subject: "pat-0123456789abcdef",
      }),
      testHooks: {
        simulateProcessCrash: true,
        ...(window === "snapshot"
          ? { afterSnapshotRename: () => { throw new Error("crash after snapshot rename"); } }
          : { afterImportRename: () => { throw new Error("crash after import rename"); } }),
      },
    }), new RegExp(`crash after ${window} rename`));
    const recovered = await importFigmaDesignProject({
      dataDir,
      input: crashInput,
      client: {
        async getMetadata() { throw new Error("rename recovery must not fetch"); },
        async getFileVersion() { throw new Error("rename recovery must not fetch"); },
        async getLocalVariables() { throw new Error("rename recovery must not fetch"); },
      },
      credentialProvider: async () => { throw new Error("rename recovery must not resolve PAT"); },
    });
    assert.equal(recovered.reused, true);
    assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  }
});

test("startup recovery rolls a staged running receipt forward offline under its Project lease", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-startup-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const crashInput = { ...input, idempotencyKey: "figma-startup-recovery-1" };
  const calls: string[] = [];
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: crashInput,
    client: clientFixture(calls),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      simulateProcessCrash: true,
      afterSnapshotRename: () => { throw new Error("startup snapshot crash"); },
    },
  }), /startup snapshot crash/);

  let heldProjectId: string | null = null;
  const recovered = await recoverFigmaImports({
    dataDir,
    client: {
      async getMetadata() { throw new Error("startup recovery must not fetch metadata"); },
      async getFileVersion() { throw new Error("startup recovery must not fetch file"); },
      async getLocalVariables() { throw new Error("startup recovery must not fetch variables"); },
    },
    credentialProvider: async () => { throw new Error("startup recovery must not resolve PAT"); },
    withProjectLease: async (projectId, operation) => {
      assert.equal(heldProjectId, null);
      heldProjectId = projectId;
      try {
        return await operation();
      } finally {
        heldProjectId = null;
      }
    },
  });
  assert.equal(recovered.recovered.length, 1);
  assert.deepEqual(recovered.pending, []);
  assert.equal(recovered.recovered[0]?.reused, true);
  assert.equal((await getDesignCanvas(dataDir, recovered.recovered[0]!.manifest.projectId)).nodes.length, 3);
  assert.deepEqual(calls, ["metadata", "file:42", "variables", "metadata"]);
  assert.equal(heldProjectId, null);
});

test("startup recovery leaves an accepted receipt without a snapshot pending and performs zero remote or credential work", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-startup-pending-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pendingInput = { ...input, idempotencyKey: "figma-startup-pending-1" };
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: pendingInput,
    client: clientFixture([]),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      simulateProcessCrash: true,
      afterAcceptedJobPublished: () => { throw new Error("startup accepted crash"); },
    },
  }), /startup accepted crash/);
  let forbiddenCalls = 0;
  const recovered = await recoverFigmaImports({
    dataDir,
    client: {
      async getMetadata() { forbiddenCalls += 1; throw new Error("must remain offline"); },
      async getFileVersion() { forbiddenCalls += 1; throw new Error("must remain offline"); },
      async getLocalVariables() { forbiddenCalls += 1; throw new Error("must remain offline"); },
    },
    credentialProvider: async () => { forbiddenCalls += 1; throw new Error("must not resolve PAT"); },
  });
  assert.deepEqual(recovered.recovered, []);
  assert.equal(recovered.pending.length, 1);
  assert.equal(recovered.pending[0]?.idempotencyKey, pendingInput.idempotencyKey);
  assert.equal(forbiddenCalls, 0);
  await assert.rejects(stat(join(dataDir, "projects")), { code: "ENOENT" });
});

test("RuntimeSupervisor Project deletion waits for the Figma import lease through ready publication", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-project-lease-"));
  const store = new Store(":memory:");
  const supervisor = new RuntimeSupervisor({ dataDir, store });
  t.after(async () => {
    await supervisor.shutdown();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let leasedProjectId = "";
  let releaseProjectPhase!: () => void;
  const projectPhaseGate = new Promise<void>((resolve) => { releaseProjectPhase = resolve; });
  let projectPhaseEntered!: () => void;
  const projectPhase = new Promise<void>((resolve) => { projectPhaseEntered = resolve; });
  let leaseHeld = false;
  let finalizedUnderLease = false;
  const importing = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-project-lease-1" },
    client: clientFixture([]),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    withProjectLease: async (projectId, operation) => {
      leasedProjectId = projectId;
      const lease = supervisor.acquireOperationLease({ projectId });
      leaseHeld = true;
      try {
        return await operation();
      } finally {
        leaseHeld = false;
        lease.release();
      }
    },
    finalizeUnderProjectLease: (result) => {
      assert.equal(leaseHeld, true, "the final Project projection must run before releasing the lease");
      assert.equal(result.manifest.projectId, leasedProjectId);
      finalizedUnderLease = true;
    },
    testHooks: {
      afterPhase: async (phase) => {
        assert.equal(leaseHeld, true, `${phase} must run under the Project lease`);
        if (phase === "project-created") {
          projectPhaseEntered();
          await projectPhaseGate;
        }
      },
    },
  });
  await projectPhase;
  assert.ok(leasedProjectId);
  let deleted = false;
  const deleting = supervisor.releaseProject(leasedProjectId, { deleteProjectRecord: false }).then(() => {
    deleted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deleted, false, "Project deletion must wait for the admitted Figma import");
  releaseProjectPhase();
  const imported = await importing;
  await deleting;
  assert.equal(imported.manifest.projectId, leasedProjectId);
  assert.equal(finalizedUnderLease, true);
  assert.equal(leaseHeld, false);
  assert.equal(deleted, true);
  assert.equal(await getDesignProject(dataDir, leasedProjectId), null);
});

test("ready replay verifies every immutable artifact byte instead of trusting manifest metadata", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-ready-tamper-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const replayInput = { ...input, idempotencyKey: "figma-ready-tamper-1" };
  const options = {
    dataDir,
    input: replayInput,
    client: clientFixture(calls),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token" as const,
      source: "local" as const,
      subject: "pat-0123456789abcdef",
    }),
  };
  const imported = await importFigmaDesignProject(options);
  const designPath = join(
    dataDir, "projects", imported.manifest.projectId, "design", "imports", imported.manifest.importId, "derived", "Design.md",
  );
  await chmod(designPath, 0o600);
  await writeFile(designPath, "tampered\n");
  await assert.rejects(importFigmaDesignProject(options), (error: unknown) =>
    error instanceof FigmaImportError && error.code === "corrupt");
});

test("corrupt staged artifact paths fail closed before any filesystem traversal", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-path-corrupt-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const corruptInput = { ...input, idempotencyKey: "figma-path-corrupt-1" };
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: corruptInput,
    client: clientFixture([]),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      simulateProcessCrash: true,
      afterPhase: (phase) => {
        if (phase === "snapshot-staged") throw new Error("stop with staged snapshot");
      },
    },
  }), /stop with staged snapshot/);
  const receipts = (await readdir(join(dataDir, "figma-import-jobs"))).filter((entry) => !entry.startsWith("."));
  const jobPath = join(dataDir, "figma-import-jobs", receipts[0]!, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.snapshot.payloads[0].path = "../escape";
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: corruptInput,
    client: clientFixture([]),
    credentialProvider: async () => { throw new Error("corrupt replay must not resolve PAT"); },
  }), (error: unknown) => error instanceof FigmaImportError && error.code === "corrupt");
});

test("two daemon processes converge on one create-once Figma Job, Project, and Import identity", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-cross-process-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const worker = join(import.meta.dirname, "support", "figma-import-worker.ts");
  const command = ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", worker, dataDir];
  const [left, right] = await Promise.all([
    execFile(process.execPath, command, { cwd: join(import.meta.dirname, "../../..") }),
    execFile(process.execPath, command, { cwd: join(import.meta.dirname, "../../..") }),
  ]);
  const first = JSON.parse(left.stdout) as { projectId: string; importId: string };
  const second = JSON.parse(right.stdout) as typeof first;
  assert.deepEqual(second, first);
  const projects = await readdir(join(dataDir, "projects"));
  assert.deepEqual(projects, [first.projectId]);
  assert.equal((await getDesignCanvas(dataDir, first.projectId)).revision, 1);
  const calls = (await readFile(join(dataDir, "figma-worker-calls.log"), "utf8")).trim().split("\n").sort();
  assert.deepEqual(calls, ["credential", "file", "metadata", "metadata", "variables"]);
});

test("a real process exit after snapshot publication leaves a stale ticket that offline replay safely adopts", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-real-crash-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const worker = join(import.meta.dirname, "support", "figma-import-worker.ts");
  const base = ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", worker, dataDir];
  await assert.rejects(
    execFile(process.execPath, [...base, "crash-after-snapshot"], { cwd: join(import.meta.dirname, "../../..") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === 92,
  );
  const recovered = await execFile(
    process.execPath,
    [...base, "offline"],
    { cwd: join(import.meta.dirname, "../../..") },
  );
  const result = JSON.parse(recovered.stdout) as { projectId: string; importId: string };
  assert.equal((await getDesignCanvas(dataDir, result.projectId)).revision, 1);
  const calls = (await readFile(join(dataDir, "figma-worker-calls.log"), "utf8")).trim().split("\n").sort();
  assert.deepEqual(calls, ["credential", "file", "metadata", "metadata", "variables"]);
  const queue = (await readdir(join(dataDir, "figma-import-jobs"))).find((entry) => entry.endsWith(".lease-queue"));
  assert.ok(queue);
  assert.deepEqual((await readdir(join(dataDir, "figma-import-jobs", queue))).filter((entry) => entry.startsWith("ticket-")), []);
});

test("a real process exit before ticket publication leaves no corrupt official owner", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-owner-publication-crash-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const worker = join(import.meta.dirname, "support", "figma-import-worker.ts");
  const base = ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", worker, dataDir];
  await assert.rejects(
    execFile(process.execPath, [...base, "crash-before-ticket-publication"], { cwd: join(import.meta.dirname, "../../..") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === 91,
  );
  const imported = await execFile(process.execPath, [...base, "normal"], { cwd: join(import.meta.dirname, "../../..") });
  assert.ok(JSON.parse(imported.stdout).projectId);
  const queue = (await readdir(join(dataDir, "figma-import-jobs"))).find((entry) => entry.endsWith(".lease-queue"));
  assert.ok(queue);
  assert.deepEqual((await readdir(join(dataDir, "figma-import-jobs", queue))).filter((entry) => entry.startsWith(".pending-")), []);
});

test("malformed non-authoritative pending lease files age out without exhausting the queue", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-pending-gc-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const key = "figma-pending-gc-1";
  const receipt = createHash("sha256").update(`dezin-figma-import-v1\0${key}`).digest("hex");
  const queue = join(dataDir, "figma-import-jobs", `.${receipt}.lease-queue`);
  await mkdir(queue, { recursive: true, mode: 0o700 });
  const orphan = join(queue, ".pending-00000000-0000-4000-8000-000000000000");
  await writeFile(orphan, "partial", { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await utimes(orphan, old, old);
  await importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: key },
    client: clientFixture([]),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  });
  await assert.rejects(stat(orphan), { code: "ENOENT" });
});

test("live predecessor identity checks are throttled while the ticket remains alive", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-ticket-throttle-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let entered!: () => void;
  const metadataEntered = new Promise<void>((resolve) => { entered = resolve; });
  let firstMetadata = true;
  const fixture = clientFixture([]);
  const leader = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-throttle-1" },
    client: {
      ...fixture,
      async getMetadata(request) {
        if (firstMetadata) {
          firstMetadata = false;
          entered();
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
        }
        return fixture.getMetadata(request);
      },
    },
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  });
  await metadataEntered;
  let checks = 0;
  const follower = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-throttle-1" },
    client: clientFixture([]),
    credentialProvider: async () => { throw new Error("follower must remain offline"); },
    testHooks: { afterLeaseProcessIdentityCheck: () => { checks += 1; } },
  });
  await leader;
  await follower;
  assert.ok(checks >= 1);
  assert.ok(checks <= 2, `expected at most two /bin/ps identity checks, received ${checks}`);
});

test("waiting for a live import ticket is AbortSignal-aware and never touches credentials", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-ticket-abort-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let releaseMetadata!: () => void;
  const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  let enteredMetadata!: () => void;
  const metadataEntered = new Promise<void>((resolve) => { enteredMetadata = resolve; });
  const calls: string[] = [];
  const firstClient = clientFixture(calls);
  const first = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-abort-1" },
    client: {
      ...firstClient,
      async getMetadata(request) {
        enteredMetadata();
        await metadataGate;
        return firstClient.getMetadata(request);
      },
    },
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  });
  await metadataEntered;
  let forbiddenCalls = 0;
  const controller = new AbortController();
  const second = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-abort-1" },
    client: clientFixture([]),
    credentialProvider: async () => {
      forbiddenCalls += 1;
      throw new Error("waiting replay must not resolve credentials");
    },
    signal: controller.signal,
  });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(
    Promise.race([
      second,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort was not observed")), 250)),
    ]),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(forbiddenCalls, 0);
  releaseMetadata();
  await first;
});

test("a waiter rescans when its observed predecessor releases before owner read", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-ticket-handoff-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let releaseMetadata!: () => void;
  const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  let enteredMetadata!: () => void;
  const metadataEntered = new Promise<void>((resolve) => { enteredMetadata = resolve; });
  const fixture = clientFixture([]);
  const leader = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-handoff-1" },
    client: {
      ...fixture,
      async getMetadata(request) {
        enteredMetadata();
        await metadataGate;
        return fixture.getMetadata(request);
      },
    },
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
  });
  await metadataEntered;
  let observed!: () => void;
  const predecessorObserved = new Promise<void>((resolve) => { observed = resolve; });
  let allowOwnerRead!: () => void;
  const ownerReadGate = new Promise<void>((resolve) => { allowOwnerRead = resolve; });
  const follower = importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-handoff-1" },
    client: clientFixture([]),
    credentialProvider: async () => { throw new Error("ready follower must remain offline"); },
    testHooks: {
      afterLeaseObservedPredecessor: async () => {
        observed();
        await ownerReadGate;
      },
    },
  });
  await Promise.race([
    predecessorObserved,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waiter did not observe predecessor")), 250)),
  ]);
  releaseMetadata();
  const imported = await leader;
  allowOwnerRead();
  const replay = await follower;
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.manifest, imported.manifest);
});

test("lease fencing rejects a replaced ticket and the old owner never deletes the replacement", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-ticket-fence-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let replacementPath = "";
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: { ...input, idempotencyKey: "figma-ticket-fence-1" },
    client: clientFixture([]),
    credentialProvider: async () => ({
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    }),
    testHooks: {
      afterPhase: async (phase) => {
        if (phase !== "snapshot-staged") return;
        const jobsRoot = join(dataDir, "figma-import-jobs");
        const queue = (await readdir(jobsRoot)).find((entry) => entry.endsWith(".lease-queue"));
        assert.ok(queue);
        const queueRoot = join(jobsRoot, queue);
        const ticket = (await readdir(queueRoot)).find((entry) => entry.startsWith("ticket-"));
        assert.ok(ticket);
        replacementPath = join(queueRoot, ticket);
        const owner = JSON.parse(await readFile(replacementPath, "utf8"));
        await rm(replacementPath);
        await writeFile(replacementPath, `${JSON.stringify({ ...owner, nonce: "00000000-0000-4000-8000-000000000000" })}\n`, { mode: 0o600 });
      },
    },
  }), (error: unknown) => error instanceof FigmaImportError && error.code === "corrupt");
  assert.ok(replacementPath);
  assert.equal((await stat(replacementPath)).isFile(), true);
  await assert.rejects(stat(join(dataDir, "projects")), { code: "ENOENT" });
});

test("oversized explicit Node ids fail before credential or remote side effects", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-figma-node-budget-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(importFigmaDesignProject({
    dataDir,
    input: {
      ...input,
      idempotencyKey: "figma-node-budget-1",
      nodeIds: [`1:${"7".repeat(128)}`],
    },
    client: {
      async getMetadata() { calls += 1; throw new Error("must not fetch"); },
      async getFileVersion() { calls += 1; throw new Error("must not fetch"); },
      async getLocalVariables() { calls += 1; throw new Error("must not fetch"); },
    },
    credentialProvider: async () => { calls += 1; throw new Error("must not resolve credential"); },
  }), (error: unknown) => error instanceof FigmaUrlError);
  assert.equal(calls, 0);
  await assert.rejects(stat(join(dataDir, "figma-import-jobs")), { code: "ENOENT" });
});
