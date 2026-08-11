import assert from "node:assert/strict";
import test from "node:test";

import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_MATERIAL_NODE_KINDS,
  DESIGN_NODE_KINDS,
  DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
  DESIGN_SCHEMA_VERSION,
} from "../src/index.ts";
import type {
  DesignAgentTurnResult,
  DesignCanvas,
  DesignGenerativeNodeKind,
  DesignJob,
  DesignJobRetryResult,
  DesignMaterialNodeKind,
  DesignNode,
  DesignNodeKind,
  DesignNodeVersion,
  DesignProjectBootstrapInput,
  DesignProjectBootstrapJob,
  DesignProjectBootstrapResult,
  DesignThread,
} from "../src/index.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

type ExpectedGenerativeKind =
  | "component"
  | "page"
  | "design-system"
  | "research"
  | "design-tokens"
  | "design-document"
  | "layout"
  | "knowledge";
type ExpectedMaterialKind = "image" | "video" | "document" | "file";
type ExpectedNodeKind = ExpectedGenerativeKind | ExpectedMaterialKind;

type GenerativeKindsAreExact = Expect<Equal<DesignGenerativeNodeKind, ExpectedGenerativeKind>>;
type MaterialKindsAreExact = Expect<Equal<DesignMaterialNodeKind, ExpectedMaterialKind>>;
type NodeKindsAreExact = Expect<Equal<DesignNodeKind, ExpectedNodeKind>>;
type NodeHasNoUnprojectedLastReady = Expect<
  Equal<"lastReadyVersionId" extends keyof DesignNode ? true : false, false>
>;
type CanvasSchemaVersionIsExact = Expect<
  Equal<DesignCanvas["schemaVersion"], typeof DESIGN_SCHEMA_VERSION>
>;
type JobAuthorityIsRequired = Expect<Equal<
  Pick<DesignJob, "schemaVersion" | "canvasRevision" | "expectedHeadVersionId" | "cancelRequested">,
  {
    schemaVersion: 2;
    canvasRevision: number | null;
    expectedHeadVersionId: string | null;
    cancelRequested: boolean;
  }
>>;

const node = {
  id: "node-1",
  kind: "component",
  name: "Button",
  geometry: { x: 10, y: 20, width: 320, height: 240 },
  state: "ready",
  currentVersionId: "version-1",
  selectedVersionId: null,
  versionCount: 1,
  assetId: null,
  activeJobId: null,
  error: null,
  createdAt: 1,
  updatedAt: 2,
} satisfies DesignNode;

const canvas = {
  schemaVersion: 2,
  projectId: "project-1",
  revision: 3,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodeOrder: [node.id],
  nodes: [node],
  undoDepth: 1,
  redoDepth: 0,
  createdAt: 1,
  updatedAt: 2,
} satisfies DesignCanvas;

const version = {
  id: "version-1",
  nodeId: node.id,
  sequence: 1,
  contentKind: "html",
  assetId: null,
  mimeType: "text/html",
  fileName: "index.html",
  checksum: "sha256:example",
  bytes: 42,
  contextHash: null,
  jobId: "job-1",
  runnerId: "runner-1",
  model: "model-1",
  createdAt: 2,
} satisfies DesignNodeVersion;

const thread = {
  schemaVersion: DESIGN_SCHEMA_VERSION,
  id: "thread-1",
  scope: { type: "node", nodeId: node.id },
  messages: [
    { id: "message-1", role: "user", content: "Refine it", jobId: "job-1", createdAt: 1 },
  ],
  createdAt: 1,
  updatedAt: 2,
} satisfies DesignThread;

const job = {
  schemaVersion: DESIGN_SCHEMA_VERSION,
  id: "job-1",
  kind: "node-generation",
  runnerId: "runner-1",
  model: "model-1",
  status: "ready",
  nodeId: node.id,
  parentJobId: null,
  contextHash: null,
  canvasRevision: canvas.revision,
  expectedHeadVersionId: null,
  versionId: version.id,
  exportId: null,
  error: null,
  cancelRequested: false,
  conversationOnly: false,
  activity: [{ id: "activity-1", kind: "status", text: "Ready", createdAt: 2 }],
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 2,
} satisfies DesignJob;

const turn = { thread, job, canvas } satisfies DesignAgentTurnResult;
const retry = { retryOfJobId: "job-0", thread, job, canvas } satisfies DesignJobRetryResult;
const bootstrapInput = {
  schemaVersion: 1,
  idempotencyKey: "home-contract-1",
  name: "Contract project",
  prompt: "Create it",
  items: [],
} satisfies DesignProjectBootstrapInput;
const bootstrapJob = {
  schemaVersion: 1,
  id: "bootstrap-1",
  projectId: "project-1",
  requestHash: "0".repeat(64),
  status: "ready",
  completedPhase: "ready",
  mainJobId: "job-1",
  error: null,
  createdAt: 1,
  updatedAt: 2,
} satisfies DesignProjectBootstrapJob;
const bootstrap = { job: bootstrapJob, reused: false } satisfies DesignProjectBootstrapResult;

void (0 as unknown as GenerativeKindsAreExact);
void (0 as unknown as MaterialKindsAreExact);
void (0 as unknown as NodeKindsAreExact);
void (0 as unknown as NodeHasNoUnprojectedLastReady);
void (0 as unknown as CanvasSchemaVersionIsExact);
void (0 as unknown as JobAuthorityIsRequired);

test("node kind partitions are exact, ordered, and exhaustive", () => {
  assert.deepEqual(DESIGN_GENERATIVE_NODE_KINDS, [
    "component",
    "page",
    "design-system",
    "research",
    "design-tokens",
    "design-document",
    "layout",
    "knowledge",
  ]);
  assert.deepEqual(DESIGN_MATERIAL_NODE_KINDS, ["image", "video", "document", "file"]);
  assert.deepEqual(DESIGN_NODE_KINDS, [
    ...DESIGN_GENERATIVE_NODE_KINDS,
    ...DESIGN_MATERIAL_NODE_KINDS,
  ]);
});

test("representative wire DTOs retain their public shape", () => {
  assert.equal(DESIGN_SCHEMA_VERSION, 2);
  assert.equal(canvas.nodes[0]?.currentVersionId, version.id);
  assert.equal(turn.job.versionId, version.id);
  assert.equal(turn.job.canvasRevision, canvas.revision);
  assert.equal(turn.job.cancelRequested, false);
  assert.equal(retry.retryOfJobId, "job-0");
  assert.equal(thread.scope.type, "node");
  assert.equal(DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION, 1);
  assert.equal(bootstrap.job.projectId, "project-1");
  assert.equal(bootstrapInput.items.length, 0);
});
