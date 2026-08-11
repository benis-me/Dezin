import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DESIGN_NODE_KINDS,
  DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
} from "@dezin/design-canvas-contracts";
import type {
  DesignCanvasAssetImportItem,
  DesignNodeGeometry,
  DesignProjectBootstrapInput,
  DesignProjectBootstrapJob,
  DesignProjectBootstrapPhase,
  DesignProjectBootstrapResult,
} from "@dezin/design-canvas-contracts";

export type {
  DesignProjectBootstrapInput,
  DesignProjectBootstrapJob,
  DesignProjectBootstrapPhase,
  DesignProjectBootstrapResult,
} from "@dezin/design-canvas-contracts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ASSET_ITEMS = 32;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BATCH_BYTES = 64 * 1024 * 1024;
const BOOTSTRAP_PHASES = new Set<DesignProjectBootstrapPhase>([
  "accepted",
  "project-created",
  "assets-imported",
  "main-reserved",
  "ready",
]);
const bootstrapLocks = new Map<string, Promise<void>>();

interface StoredStagedBytesSource {
  kind: "staged-bytes";
  sha256: string;
  bytes: number;
}

interface StoredProjectVersionSource {
  kind: "project-version";
  projectId: string;
  nodeId: string;
  versionId: string;
}

interface StoredDesignCanvasAssetImportItem {
  asset: {
    name: string;
    mimeType: string;
    source: StoredStagedBytesSource | StoredProjectVersionSource;
  };
  binding: DesignCanvasAssetImportItem["binding"];
}

interface StoredDesignProjectBootstrapRequest {
  schemaVersion: typeof DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION;
  idempotencyKey: string;
  name: string;
  prompt: string;
  items: StoredDesignCanvasAssetImportItem[];
  agent?: { agentCommand?: string; model?: string | null };
}

interface StoredDesignProjectBootstrapJob extends DesignProjectBootstrapJob {
  request: StoredDesignProjectBootstrapRequest;
}

interface PreparedBootstrapInput {
  request: StoredDesignProjectBootstrapRequest;
  payloads: Map<string, Buffer>;
}

export interface DesignProjectBootstrapPorts {
  ensureProject(input: { projectId: string; name: string; createdAt: number }): Promise<void>;
  ensureAssetBatch(input: {
    projectId: string;
    idempotencyKey: string;
    requestHash: string;
    items: readonly DesignCanvasAssetImportItem[];
  }): Promise<void>;
  ensureMainTurn(input: {
    projectId: string;
    idempotencyKey: string;
    prompt: string;
    agent?: { agentCommand?: string; model?: string | null };
  }): Promise<{ jobId: string }>;
}

export interface BootstrapDesignProjectOptions {
  dataDir: string;
  input: DesignProjectBootstrapInput;
  ports: DesignProjectBootstrapPorts;
  now?: () => number;
  testHooks?: {
    afterPhase?: (phase: DesignProjectBootstrapPhase) => void | Promise<void>;
    simulateProcessCrash?: boolean;
    assetByteLimits?: { perAsset: number; batch: number };
  };
}

export class DesignProjectBootstrapError extends Error {
  readonly code: "invalid-input" | "conflict" | "corrupt" | "failed";
  readonly job: DesignProjectBootstrapJob | null;

  constructor(
    code: DesignProjectBootstrapError["code"],
    message: string,
    job: DesignProjectBootstrapJob | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignProjectBootstrapError";
    this.code = code;
    this.job = job;
  }
}

function publicJob(job: StoredDesignProjectBootstrapJob): DesignProjectBootstrapJob {
  const { request: _request, ...result } = job;
  return result;
}

type InputFailure = (message: string) => never;

function invalidInput(message: string): never {
  throw new DesignProjectBootstrapError("invalid-input", message);
}

function corruptInput(message: string): never {
  throw new DesignProjectBootstrapError("corrupt", message);
}

function exactRecord(
  value: unknown,
  label: string,
  fields: readonly string[],
  fail: InputFailure,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !fields.includes(field))) fail(`${label} schema is invalid`);
  return record;
}

function boundedString(value: unknown, label: string, maxBytes: number, fail: InputFailure): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > maxBytes) {
    fail(`${label} is invalid`);
  }
  return (value as string).trim();
}

function safeSegment(value: unknown, label: string, fail: InputFailure): string {
  const result = boundedString(value, label, 128, fail);
  if (!SAFE_SEGMENT.test(result)) fail(`${label} is invalid`);
  return result;
}

