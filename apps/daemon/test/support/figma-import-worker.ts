import { importFigmaDesignProject } from "../../src/design/figma-import.ts";
import type { FigmaRestClient } from "../../src/design/figma-rest-client.ts";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("dataDir is required");
const mode = process.argv[3] ?? "normal";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const mark = (value: string) => appendFile(join(dataDir, "figma-worker-calls.log"), `${value}\n`);
const file = {
  version: "42",
  name: "Concurrent Figma",
  editorType: "figma",
  document: { id: "0:0", name: "Concurrent Figma", type: "DOCUMENT", children: [] },
  components: {}, componentSets: {}, styles: {},
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

const result = await importFigmaDesignProject({
  dataDir,
  input: {
    schemaVersion: 1,
    idempotencyKey: "figma-cross-process-1",
    url: "https://www.figma.com/design/AbC123xyZ/Concurrent-Figma",
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
  },
});

process.stdout.write(`${JSON.stringify({ projectId: result.manifest.projectId, importId: result.manifest.importId })}\n`);
