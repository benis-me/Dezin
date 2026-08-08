/**
 * Explicit, disposable Design Canvas QA harness for a real CodeBuddy turn.
 *
 * This is deliberately outside the production daemon entrypoint. Production
 * Design Agents remain subject to their normal provider-confinement policy;
 * the harness opts into AppDeps.designRunner only for a fresh mkdtemp Project.
 *
 *   DEZIN_QA_CODEBUDDY=1 pnpm qa:design:codebuddy
 *   DEZIN_QA_CODEBUDDY=1 DEZIN_QA_EXPORT=1 pnpm qa:design:codebuddy
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  getProvider,
  type AgentRunner,
  type AgentTurnInput,
} from "../packages/agent/src/index.ts";
import { Store } from "../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../apps/daemon/src/app.ts";
import type {
  DesignCanvas,
  DesignExportManifest,
  DesignJob,
  DesignVersionManifest,
} from "../apps/daemon/src/design/design-types.ts";

const execFile = promisify(execFileCallback);
const PROVIDER = "codebuddy";
const MODEL = "hy3-ioa";
const TERMINAL_JOB_STATES = new Set(["ready", "failed", "cancelled", "superseded"]);
const MAIN_PAGE_ID = "qa-page";
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

interface ProjectResponse {
  id: string;
  name: string;
}

interface StartedJobResponse {
  job: DesignJob;
}

interface StartedExportResponse {
  exportId: string;
  job: DesignJob;
}

interface QaVersionReceipt {
  nodeId: string;
  versionId: string;
  jobId: string;
  providerId: string | null;
  model: string | null;
  checksum: string;
  persistedChecksum: string;
  previewChecksum: string;
  bytes: number;
  previewStatus: number;
  previewEtag: string | null;
  previewCsp: string | null;
  manifestPath: string;
  htmlPath: string;
}

interface QaExportReceipt {
  requested: boolean;
  status: "skipped" | DesignJob["status"];
  exportId?: string;
  jobId?: string;
  providerId?: string;
  model?: string | null;
  manifestPath?: string;
  manifestChecksum?: string;
  outputHash?: string;
  visualReceiptPath?: string;
  visualReceiptChecksum?: string;
  outputFileCount?: number;
  error?: string | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

async function resolveExecutable(candidate: string): Promise<string> {
  const candidates = isAbsolute(candidate) || candidate.includes("/")
    ? [resolve(candidate)]
    : (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => resolve(directory, candidate));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {
      // Keep looking through PATH.
    }
  }
  throw new Error(`Could not resolve executable ${JSON.stringify(candidate)}`);
}

function buildCodeBuddyArgs(systemPrompt: string): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Write,Edit,Glob,Grep",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--no-session-persistence",
    "--append-system-prompt",
    systemPrompt,
    "--model",
    MODEL,
  ];
}

function createQaRunner(command: string): AgentRunner {
  const provider = getProvider(PROVIDER);
  if (!provider || provider.id !== PROVIDER) throw new Error("CodeBuddy provider is not registered");
  const options = {
    command,
    model: MODEL,
    buildArgs: buildCodeBuddyArgs,
  };
  const mainRunner = provider.createRunner({
    ...options,
    // Main Agent must leave the daemon-seeded compatibility HTML untouched.
    enforceArtifactUpdate: false,
  });
  const artifactRunner = provider.createRunner({
    ...options,
    // Node generation and implementation export must produce new bytes.
    enforceArtifactUpdate: true,
  });
  return {
    id: PROVIDER,
    identityProtocol: "claude-stream-json-init-v1",
    runTurn(input: AgentTurnInput) {
      const mainPlanningTurn = input.systemPrompt.includes("Main Agent for one Design Canvas");
      return (mainPlanningTurn ? mainRunner : artifactRunner).runTurn(input);
    },
  };
}

async function jsonRequest<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 2_000)}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(`${init.method ?? "GET"} ${path} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function jsonBody(value: unknown): Pick<RequestInit, "method" | "body"> {
  return { method: "POST", body: JSON.stringify(value) };
}

async function listJobs(baseUrl: string, root: string): Promise<DesignJob[]> {
  return jsonRequest<DesignJob[]>(baseUrl, `${root}/jobs`);
}

async function waitForJob(
  baseUrl: string,
  root: string,
  jobId: string,
  timeoutMs: number,
): Promise<DesignJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = (await listJobs(baseUrl, root)).find((candidate) => candidate.id === jobId);
    if (job && TERMINAL_JOB_STATES.has(job.status)) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  }
  throw new Error(`Timed out waiting for Design Job ${jobId}`);
}

async function waitForMainChild(
  baseUrl: string,
  root: string,
  mainJobId: string,
  nodeId: string,
  timeoutMs: number,
): Promise<DesignJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = (await listJobs(baseUrl, root)).find((job) =>
      job.parentJobId === mainJobId && job.nodeId === nodeId && job.kind === "node-generation");
    if (child) return child;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Main Agent ${mainJobId} did not dispatch Node ${nodeId}`);
}

function assertReadyIdentity(job: DesignJob, label: string): void {
  if (job.status !== "ready") throw new Error(`${label} ${job.id} ended ${job.status}: ${job.error ?? "unknown error"}`);
  if (job.runnerId !== PROVIDER || job.model !== MODEL) {
    throw new Error(`${label} ${job.id} identity is ${job.runnerId}/${job.model ?? "default"}, expected ${PROVIDER}/${MODEL}`);
  }
}

async function verifyVersion(input: {
  baseUrl: string;
  dataDir: string;
  projectId: string;
  root: string;
  nodeId: string;
  job: DesignJob;
}): Promise<QaVersionReceipt> {
  const versions = await jsonRequest<DesignVersionManifest[]>(
    input.baseUrl,
    `${input.root}/nodes/${encodeURIComponent(input.nodeId)}/versions`,
  );
  const version = versions.find((candidate) => candidate.id === input.job.versionId && candidate.jobId === input.job.id);
  if (!version) throw new Error(`No immutable Version is bound to Node Job ${input.job.id}`);
  if (version.publicationStatus !== "published") throw new Error(`Version ${version.id} was ${version.publicationStatus}`);
  if (version.runnerId !== PROVIDER || version.model !== MODEL) {
    throw new Error(`Version ${version.id} provenance does not match ${PROVIDER}/${MODEL}`);
  }

  const versionRoot = join(
    input.dataDir,
    "projects",
    input.projectId,
    "design",
    "nodes",
    input.nodeId,
    "versions",
    version.id,
  );
  const manifestPath = join(versionRoot, "manifest.json");
  const htmlPath = join(versionRoot, "index.html");
  const persistedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as DesignVersionManifest;
  const persistedHtml = await readFile(htmlPath);
  const persistedChecksum = sha256(persistedHtml);
  if (persistedManifest.checksum !== version.checksum || persistedChecksum !== version.checksum) {
    throw new Error(`Version ${version.id} checksum does not bind its persisted bytes`);
  }

  const preview = await fetch(
    `${input.baseUrl}${input.root}/nodes/${encodeURIComponent(input.nodeId)}/versions/${encodeURIComponent(version.id)}/preview/`,
  );
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  const previewChecksum = sha256(previewBytes);
  const expectedEtag = `"sha256-${version.checksum}"`;
  if (preview.status !== 200 || preview.headers.get("etag") !== expectedEtag || previewChecksum !== version.checksum) {
    throw new Error(`Exact preview for Version ${version.id} is not byte-bound to ${version.checksum}`);
  }
  const previewCsp = preview.headers.get("content-security-policy");
  if (!previewCsp?.includes("sandbox allow-scripts") || !previewCsp.includes("connect-src 'none'")) {
    throw new Error(`Exact preview for Version ${version.id} is missing its confinement CSP`);
  }

  return {
    nodeId: input.nodeId,
    versionId: version.id,
    jobId: input.job.id,
    providerId: version.runnerId,
    model: version.model,
    checksum: version.checksum,
    persistedChecksum,
    previewChecksum,
    bytes: version.bytes,
    previewStatus: preview.status,
    previewEtag: preview.headers.get("etag"),
    previewCsp,
    manifestPath,
    htmlPath,
  };
}

async function verifyExport(input: {
  baseUrl: string;
  dataDir: string;
  projectId: string;
  root: string;
  canvasRevision: number;
  timeoutMs: number;
}): Promise<QaExportReceipt> {
  const started = await jsonRequest<StartedExportResponse>(input.baseUrl, `${input.root}/exports`, jsonBody({
    canvasRevision: input.canvasRevision,
    agentCommand: PROVIDER,
    model: MODEL,
  }));
  const completed = await waitForJob(input.baseUrl, input.root, started.job.id, input.timeoutMs);
  if (completed.status !== "ready") {
    return {
      requested: true,
      status: completed.status,
      exportId: started.exportId,
      jobId: completed.id,
      error: completed.error,
    };
  }
  assertReadyIdentity(completed, "Implementation Export Job");
  if (completed.exportId !== started.exportId) throw new Error("Implementation Export Job changed export identity");

  const exportRoot = join(
    input.dataDir,
    "projects",
    input.projectId,
    "design",
    "exports",
    started.exportId,
  );
  const manifestPath = join(exportRoot, "dezin-export.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as DesignExportManifest;
  if (manifest.jobId !== completed.id || manifest.providerId !== PROVIDER || manifest.model !== MODEL) {
    throw new Error(`Export ${started.exportId} manifest provenance is invalid`);
  }
  const visualReceiptPath = join(exportRoot, manifest.visualValidation.receiptPath);
  const visualReceiptChecksum = sha256(await readFile(visualReceiptPath));
  if (visualReceiptChecksum !== manifest.visualValidation.receiptChecksum) {
    throw new Error(`Export ${started.exportId} visual receipt checksum is invalid`);
  }

  return {
    requested: true,
    status: completed.status,
    exportId: started.exportId,
    jobId: completed.id,
    providerId: manifest.providerId,
    model: manifest.model,
    manifestPath,
    manifestChecksum: sha256(manifestBytes),
    outputHash: manifest.outputHash,
    visualReceiptPath,
    visualReceiptChecksum,
    outputFileCount: manifest.outputFiles.length,
    error: null,
  };
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const requestedExport = process.env.DEZIN_QA_EXPORT === "1";
  const timeoutMs = positiveInteger(process.env.DEZIN_QA_TIMEOUT_MS, 30 * 60_000, "DEZIN_QA_TIMEOUT_MS");
  let dataDir: string | null = null;
  let store: Store | null = null;
  let runtimeSupervisor: ReturnType<typeof createRuntimeSupervisor> | null = null;
  let server: ReturnType<typeof createApp> | null = null;
  let projectId: string | null = null;
  let mainJobId: string | null = null;
  let nodeJobId: string | null = null;

  try {
    if (process.env.DEZIN_QA_CODEBUDDY !== "1") {
      throw new Error("Refusing real CodeBuddy QA without explicit DEZIN_QA_CODEBUDDY=1 opt-in");
    }
    if (process.env.DEZIN_QA_MODEL !== undefined && process.env.DEZIN_QA_MODEL !== MODEL) {
      throw new Error(`This receipt harness is pinned to ${MODEL}; DEZIN_QA_MODEL cannot override it`);
    }

    dataDir = await mkdtemp(join(tmpdir(), "dezin-design-codebuddy-qa-"));
    const command = await resolveExecutable(process.env.DEZIN_QA_CODEBUDDY_COMMAND ?? "codebuddy");
    const provider = getProvider(PROVIDER);
    if (!provider?.probeReadiness) throw new Error("CodeBuddy readiness probe is unavailable");
    const readiness = await provider.probeReadiness(command, { cwd: dataDir, timeoutMs: 20_000 });
    if (readiness.status !== "ready") throw new Error(readiness.reason ?? `CodeBuddy readiness is ${readiness.status}`);
    const version = (await execFile(command, ["--version"], { timeout: 10_000 })).stdout.trim();

    store = new Store(join(dataDir, "app.sqlite"));
    store.updateSettings({ agentCommand: PROVIDER, model: MODEL });
    runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
    server = createApp({
      dataDir,
      store,
      runtimeSupervisor,
      designRunner: createQaRunner(command),
    });
    await new Promise<void>((resolvePromise, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        resolvePromise();
      });
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const project = await jsonRequest<ProjectResponse>(baseUrl, "/api/projects", jsonBody({
      name: "CodeBuddy hy3 Design QA",
    }));
    projectId = project.id;
    const root = `/api/projects/${encodeURIComponent(project.id)}/design-canvas`;
    const initialCanvas = await jsonRequest<DesignCanvas>(baseUrl, root);
    if (initialCanvas.nodes.length !== 0 || initialCanvas.revision !== 0) {
      throw new Error("QA Project did not start from an empty Design Canvas");
    }

    const mainPrompt = [
      `Create exactly one Page Node with id ${JSON.stringify(MAIN_PAGE_ID)} and name "CodeBuddy QA Page".`,
      "Use geometry x=80, y=80, width=1120, height=760. Do not add any other Node.",
      `Dispatch that Page exactly once with this scoped brief: "Create a polished, responsive offline product page that visibly says CodeBuddy hy3 QA. Use only inline CSS and JavaScript, no external assets or URLs."`,
      "Use no priority context Nodes. Keep your user-facing reply concise.",
    ].join(" ");
    const mainStarted = await jsonRequest<StartedJobResponse>(baseUrl, `${root}/agent/turns`, jsonBody({
      message: mainPrompt,
      context: { nodeIds: [] },
      agentCommand: PROVIDER,
      model: MODEL,
      idempotencyKey: "codebuddy-hy3-main-v1",
    }));
    mainJobId = mainStarted.job.id;
    const mainCompleted = await waitForJob(baseUrl, root, mainStarted.job.id, timeoutMs);
    assertReadyIdentity(mainCompleted, "Main Agent Job");

    const canvasAfterMain = await jsonRequest<DesignCanvas>(baseUrl, root);
    const page = canvasAfterMain.nodes.find((node) => node.id === MAIN_PAGE_ID && node.kind === "page");
    if (!page) throw new Error(`Main Agent did not create exact Page Node ${MAIN_PAGE_ID}`);
    const child = await waitForMainChild(baseUrl, root, mainCompleted.id, page.id, 10_000);
    nodeJobId = child.id;
    const nodeCompleted = TERMINAL_JOB_STATES.has(child.status)
      ? child
      : await waitForJob(baseUrl, root, child.id, timeoutMs);
    assertReadyIdentity(nodeCompleted, "Node Agent Job");
    if (!nodeCompleted.versionId) throw new Error(`Node Job ${nodeCompleted.id} has no Version`);

    const canvasAfterNode = await jsonRequest<DesignCanvas>(baseUrl, root);
    const readyPage = canvasAfterNode.nodes.find((node) => node.id === page.id);
    if (!readyPage || readyPage.state !== "ready" || readyPage.currentVersionId !== nodeCompleted.versionId) {
      throw new Error(`Page Node ${page.id} does not project its ready immutable Version`);
    }
    const versionReceipt = await verifyVersion({
      baseUrl,
      dataDir,
      projectId: project.id,
      root,
      nodeId: page.id,
      job: nodeCompleted,
    });

    const exportReceipt = requestedExport
      ? await verifyExport({
          baseUrl,
          dataDir,
          projectId: project.id,
          root,
          canvasRevision: canvasAfterNode.revision,
          timeoutMs,
        })
      : { requested: false, status: "skipped" as const };
    if (exportReceipt.requested && exportReceipt.status !== "ready") {
      throw new Error(`Implementation Export ended ${exportReceipt.status}: ${exportReceipt.error ?? "unknown error"}`);
    }

    const finishedAt = Date.now();
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      optIn: "DEZIN_QA_CODEBUDDY=1",
      productionConfinementChanged: false,
      provider: {
        id: PROVIDER,
        model: MODEL,
        command,
        cliVersion: version,
        readiness: readiness.status,
      },
      project: {
        id: project.id,
        name: project.name,
        dataDir,
        canvasRevision: canvasAfterNode.revision,
      },
      mainJob: {
        id: mainCompleted.id,
        status: mainCompleted.status,
        providerId: mainCompleted.runnerId,
        model: mainCompleted.model,
        startedAt: mainCompleted.createdAt,
        finishedAt: mainCompleted.finishedAt,
        elapsedMs: (mainCompleted.finishedAt ?? mainCompleted.updatedAt) - mainCompleted.createdAt,
      },
      nodeJob: {
        id: nodeCompleted.id,
        parentJobId: nodeCompleted.parentJobId,
        nodeId: nodeCompleted.nodeId,
        status: nodeCompleted.status,
        providerId: nodeCompleted.runnerId,
        model: nodeCompleted.model,
        versionId: nodeCompleted.versionId,
        startedAt: nodeCompleted.createdAt,
        finishedAt: nodeCompleted.finishedAt,
        elapsedMs: (nodeCompleted.finishedAt ?? nodeCompleted.updatedAt) - nodeCompleted.createdAt,
      },
      version: versionReceipt,
      export: exportReceipt,
      startedAt,
      finishedAt,
      elapsedMs: finishedAt - startedAt,
    }, null, 2)}\n`);
  } catch (error) {
    const finishedAt = Date.now();
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      provider: { id: PROVIDER, model: MODEL },
      dataDir,
      projectId,
      mainJobId,
      nodeJobId,
      exportRequested: requestedExport,
      error: errorMessage(error),
      startedAt,
      finishedAt,
      elapsedMs: finishedAt - startedAt,
    }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    if (runtimeSupervisor) await runtimeSupervisor.shutdown().catch(() => false);
    if (server?.listening) {
      await new Promise<void>((resolvePromise) => server!.close(() => resolvePromise()));
    }
    store?.close();
  }
}

await run();