function normalizedAgent(
  value: unknown,
  fail: InputFailure,
): StoredDesignProjectBootstrapRequest["agent"] {
  if (value === undefined) return undefined;
  const record = exactRecord(value, "Design Project bootstrap Agent selection", ["agentCommand", "model"], fail);
  const agentCommand = record.agentCommand === undefined
    ? undefined
    : boundedString(record.agentCommand, "Design Agent command", 512, fail);
  const model = record.model === undefined || record.model === null
    ? record.model as undefined | null
    : boundedString(record.model, "Design Agent model", 512, fail);
  return {
    ...(agentCommand === undefined ? {} : { agentCommand }),
    ...(model === undefined ? {} : { model }),
  };
}

function normalizedGeometry(
  value: unknown,
  label: string,
  fail: InputFailure,
): Partial<DesignNodeGeometry> | undefined {
  if (value === undefined) return undefined;
  const record = exactRecord(value, label, ["x", "y", "width", "height"], fail);
  for (const [field, coordinate] of Object.entries(record)) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) fail(`${label}.${field} is invalid`);
  }
  return {
    ...(record.x === undefined ? {} : { x: record.x as number }),
    ...(record.y === undefined ? {} : { y: record.y as number }),
    ...(record.width === undefined ? {} : { width: record.width as number }),
    ...(record.height === undefined ? {} : { height: record.height as number }),
  };
}

function normalizedBinding(
  value: unknown,
  label: string,
  fail: InputFailure,
): DesignCanvasAssetImportItem["binding"] {
  const binding = exactRecord(value, label, ["type", "node", "nodeId"], fail);
  const type = boundedString(binding.type, `${label}.type`, 32, fail);
  if (type === "append-version") {
    if (binding.node !== undefined) fail(`${label}.node is invalid for append-version`);
    return { type, nodeId: safeSegment(binding.nodeId, `${label}.nodeId`, fail) };
  }
  if (type !== "create-node" || binding.nodeId !== undefined) fail(`${label}.type is unsupported`);
  const node = exactRecord(binding.node, `${label}.node`, ["id", "kind", "name", "geometry"], fail);
  const kind = boundedString(node.kind, `${label}.node.kind`, 64, fail);
  if (!(DESIGN_NODE_KINDS as readonly string[]).includes(kind)) fail(`${label}.node.kind is unsupported`);
  const geometry = normalizedGeometry(node.geometry, `${label}.node.geometry`, fail);
  return {
    type: "create-node",
    node: {
      ...(node.id === undefined ? {} : { id: safeSegment(node.id, `${label}.node.id`, fail) }),
      kind: kind as (typeof DESIGN_NODE_KINDS)[number],
      ...(node.name === undefined ? {} : { name: boundedString(node.name, `${label}.node.name`, 240, fail) }),
      ...(geometry === undefined ? {} : { geometry }),
    },
  };
}

