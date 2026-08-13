import { importFigmaDesignProject } from "../../src/design/figma-import.ts";
import type { FigmaRestClient } from "../../src/design/figma-rest-client.ts";
import { access, appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("dataDir is required");
const projectId = process.argv[3];
if (!projectId) throw new Error("projectId is required");
const mode = process.argv[4] ?? "normal";
const idempotencyKey = process.argv[5] ?? "figma-cross-process-1";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const mark = (value: string) => appendFile(join(dataDir, "figma-worker-calls.log"), `${value}\n`);
const send = (message: unknown) => new Promise<void>((resolve, reject) => {
  if (!process.send) {
    resolve();
    return;
  }
  process.send(message, (error) => error ? reject(error) : resolve());
});
const slowComponents = mode === "pause-during-asset-staging"
  ? Object.fromEntries(Array.from({ length: 48 }, (_, index) => [
      `component-${String(index).padStart(2, "0")}`,
      { name: `Component ${index}`, description: "x".repeat(64 * 1024) },
    ]))
  : {};
const file = {
  version: "42",
  name: "Concurrent Figma",
  editorType: "figma",
  document: { id: "0:0", name: "Concurrent Figma", type: "DOCUMENT", children: [] },
  components: slowComponents, componentSets: {}, styles: {},
};
const client: FigmaRestClient = {
  async getMetadata() {
    if (mode === "offline") throw new Error("offline recovery must not fetch metadata");
    await mark("metadata");
    await pause();
    return { file: { version: "42" } };
  },
  async getFileVersion() {
    if (mode === "offline") throw new Error("offline recovery must not fetch file");
    await mark("file");
    await pause();
    return file;
  },
  async getLocalVariables() {
    if (mode === "offline") throw new Error("offline recovery must not fetch variables");
    await mark("variables");
    await pause();
    return { kind: "available", body: { meta: { variableCollections: {}, variables: {} } } };
  },
};

let stagingWatcher: NodeJS.Timeout | undefined;
if (mode === "pause-during-asset-staging") {
  const transactionsRoot = join(dataDir, "projects", projectId, "design", "assets", ".transactions");
  let scanning = false;
  stagingWatcher = setInterval(() => {
    if (scanning) return;
    scanning = true;
    void (async () => {
      let entries;
      try {
        entries = await readdir(transactionsRoot, { withFileTypes: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("import-")) continue;
        const transactionRoot = join(transactionsRoot, entry.name);
        try {
          await access(join(transactionRoot, "transaction.json"));
          continue;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        clearInterval(stagingWatcher);
        stagingWatcher = undefined;
        await send({ type: "asset-staging", transactionRoot });
        process.kill(process.pid, "SIGSTOP");
        return;
      }
    })().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }).finally(() => {
      scanning = false;
    });
  }, 1);
  stagingWatcher.unref();
}

const result = await importFigmaDesignProject({
  dataDir,
  projectId,
  input: {
    schemaVersion: 1,
    idempotencyKey,
    url: "https://www.figma.com/design/AbC123xyZ/Concurrent-Figma",
    anchor: { x: 0, y: 0 },
    rightsAcknowledged: true,
  },
  client,
  credentialProvider: async () => {
    if (mode === "offline") throw new Error("offline recovery must not resolve credential");
    await mark("credential");
    return {
      token: "figd_private_token_0123456789",
      mode: "personal-access-token",
      source: "local",
      subject: "pat-0123456789abcdef",
    };
  },
  now: () => 1_000,
  testHooks: {
    afterLeaseOwnerDurable: mode === "crash-before-ticket-publication"
      ? () => { process.exit(91); }
      : undefined,
    afterSnapshotRename: mode === "crash-after-snapshot"
      ? () => { process.exit(92); }
      : undefined,
    afterLeaseObservedPredecessor: mode === "notify-after-predecessor"
      ? () => send({ type: "lease-predecessor-observed" })
      : undefined,
  },
});

if (stagingWatcher) clearInterval(stagingWatcher);
process.stdout.write(`${JSON.stringify({
  projectId: result.manifest.projectId,
  importId: result.manifest.importId,
  nodeIds: result.manifest.artifacts.flatMap((artifact) => artifact.nodeId ? [artifact.nodeId] : []),
})}\n`);