function prepareInput(
  input: DesignProjectBootstrapInput,
  limits = { perAsset: MAX_ASSET_BYTES, batch: MAX_ASSET_BATCH_BYTES },
): PreparedBootstrapInput {
  const root = exactRecord(input, "Design Project bootstrap input", [
    "schemaVersion", "idempotencyKey", "name", "prompt", "items", "agent",
  ], invalidInput);
  if (root.schemaVersion !== DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION
    || typeof root.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(root.idempotencyKey)
    || typeof root.prompt !== "string" || Buffer.byteLength(root.prompt.trim(), "utf8") > 256 * 1024
    || !Array.isArray(root.items) || root.items.length > MAX_ASSET_ITEMS
    || !Number.isSafeInteger(limits.perAsset) || limits.perAsset < 1
    || !Number.isSafeInteger(limits.batch) || limits.batch < limits.perAsset) {
    invalidInput("Design Project bootstrap input is invalid");
  }
  const payloads = new Map<string, Buffer>();
  let totalBytes = 0;
  const items = root.items.map((value, index): StoredDesignCanvasAssetImportItem => {
    const label = `Design Project bootstrap item ${index}`;
    const item = exactRecord(value, label, ["asset", "binding"], invalidInput);
    const asset = exactRecord(item.asset, `${label}.asset`, ["name", "mimeType", "base64", "sourceVersion"], invalidInput);
    const name = boundedString(asset.name, `${label}.asset.name`, 240, invalidInput);
    const mimeType = boundedString(asset.mimeType, `${label}.asset.mimeType`, 120, invalidInput);
    const hasBase64 = asset.base64 !== undefined;
    const hasSourceVersion = asset.sourceVersion !== undefined;
    if (Number(hasBase64) + Number(hasSourceVersion) !== 1) invalidInput(`${label}.asset source is invalid`);
    let source: StoredStagedBytesSource | StoredProjectVersionSource;
    if (hasBase64) {
      const base64 = boundedString(
        asset.base64,
        `${label}.asset.base64`,
        Math.ceil(limits.perAsset * 4 / 3) + 4,
        invalidInput,
      );
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
        invalidInput(`${label}.asset.base64 is invalid`);
      }
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length < 1 || bytes.length > limits.perAsset || bytes.toString("base64") !== base64) {
        invalidInput(`${label}.asset bytes are invalid`);
      }
      totalBytes += bytes.length;
      if (totalBytes > limits.batch) invalidInput("Design Project bootstrap Asset batch is too large");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      payloads.set(sha256, bytes);
      source = { kind: "staged-bytes", sha256, bytes: bytes.length };
    } else {
      const rawSource = exactRecord(asset.sourceVersion, `${label}.asset.sourceVersion`, [
        "projectId", "nodeId", "versionId",
      ], invalidInput);
      source = {
        kind: "project-version",
        projectId: safeSegment(rawSource.projectId, `${label}.asset.sourceVersion.projectId`, invalidInput),
        nodeId: safeSegment(rawSource.nodeId, `${label}.asset.sourceVersion.nodeId`, invalidInput),
        versionId: safeSegment(rawSource.versionId, `${label}.asset.sourceVersion.versionId`, invalidInput),
      };
    }
    return {
      asset: { name, mimeType, source },
      binding: normalizedBinding(item.binding, `${label}.binding`, invalidInput),
    };
  });
  const agent = normalizedAgent(root.agent, invalidInput);
  return {
    payloads,
    request: {
      schemaVersion: DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
      idempotencyKey: root.idempotencyKey,
      name: boundedString(root.name, "Design Project bootstrap name", 1_024, invalidInput),
      prompt: (root.prompt as string).trim(),
      items,
      ...(agent === undefined ? {} : { agent }),
    },
  };
}

function validateStoredRequest(value: unknown): StoredDesignProjectBootstrapRequest {
  const root = exactRecord(value, "Design Project bootstrap request", [
    "schemaVersion", "idempotencyKey", "name", "prompt", "items", "agent",
  ], corruptInput);
  if (root.schemaVersion !== DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION
    || typeof root.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(root.idempotencyKey)
    || typeof root.prompt !== "string" || Buffer.byteLength(root.prompt, "utf8") > 256 * 1024
    || (root.prompt as string).trim() !== root.prompt
    || !Array.isArray(root.items) || root.items.length > MAX_ASSET_ITEMS) {
    corruptInput("Design Project bootstrap request schema is invalid");
  }
  let totalBytes = 0;
  const items = root.items.map((value, index): StoredDesignCanvasAssetImportItem => {
    const label = `Design Project bootstrap stored item ${index}`;
    const item = exactRecord(value, label, ["asset", "binding"], corruptInput);
    const asset = exactRecord(item.asset, `${label}.asset`, ["name", "mimeType", "source"], corruptInput);
    const source = exactRecord(asset.source, `${label}.asset.source`, [
      "kind", "sha256", "bytes", "projectId", "nodeId", "versionId",
    ], corruptInput);
    let parsedSource: StoredStagedBytesSource | StoredProjectVersionSource;
    if (source.kind === "staged-bytes") {
      if (Object.keys(source).some((field) => !["kind", "sha256", "bytes"].includes(field))
        || typeof source.sha256 !== "string" || !SHA256.test(source.sha256)
        || !Number.isSafeInteger(source.bytes) || (source.bytes as number) < 1
        || (source.bytes as number) > MAX_ASSET_BYTES) corruptInput(`${label}.asset.source is invalid`);
      totalBytes += source.bytes as number;
      if (totalBytes > MAX_ASSET_BATCH_BYTES) corruptInput("Design Project bootstrap stored Asset batch is too large");
      parsedSource = { kind: "staged-bytes", sha256: source.sha256, bytes: source.bytes as number };
    } else if (source.kind === "project-version") {
      if (Object.keys(source).some((field) => !["kind", "projectId", "nodeId", "versionId"].includes(field))) {
        corruptInput(`${label}.asset.source is invalid`);
      }
      parsedSource = {
        kind: "project-version",
        projectId: safeSegment(source.projectId, `${label}.asset.source.projectId`, corruptInput),
        nodeId: safeSegment(source.nodeId, `${label}.asset.source.nodeId`, corruptInput),
        versionId: safeSegment(source.versionId, `${label}.asset.source.versionId`, corruptInput),
      };
    } else {
      corruptInput(`${label}.asset.source is invalid`);
    }
    return {
      asset: {
        name: boundedString(asset.name, `${label}.asset.name`, 240, corruptInput),
        mimeType: boundedString(asset.mimeType, `${label}.asset.mimeType`, 120, corruptInput),
        source: parsedSource,
      },
      binding: normalizedBinding(item.binding, `${label}.binding`, corruptInput),
    };
  });
  const agent = normalizedAgent(root.agent, corruptInput);
  return {
    schemaVersion: DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    idempotencyKey: root.idempotencyKey,
    name: boundedString(root.name, "Design Project bootstrap name", 1_024, corruptInput),
    prompt: root.prompt as string,
    items,
    ...(agent === undefined ? {} : { agent }),
  };
}

function requestHash(input: StoredDesignProjectBootstrapRequest): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function receiptId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function jobPath(dataDir: string, idempotencyKey: string): string {
  return join(dataDir, "design-bootstrap-jobs", receiptId(idempotencyKey), "job.json");
}

function jobsRoot(dataDir: string): string {
  return join(dataDir, "design-bootstrap-jobs");
}

function corruptStoredJob(message: string): never {
  throw new DesignProjectBootstrapError("corrupt", message);
}

function validateStoredJob(value: unknown, path: string): StoredDesignProjectBootstrapJob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return corruptStoredJob("Design Project bootstrap Job schema is invalid");
  }
  const record = value as Record<string, unknown>;
  const fields = [
    "schemaVersion", "id", "projectId", "requestHash", "request", "status", "completedPhase",
    "mainJobId", "error", "createdAt", "updatedAt",
  ];
  if (Object.keys(record).length !== fields.length
    || Object.keys(record).some((field) => !fields.includes(field))) {
    return corruptStoredJob("Design Project bootstrap Job schema is invalid");
  }
  if (record.request === null || typeof record.request !== "object" || Array.isArray(record.request)) {
    return corruptStoredJob("Design Project bootstrap request schema is invalid");
  }
  const requestRecord = record.request as Record<string, unknown>;
  const requestFields = ["schemaVersion", "idempotencyKey", "name", "prompt", "items", "agent"];
  if (Object.keys(requestRecord).some((field) => !requestFields.includes(field))) {
    return corruptStoredJob("Design Project bootstrap request schema is invalid");
  }
  let request: StoredDesignProjectBootstrapRequest;
  try {
    request = validateStoredRequest(record.request);
  } catch (error) {
    throw new DesignProjectBootstrapError(
      "corrupt",
      "Design Project bootstrap request schema is invalid",
      null,
      { cause: error },
    );
  }
  const phase = record.completedPhase as DesignProjectBootstrapPhase;
  const status = record.status;
  const mainJobId = record.mainJobId;
  const error = record.error;
  if (record.schemaVersion !== DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION
    || typeof record.id !== "string" || !SAFE_ID.test(record.id) || !record.id.startsWith("bootstrap-")
    || typeof record.projectId !== "string" || !SAFE_ID.test(record.projectId)
    || typeof record.requestHash !== "string" || !SHA256.test(record.requestHash)
    || record.requestHash !== requestHash(request)
    || basename(dirname(path)) !== receiptId(request.idempotencyKey)
    || !["running", "ready", "failed"].includes(String(status))
    || !BOOTSTRAP_PHASES.has(phase)
    || (mainJobId !== null && (typeof mainJobId !== "string" || !SAFE_ID.test(mainJobId)))
    || (error !== null && (typeof error !== "string" || Buffer.byteLength(error, "utf8") > 64 * 1024))
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < (record.createdAt as number)
    || (status === "ready" && phase !== "ready")
    || (status === "running" && phase === "ready")
    || (phase === "assets-imported" && request.items.length === 0)
    || (phase === "main-reserved" && (!request.prompt || mainJobId === null))
    || (mainJobId !== null && !request.prompt)) {
    return corruptStoredJob("Design Project bootstrap Job schema is invalid");
  }
  return {
    schemaVersion: DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    id: record.id,
    projectId: record.projectId,
    requestHash: record.requestHash,
    request,
    status: status as StoredDesignProjectBootstrapJob["status"],
    completedPhase: phase,
    mainJobId: mainJobId as string | null,
    error: error as string | null,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const pending = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

async function publishAcceptedJob(
  path: string,
  job: StoredDesignProjectBootstrapJob,
  payloads: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const root = dirname(path);
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const pending = join(parent, `.${basename(root)}.${randomUUID()}.tmp`);
  try {
    await mkdir(pending, { mode: 0o700 });
    if (payloads.size > 0) {
      const payloadRoot = join(pending, "payloads");
      await mkdir(payloadRoot, { mode: 0o700 });
      for (const [sha256, bytes] of payloads) {
        await writeFile(join(payloadRoot, sha256), bytes, { flag: "wx", mode: 0o600 });
      }
    }
    await writeFile(join(pending, "job.json"), `${JSON.stringify(job, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(pending, root);
  } finally {
    await rm(pending, { recursive: true, force: true }).catch(() => {});
  }
}

async function cleanupStagedPayloads(path: string): Promise<void> {
  await rm(join(dirname(path), "payloads"), { recursive: true, force: true });
}

async function materializeStoredInput(
  request: StoredDesignProjectBootstrapRequest,
  path: string,
): Promise<DesignProjectBootstrapInput> {
  const items: DesignCanvasAssetImportItem[] = [];
  for (const item of request.items) {
    let asset: DesignCanvasAssetImportItem["asset"];
    if (item.asset.source.kind === "project-version") {
      asset = {
        name: item.asset.name,
        mimeType: item.asset.mimeType,
        sourceVersion: {
          projectId: item.asset.source.projectId,
          nodeId: item.asset.source.nodeId,
          versionId: item.asset.source.versionId,
        },
      };
    } else {
      const payloadPath = join(dirname(path), "payloads", item.asset.source.sha256);
      let bytes: Buffer;
      try {
        bytes = await readFile(payloadPath);
      } catch (error) {
        throw new DesignProjectBootstrapError(
          "corrupt",
          `Design Project bootstrap staged Asset ${item.asset.source.sha256} is missing`,
          null,
          { cause: error },
        );
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== item.asset.source.bytes || digest !== item.asset.source.sha256) {
        throw new DesignProjectBootstrapError(
          "corrupt",
          `Design Project bootstrap staged Asset ${item.asset.source.sha256} failed integrity verification`,
        );
      }
      asset = {
        name: item.asset.name,
        mimeType: item.asset.mimeType,
        base64: bytes.toString("base64"),
      };
    }
    items.push({ asset, binding: item.binding });
  }
  return {
    schemaVersion: DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    idempotencyKey: request.idempotencyKey,
    name: request.name,
    prompt: request.prompt,
    items,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  };
}

async function readStoredJob(path: string): Promise<StoredDesignProjectBootstrapJob | null> {
  try {
    return validateStoredJob(JSON.parse(await readFile(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new DesignProjectBootstrapError("corrupt", "Design Project bootstrap Job is not valid JSON", null, { cause: error });
    }
    throw error;
  }
}

async function withBootstrapLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = bootstrapLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => current);
  bootstrapLocks.set(key, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (bootstrapLocks.get(key) === tail) bootstrapLocks.delete(key);
  }
}

export async function bootstrapDesignProject(
  options: BootstrapDesignProjectOptions,
): Promise<DesignProjectBootstrapResult> {
  const prepared = prepareInput(options.input, options.testHooks?.assetByteLimits);
  const hash = requestHash(prepared.request);
  const path = jobPath(options.dataDir, prepared.request.idempotencyKey);
  return withBootstrapLock(path, async () => {
    const existing = await readStoredJob(path);
    if (existing !== null && existing.requestHash !== hash) {
      throw new DesignProjectBootstrapError(
        "conflict",
        "idempotencyKey is already bound to a different Design Project bootstrap request",
        publicJob(existing),
      );
    }
    if (existing?.status === "ready") {
      await cleanupStagedPayloads(path);
      return { job: publicJob(existing), reused: true };
    }

    const timestamp = options.now?.() ?? Date.now();
    const job: StoredDesignProjectBootstrapJob = existing ?? {
      schemaVersion: DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION,
      id: `bootstrap-${randomUUID()}`,
      projectId: randomUUID(),
      requestHash: hash,
      request: prepared.request,
      status: "running",
      completedPhase: "accepted",
      mainJobId: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    job.status = "running";
    job.error = null;
    job.updatedAt = timestamp;
    if (existing === null) await publishAcceptedJob(path, job, prepared.payloads);
    else await atomicJson(path, job);
    if (existing === null) await options.testHooks?.afterPhase?.("accepted");
    try {
      if (job.completedPhase === "accepted") {
        await options.ports.ensureProject({
          projectId: job.projectId,
          name: job.request.name,
          createdAt: job.createdAt,
        });
        job.completedPhase = "project-created";
        job.updatedAt = options.now?.() ?? Date.now();
        await atomicJson(path, job);
        await options.testHooks?.afterPhase?.("project-created");
      }
      if (job.request.items.length > 0 && job.completedPhase === "project-created") {
        const materialized = await materializeStoredInput(job.request, path);
        await options.ports.ensureAssetBatch({
          projectId: job.projectId,
          idempotencyKey: `${job.id}:assets`,
          requestHash: job.requestHash,
          items: materialized.items,
        });
        job.completedPhase = "assets-imported";
        job.updatedAt = options.now?.() ?? Date.now();
        await atomicJson(path, job);
        await options.testHooks?.afterPhase?.("assets-imported");
      }
      if (job.request.prompt && (job.completedPhase === "project-created" || job.completedPhase === "assets-imported")) {
        const main = await options.ports.ensureMainTurn({
          projectId: job.projectId,
          idempotencyKey: `${job.id}:main`,
          prompt: job.request.prompt,
          ...(job.request.agent === undefined ? {} : { agent: job.request.agent }),
        });
        job.mainJobId = main.jobId;
        job.completedPhase = "main-reserved";
        job.updatedAt = options.now?.() ?? Date.now();
        await atomicJson(path, job);
        await options.testHooks?.afterPhase?.("main-reserved");
      }
      job.completedPhase = "ready";
      job.status = "ready";
      job.updatedAt = options.now?.() ?? Date.now();
      await atomicJson(path, job);
      await cleanupStagedPayloads(path);
      await options.testHooks?.afterPhase?.("ready");
      return { job: publicJob(job), reused: existing !== null };
    } catch (error) {
      if (options.testHooks?.simulateProcessCrash) throw error;
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = options.now?.() ?? Date.now();
      await atomicJson(path, job);
      if (error instanceof DesignProjectBootstrapError && error.code === "corrupt") {
        throw new DesignProjectBootstrapError("corrupt", error.message, publicJob(job), { cause: error });
      }
      throw new DesignProjectBootstrapError("failed", job.error || "Design Project bootstrap failed", publicJob(job), { cause: error });
    }
  });
}

export async function recoverDesignProjectBootstraps(options: {
  dataDir: string;
  ports: DesignProjectBootstrapPorts;
  now?: () => number;
}): Promise<DesignProjectBootstrapResult[]> {
  let entries;
  try {
    entries = await readdir(jobsRoot(options.dataDir), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const recovered: DesignProjectBootstrapResult[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && /^\.[0-9a-f]{64}\.[A-Za-z0-9-]+\.tmp$/.test(entry.name)) {
      await rm(join(jobsRoot(options.dataDir), entry.name), { recursive: true, force: true });
      continue;
    }
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) {
      throw new DesignProjectBootstrapError("corrupt", "Design Project bootstrap receipt identity is invalid");
    }
    const stored = await readStoredJob(join(jobsRoot(options.dataDir), entry.name, "job.json"));
    if (stored === null) {
      throw new DesignProjectBootstrapError("corrupt", "Design Project bootstrap receipt is missing its Job");
    }
    const path = join(jobsRoot(options.dataDir), entry.name, "job.json");
    if (stored.status === "ready") {
      await cleanupStagedPayloads(path);
      continue;
    }
    if (stored.status !== "running") continue;
    recovered.push(await bootstrapDesignProject({
      dataDir: options.dataDir,
      input: await materializeStoredInput(stored.request, path),
      ports: options.ports,
      ...(options.now === undefined ? {} : { now: options.now }),
    }));
  }
  return recovered;
}
