/**
 * Version publication: canonicalizing Asset references in generated HTML, the publication
 * transaction with roll-forward/roll-back recovery, and Version manifest reads.
 * Split out of design-asset-version-publication.ts; the facade there wires these
 * modules together and remains the only entry point.
 */
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_SCHEMA_VERSION,
  type DesignJob,
  type DesignNode,
  type DesignVersionManifest,
  type DesignVersionPublicationTransaction,
} from "./design-types.ts";
import {
  PortableDesignHtmlError,
  rewriteDesignHtmlUrlReferences,
} from "./design-portable-html.ts";
import {
  extractDesignPageTitle,
} from "./design-page-title.ts";
import {
  collectDesignJavaScriptUrlSinks,
  validateDesignHtml,
} from "./design-static-validation.ts";
import {
  DesignStorageError,
  MAX_ASSET_BUNDLE_FILES,
  MAX_DESIGN_HTML_BYTES,
  SAFE_SEGMENT,
  SHA256,
  designRoot,
  exists,
  jobFilePath,
  nodeRoot,
  nowValue,
  projectFilePath,
  publicationTransactionsRoot,
  readJson,
  safeSegment,
  storedRecord,
  validStoredNullableId,
  validStoredText,
  validStoredTimestamp,
  withProjectLock,
  writeAtomicJson,
  writeAuthorityJson,
} from "./design-storage-primitives.ts";
import {
  pendingVersionRoot,
  publicationTransactionChecksum,
  publicationTransactionPath,
  versionRoot,
} from "./design-publication-primitives.ts";
import type {
  DesignVersionPublicationTestHooks,
} from "./design-asset-version-publication.ts";
import type { DesignAssetResolution } from "./design-asset-resolution.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";

export interface DesignVersionPublicationDeps extends Pick<DesignCanvasState, "canvas" | "cloneNode" | "readNodes" | "readProject" | "requireInitialized"> {
  readJob(root: string, jobId: string): Promise<DesignJob>;
  getDesignAssetManifest: DesignAssetResolution["getDesignAssetManifest"];
}

export function createDesignVersionPublication(deps: DesignVersionPublicationDeps) {
  const canvas: DesignCanvasState["canvas"] = deps.canvas;
  const cloneNode: DesignCanvasState["cloneNode"] = deps.cloneNode;
  const readNodes: DesignCanvasState["readNodes"] = deps.readNodes;
  const readProject: DesignCanvasState["readProject"] = deps.readProject;
  const requireInitialized: DesignCanvasState["requireInitialized"] = deps.requireInitialized;
  const readJob = deps.readJob;
  const getDesignAssetManifest: DesignAssetResolution["getDesignAssetManifest"] = deps.getDesignAssetManifest;

  async function canonicalizeVersionAssets(input: {
    dataDir: string;
    projectId: string;
    nodeId: string;
    versionId: string;
    html: string;
    allowedCanonicalAssetUrls: ReadonlySet<string>;
  }): Promise<{ html: string; pins: Array<{ assetId: string; checksum: string }> }> {
    const projectPath = `/api/projects/${input.projectId}/design-canvas/assets/`;
    const exactAssetReference = /^dezin-asset:\/\/(asset-[a-f0-9]{32})$/i;
    const exactCanonicalReference = /^\/api\/projects\/([A-Za-z0-9._-]+)\/design-canvas\/assets\/(asset-[a-f0-9]{32})\/original\.[a-z0-9]{1,12}\?nodeId=([A-Za-z0-9._-]+)&versionId=(version-[A-Za-z0-9._-]+)&checksum=([a-f0-9]{64})$/i;
    const scriptAssetReference = /dezin-asset:\/\/(asset-[a-f0-9]{32})(?![A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-])/gi;
    const scriptCanonicalReference = /\/api\/projects\/[A-Za-z0-9._-]+\/design-canvas\/assets\/(asset-[a-f0-9]{32})\/original\.[a-z0-9]{1,12}\?nodeId=[A-Za-z0-9._-]+&versionId=version-[A-Za-z0-9._-]+&checksum=[a-f0-9]{64}(?![A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-])/gi;
    const ids = new Set<string>();

    const inspectReference = (rawUrl: string): string => {
      const url = rawUrl.trim();
      const asset = exactAssetReference.exec(url);
      if (asset) {
        ids.add(asset[1]!.toLowerCase());
        return rawUrl;
      }
      if (/^dezin-asset:/i.test(url)) {
        throw new PortableDesignHtmlError("corrupt", "Generated HTML contains an invalid Design Asset reference");
      }
      const canonical = exactCanonicalReference.exec(url);
      if (canonical) {
        if (canonical[1] !== input.projectId || canonical[3] !== input.nodeId
          || !input.allowedCanonicalAssetUrls.has(url)) {
          throw new PortableDesignHtmlError(
            "corrupt",
            "Generated HTML contains a canonical Asset URL not authorized by its expected Head Version",
          );
        }
        ids.add(canonical[2]!.toLowerCase());
        return rawUrl;
      }
      if (/^\/api\/projects\/[^/?#]+\/design-canvas\/assets\//i.test(url)) {
        throw new PortableDesignHtmlError(
          "corrupt",
          "Generated HTML contains a canonical Asset URL not authorized by its expected Head Version",
        );
      }
      return rawUrl;
    };
    const inspectScript = (
      script: string,
      sourceType: "script" | "module" | null,
    ): string => {
      for (const match of script.matchAll(scriptAssetReference)) ids.add(match[1]!.toLowerCase());
      for (const match of script.matchAll(scriptCanonicalReference)) inspectReference(match[0]);
      if (sourceType !== null) {
        for (const { url, sourceRange } of collectDesignJavaScriptUrlSinks(script, sourceType)) {
          const internal = exactAssetReference.test(url)
            || exactCanonicalReference.test(url)
            || /^dezin-asset:/i.test(url)
            || /^\/api\/projects\/[^/?#]+\/design-canvas\/assets\//i.test(url);
          if (!internal) continue;
          inspectReference(url);
          if (sourceRange === null) {
            throw new PortableDesignHtmlError(
              "corrupt",
              "Generated JavaScript Asset URL has no exact source token and cannot be canonicalized safely",
            );
          }
        }
      }
      return script;
    };

    try {
      rewriteDesignHtmlUrlReferences({
        html: input.html,
        rewriteUrl: inspectReference,
        rewriteScriptText: inspectScript,
      });
      const manifests = await Promise.all([...ids].sort().map((id) => getDesignAssetManifest(
        input.dataDir,
        input.projectId,
        id,
      )));
      const canonicalById = new Map(manifests.map((manifest) => [
        manifest.id,
        `${projectPath}${manifest.id}/${manifest.fileName}`
          + `?nodeId=${input.nodeId}&versionId=${input.versionId}&checksum=${manifest.checksum}`,
      ]));
      const rewriteReference = (rawUrl: string): string => {
        const url = rawUrl.trim();
        inspectReference(rawUrl);
        const asset = exactAssetReference.exec(url);
        const canonical = exactCanonicalReference.exec(url);
        const id = (asset?.[1] ?? canonical?.[2])?.toLowerCase();
        return id === undefined ? rawUrl : canonicalById.get(id)!;
      };
      const rewriteScript = (
        script: string,
        sourceType: "script" | "module" | null,
      ): string => {
        if (sourceType === null) return script;
        const edits = new Map<string, { start: number; end: number; replacement: string }>();
        for (const { url, sourceRange } of collectDesignJavaScriptUrlSinks(script, sourceType)) {
          const asset = exactAssetReference.exec(url);
          const canonical = exactCanonicalReference.exec(url);
          const id = (asset?.[1] ?? canonical?.[2])?.toLowerCase();
          if (id === undefined) continue;
          if (sourceRange === null) {
            throw new PortableDesignHtmlError(
              "corrupt",
              "Generated JavaScript Asset URL has no exact source token and cannot be canonicalized safely",
            );
          }
          const replacement = canonicalById.get(id);
          if (!replacement) {
            throw new PortableDesignHtmlError("corrupt", "Generated JavaScript Asset URL has no immutable pin");
          }
          const key = `${sourceRange.start}:${sourceRange.end}`;
          const existing = edits.get(key);
          if (existing && existing.replacement !== replacement) {
            throw new PortableDesignHtmlError("corrupt", "Generated JavaScript Asset URL source is ambiguous");
          }
          edits.set(key, { ...sourceRange, replacement });
        }
        let rewritten = script;
        for (const edit of [...edits.values()].sort((left, right) => right.start - left.start)) {
          rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
        }
        return rewritten;
      };
      const html = rewriteDesignHtmlUrlReferences({
        html: input.html,
        rewriteUrl: rewriteReference,
        rewriteScriptText: rewriteScript,
      });
      let residual = html;
      for (const canonical of canonicalById.values()) {
        residual = residual
          .replaceAll(canonical, "")
          .replaceAll(canonical.replaceAll("&", "&amp;"), "");
      }
      if (/dezin-asset:/i.test(residual)
        || /\/api\/projects\/[^/?#\s"'<>]+\/design-canvas\/assets\//i.test(residual)) {
        throw new PortableDesignHtmlError("corrupt", "Generated HTML contains an invalid Design Asset reference");
      }
      validateDesignHtml(html, { allowCanonicalAssets: true });
      return {
        html,
        pins: manifests.map((manifest) => ({ assetId: manifest.id, checksum: manifest.checksum })),
      };
    } catch (error) {
      if (error instanceof PortableDesignHtmlError) {
        throw new DesignStorageError("invalid-html", error.message, { cause: error });
      }
      throw error;
    }
  }

  function assertStoredPublicationTransaction(
    value: unknown,
    expectedProjectId: string,
    expectedJobId: string,
  ): asserts value is DesignVersionPublicationTransaction {
    const transaction = storedRecord(value, `Design publication ${expectedJobId}`, [
      "schemaVersion", "projectId", "jobId", "nodeId", "manifest", "terminalStatus",
      "projectRevisionBefore", "previousVersionCount", "nodeNameBefore", "nodeNameAfter", "currentVersionIdBefore",
      "selectedVersionIdBefore", "followsHead", "createdAt", "checksum",
    ]);
    const { checksum, ...content } = transaction;
    const actualChecksum = publicationTransactionChecksum(
      content as Omit<DesignVersionPublicationTransaction, "checksum">,
    );
    if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION || transaction.projectId !== expectedProjectId
      || transaction.jobId !== expectedJobId || typeof transaction.nodeId !== "string"
      || !SAFE_SEGMENT.test(transaction.nodeId) || !["ready", "superseded"].includes(String(transaction.terminalStatus))
      || !Number.isSafeInteger(transaction.projectRevisionBefore) || (transaction.projectRevisionBefore as number) < 0
      || !Number.isSafeInteger(transaction.previousVersionCount) || (transaction.previousVersionCount as number) < 0
      || ((transaction.nodeNameBefore === undefined || transaction.nodeNameAfter === undefined)
        ? transaction.nodeNameBefore !== undefined || transaction.nodeNameAfter !== undefined
        : !validStoredText(transaction.nodeNameBefore, 256) || !validStoredText(transaction.nodeNameAfter, 256))
      || !validStoredNullableId(transaction.currentVersionIdBefore)
      || !validStoredNullableId(transaction.selectedVersionIdBefore)
      || typeof transaction.followsHead !== "boolean" || !validStoredTimestamp(transaction.createdAt)
      || typeof checksum !== "string" || !SHA256.test(checksum) || checksum !== actualChecksum) {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} is invalid`);
    }
    const manifest = transaction.manifest;
    if (!manifest || typeof manifest !== "object") {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} manifest is invalid`);
    }
    const versionId = (manifest as { id?: unknown }).id;
    if (typeof versionId !== "string") {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} manifest is invalid`);
    }
    assertStoredVersionManifest(manifest, transaction.nodeId as string, versionId);
    if ((manifest as DesignVersionManifest).contentKind !== "html"
      || (manifest as DesignVersionManifest).assetId !== null
      || (manifest as DesignVersionManifest).jobId !== expectedJobId
      || ((manifest as DesignVersionManifest).publicationStatus === "published" ? "ready" : "superseded")
        !== transaction.terminalStatus) {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} authority is invalid`);
    }
  }

  async function readPublicationTransaction(
    root: string,
    projectId: string,
    jobId: string,
  ): Promise<DesignVersionPublicationTransaction> {
    const value = await readJson<DesignVersionPublicationTransaction>(
      publicationTransactionPath(root, jobId),
      `Design publication ${jobId}`,
    );
    assertStoredPublicationTransaction(value, projectId, jobId);
    return value;
  }

  async function verifyPublicationPayload(path: string, manifest: DesignVersionManifest): Promise<void> {
    const manifestValue = await readJson<DesignVersionManifest>(join(path, "manifest.json"), `Design Version ${manifest.id}`);
    assertStoredVersionManifest(manifestValue, manifest.nodeId, manifest.id);
    if (JSON.stringify(manifestValue) !== JSON.stringify(manifest)) {
      throw new DesignStorageError("corrupt", `Design Version ${manifest.id} diverges from its publication marker`);
    }
    const htmlPath = join(path, "index.html");
    const info = await lstat(htmlPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
      throw new DesignStorageError("corrupt", `Design Version ${manifest.id} publication payload is invalid`);
    }
    const checksum = createHash("sha256").update(await readFile(htmlPath)).digest("hex");
    if (checksum !== manifest.checksum) {
      throw new DesignStorageError("corrupt", `Design Version ${manifest.id} publication checksum is invalid`);
    }
  }

  function assertStoredVersionManifest(
    value: unknown,
    expectedNodeId: string,
    expectedVersionId: string,
  ): asserts value is DesignVersionManifest {
    const manifest = storedRecord(value, `Design Version ${expectedVersionId} manifest`, [
      "schemaVersion", "id", "nodeId", "contentKind", "assetId", "sequence", "checksum", "bytes", "contextHash", "canvasRevision",
      "expectedHeadVersionId", "publicationStatus", "assetPins", "jobId", "runnerId", "model", "createdAt",
    ]);
    if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION || manifest.id !== expectedVersionId
      || manifest.nodeId !== expectedNodeId || !SAFE_SEGMENT.test(expectedVersionId) || !SAFE_SEGMENT.test(expectedNodeId)
      || !Number.isSafeInteger(manifest.sequence) || (manifest.sequence as number) < 1
      || !SHA256.test(String(manifest.checksum))
      || !["html", "asset"].includes(String(manifest.contentKind))
      || !validStoredNullableId(manifest.assetId)
      || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) < 1
      || (manifest.bytes as number) > (manifest.contentKind === "asset" ? Number.MAX_SAFE_INTEGER : MAX_DESIGN_HTML_BYTES)
      || !SHA256.test(String(manifest.contextHash))
      || !Number.isSafeInteger(manifest.canvasRevision) || (manifest.canvasRevision as number) < 0
      || !validStoredNullableId(manifest.expectedHeadVersionId)
      || !["published", "superseded"].includes(String(manifest.publicationStatus))
      || !Array.isArray(manifest.assetPins) || manifest.assetPins.length > MAX_ASSET_BUNDLE_FILES
      || !validStoredNullableId(manifest.jobId)
      || !validStoredText(manifest.runnerId, 512, { nullable: true })
      || (typeof manifest.runnerId === "string" && manifest.runnerId.trim() !== manifest.runnerId)
      || !validStoredText(manifest.model, 512, { nullable: true })
      || (typeof manifest.model === "string" && manifest.model.trim() !== manifest.model)
      || (manifest.jobId !== null && manifest.runnerId === null)
      || (manifest.runnerId === null && manifest.model !== null)
      || !validStoredTimestamp(manifest.createdAt)) {
      throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} manifest is invalid`);
    }
    const pinIds = new Set<string>();
    for (const [index, entry] of manifest.assetPins.entries()) {
      const pin = storedRecord(entry, `Design Version ${expectedVersionId} Asset pin ${index}`, ["assetId", "checksum"]);
      if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
        || pinIds.has(pin.assetId) || !SHA256.test(String(pin.checksum))) {
        throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} Asset pin ${index} is invalid`);
      }
      pinIds.add(pin.assetId);
    }
    if ((manifest.contentKind === "html" && manifest.assetId !== null)
      || (manifest.contentKind === "asset" && (
        typeof manifest.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(manifest.assetId)
        || manifest.assetPins.length !== 0 || manifest.jobId !== null
        || manifest.runnerId !== null || manifest.model !== null
      ))) {
      throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} content binding is invalid`);
    }
  }

  function assertPublicationJobAuthority(
    job: DesignJob,
    transaction: DesignVersionPublicationTransaction,
  ): void {
    const manifest = transaction.manifest;
    if (job.id !== transaction.jobId || job.kind !== "node-generation" || job.nodeId !== transaction.nodeId
      || job.contextHash !== manifest.contextHash || job.canvasRevision !== manifest.canvasRevision
      || job.expectedHeadVersionId !== manifest.expectedHeadVersionId || job.runnerId !== manifest.runnerId
      || job.model !== manifest.model || (job.versionId !== null && job.versionId !== manifest.id)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Job authority is invalid`);
    }
  }

  function publicationNodeState(
    node: DesignNode,
    transaction: DesignVersionPublicationTransaction,
  ): "before" | "after" | null {
    // A WAL written before first-Page title adoption has no name fields. Its
    // checksum remains authoritative and recovery preserves the current name.
    const nodeNameBefore = transaction.nodeNameBefore ?? node.name;
    const nodeNameAfter = transaction.nodeNameAfter ?? nodeNameBefore;
    const before = node.name === nodeNameBefore
      && node.currentVersionId === transaction.currentVersionIdBefore
      && node.selectedVersionId === transaction.selectedVersionIdBefore
      && node.versionCount === transaction.previousVersionCount
      && node.activeJobId === transaction.jobId;
    if (before) return "before";
    const expectedCurrent = transaction.terminalStatus === "ready"
      ? transaction.manifest.id
      : transaction.currentVersionIdBefore;
    const expectedSelected = transaction.terminalStatus === "ready" && transaction.followsHead
      ? transaction.manifest.id
      : transaction.selectedVersionIdBefore;
    const after = node.name === nodeNameAfter
      && node.currentVersionId === expectedCurrent && node.selectedVersionId === expectedSelected
      && node.versionCount === transaction.previousVersionCount + 1 && node.activeJobId === null
      && node.state === transaction.terminalStatus;
    return after ? "after" : null;
  }

  async function rollForwardPublicationUnlocked(
    root: string,
    transaction: DesignVersionPublicationTransaction,
    hooks?: DesignVersionPublicationTestHooks,
  ): Promise<DesignJob> {
    const manifest = transaction.manifest;
    const nodeNameAfter = transaction.nodeNameAfter;
    const pending = pendingVersionRoot(root, transaction.nodeId, manifest.id);
    const target = versionRoot(root, transaction.nodeId, manifest.id);
    const [pendingExists, targetExists] = await Promise.all([exists(pending), exists(target)]);
    if (pendingExists === targetExists) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} payload state is invalid`);
    }
    if (pendingExists) {
      await verifyPublicationPayload(pending, manifest);
    } else {
      await verifyPublicationPayload(target, manifest);
    }

    const job = await readJob(root, transaction.jobId);
    assertPublicationJobAuthority(job, transaction);
    if (!(job.status === "validating" || job.status === transaction.terminalStatus)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Job state is invalid`);
    }

    const project = await readProject(root);
    if (![transaction.projectRevisionBefore, transaction.projectRevisionBefore + 1].includes(project.revision)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Canvas revision is invalid`);
    }
    const nodes = readNodes(project);
    const node = nodes.get(transaction.nodeId);
    if (!node) throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Node is unavailable`);
    const nodeState = publicationNodeState(node, transaction);
    if (nodeState === null || (nodeState === "before" && project.revision !== transaction.projectRevisionBefore)
      || (nodeState === "after" && project.revision !== transaction.projectRevisionBefore + 1)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Canvas authority is invalid`);
    }
    if (pendingExists) {
      await mkdir(join(nodeRoot(root, transaction.nodeId), "versions"), { recursive: true });
      await rename(pending, target);
      await hooks?.afterPhase?.("target");
    }
    if (nodeState === "before") {
      if (nodeNameAfter !== undefined) node.name = nodeNameAfter;
      node.versionCount = transaction.previousVersionCount + 1;
      node.error = null;
      if (transaction.terminalStatus === "ready") {
        node.currentVersionId = manifest.id;
        if (transaction.followsHead) node.selectedVersionId = manifest.id;
        node.state = "ready";
      } else {
        node.state = "superseded";
      }
      node.activeJobId = null;
      node.updatedAt = transaction.createdAt;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision = transaction.projectRevisionBefore + 1;
      project.updatedAt = Math.max(project.updatedAt, transaction.createdAt);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      await hooks?.afterPhase?.("canvas");
    }

    job.status = transaction.terminalStatus;
    job.versionId = manifest.id;
    job.cancelRequested = false;
    job.error = transaction.terminalStatus === "ready"
      ? null
      : "A newer Node head was published before this result completed";
    job.updatedAt = Math.max(job.updatedAt, transaction.createdAt);
    job.finishedAt = job.updatedAt;
    await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
    await hooks?.afterPhase?.("job");
    await rm(publicationTransactionPath(root, transaction.jobId));
    return job;
  }

  async function rollBackUnpublishedPublicationUnlocked(
    root: string,
    transaction: DesignVersionPublicationTransaction,
    timestamp: number,
    pending: string | null = null,
  ): Promise<DesignJob> {
    const job = await readJob(root, transaction.jobId);
    assertPublicationJobAuthority(job, transaction);
    if (!(job.status === "validating" || job.status === "cancelled")) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} rollback Job state is invalid`);
    }
    const project = await readProject(root);
    const nodes = readNodes(project);
    const node = nodes.get(transaction.nodeId);
    if (!node) throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Node is unavailable`);
    const afterRevision = transaction.projectRevisionBefore + 1;
    const nodeNameBefore = transaction.nodeNameBefore ?? node.name;
    const before = project.revision === transaction.projectRevisionBefore && node.name === nodeNameBefore
      && node.currentVersionId === transaction.currentVersionIdBefore
      && node.selectedVersionId === transaction.selectedVersionIdBefore
      && node.versionCount === transaction.previousVersionCount && node.activeJobId === transaction.jobId;
    const after = project.revision === afterRevision && node.name === nodeNameBefore
      && node.currentVersionId === transaction.currentVersionIdBefore
      && node.selectedVersionId === transaction.selectedVersionIdBefore
      && node.versionCount === transaction.previousVersionCount && node.activeJobId === null && node.state === "cancelled";
    if (!before && !after) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} rollback authority is invalid`);
    }
    if (pending !== null) await rm(pending, { recursive: true, force: true });
    if (before) {
      node.state = "cancelled";
      node.activeJobId = null;
      node.error = null;
      node.updatedAt = timestamp;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision = afterRevision;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
    }
    job.status = "cancelled";
    job.cancelRequested = true;
    job.error = "Interrupted before Design Version publication payload was durably staged";
    job.updatedAt = timestamp;
    job.finishedAt = timestamp;
    await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
    await rm(publicationTransactionPath(root, transaction.jobId));
    return job;
  }

  function recoverablePendingPayloadError(error: unknown): boolean {
    return (error instanceof DesignStorageError && (error.code === "missing" || error.code === "corrupt"))
      || (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT");
  }

  async function recoverPublicationTransactionUnlocked(
    root: string,
    transaction: DesignVersionPublicationTransaction,
    timestamp: number,
  ): Promise<DesignJob> {
    const pending = pendingVersionRoot(root, transaction.nodeId, transaction.manifest.id);
    const target = versionRoot(root, transaction.nodeId, transaction.manifest.id);
    const [pendingExists, targetExists] = await Promise.all([exists(pending), exists(target)]);
    if (targetExists) {
      // Once the target exists it is the candidate immutable Version. Any mismatch must remain
      // quarantined behind the durable marker instead of being silently discarded or published.
      return rollForwardPublicationUnlocked(root, transaction);
    }
    if (!pendingExists) return rollBackUnpublishedPublicationUnlocked(root, transaction, timestamp);
    try {
      await verifyPublicationPayload(pending, transaction.manifest);
    } catch (error) {
      if (!recoverablePendingPayloadError(error)) throw error;
      return rollBackUnpublishedPublicationUnlocked(root, transaction, timestamp, pending);
    }
    return rollForwardPublicationUnlocked(root, transaction);
  }

  async function recoverPublicationTransactionsUnlocked(
    root: string,
    projectId: string,
    timestamp: number,
  ): Promise<DesignJob[]> {
    const parent = publicationTransactionsRoot(root);
    if (!(await exists(parent))) return [];
    const entries = await readdir(parent, { withFileTypes: true });
    const recovered: DesignJob[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && /^\.job-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
        await rm(join(parent, entry.name));
        continue;
      }
      if (!entry.isFile() || !/^job-[0-9a-f-]{36}\.json$/.test(entry.name)) {
        throw new DesignStorageError("corrupt", "Design publication transaction identity is invalid");
      }
      const jobId = entry.name.slice(0, -5);
      const transaction = await readPublicationTransaction(root, projectId, jobId);
      recovered.push(await recoverPublicationTransactionUnlocked(root, transaction, timestamp));
    }
    return recovered;
  }

  /** Recover one durable Version publication without terminalizing unrelated interrupted Jobs. */
  async function recoverDesignVersionPublication(
    dataDir: string,
    projectId: string,
    jobId: string,
    now?: number,
  ): Promise<DesignJob | null> {
    const root = designRoot(dataDir, projectId);
    safeSegment(jobId, "Job id");
    return withProjectLock(root, async () => {
      const marker = publicationTransactionPath(root, jobId);
      if (!(await exists(marker))) return null;
      const transaction = await readPublicationTransaction(root, projectId, jobId);
      return recoverPublicationTransactionUnlocked(root, transaction, nowValue(now));
    }, { allowPublicationTransactions: true });
  }

  async function listDesignVersionsUnlocked(root: string, nodeId: string): Promise<DesignVersionManifest[]> {
    safeSegment(nodeId, "Node id");
    const parent = join(nodeRoot(root, nodeId), "versions");
    if (!(await exists(parent))) return [];
    const entries = await readdir(parent, { withFileTypes: true });
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
      .map(async (entry) => {
        const manifest = await readJson<DesignVersionManifest>(join(parent, entry.name, "manifest.json"), `Design Version ${entry.name}`);
        assertStoredVersionManifest(manifest, nodeId, entry.name);
        return manifest;
      }));
    return manifests.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  async function listDesignVersions(
    dataDir: string,
    projectId: string,
    nodeId: string,
  ): Promise<DesignVersionManifest[]> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return listDesignVersionsUnlocked(root, nodeId);
    });
  }

  async function getDesignVersionUnlocked(
    root: string,
    nodeId: string,
    versionId: string,
  ): Promise<DesignVersionManifest> {
    const manifest = await readJson<DesignVersionManifest>(
      join(versionRoot(root, nodeId, versionId), "manifest.json"),
      `Design Version ${versionId}`,
    );
    assertStoredVersionManifest(manifest, nodeId, versionId);
    return manifest;
  }

  async function getDesignVersion(
    dataDir: string,
    projectId: string,
    nodeId: string,
    versionId: string,
  ): Promise<DesignVersionManifest> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return getDesignVersionUnlocked(root, nodeId, versionId);
    });
  }

  async function publishDesignVersion(
    dataDir: string,
    projectId: string,
    input: {
      nodeId: string;
      html: string;
      contextHash: string;
      canvasRevision: number;
      expectedHeadVersionId: string | null;
      jobId: string | null;
      runnerId: string | null;
      model: string | null;
      pageTitle?: string | null;
    },
    now?: number,
    hooks?: DesignVersionPublicationTestHooks,
  ): Promise<{ manifest: DesignVersionManifest; node: DesignNode; job: DesignJob | null }> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const project = await readProject(root);
      const nodeId = safeSegment(input.nodeId, "Node id");
      const nodes = readNodes(project);
      const node = nodes.get(nodeId);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
      if (!(DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind)) {
        throw new DesignStorageError("invalid-input", "Material Nodes cannot publish generated versions");
      }
      if (!SHA256.test(input.contextHash) || !Number.isSafeInteger(input.canvasRevision) || input.canvasRevision < 0) {
        throw new DesignStorageError("invalid-input", "Generation context identity is invalid");
      }
      if (input.expectedHeadVersionId !== null) safeSegment(input.expectedHeadVersionId, "Expected Head Version id");
      if (input.jobId !== null) safeSegment(input.jobId, "Job id");
      if (!validStoredText(input.runnerId, 512, { nullable: true })
        || !validStoredText(input.model, 512, { nullable: true })) {
        throw new DesignStorageError("invalid-input", "Generation runner identity is invalid");
      }
      let authorityJob: DesignJob | null = null;
      if (input.jobId !== null) {
        const authority = await readJob(root, input.jobId);
        if (authority.kind !== "node-generation"
          || authority.nodeId !== nodeId
          || authority.status !== "validating"
          || authority.cancelRequested
          || node.activeJobId !== authority.id
          || authority.contextHash !== input.contextHash
          || authority.canvasRevision !== input.canvasRevision
          || authority.expectedHeadVersionId !== input.expectedHeadVersionId
          || authority.runnerId !== input.runnerId
          || authority.model !== input.model) {
          throw new DesignStorageError(
            "conflict",
            "Generation Version publication requires the active validating Job authority",
          );
        }
        authorityJob = authority;
      }
      // A previous immutable Version already contains checksum-bound canonical
      // Asset URLs. Permit only exact URLs pinned by this Node's expected Head;
      // canonicalizeVersionAssets then rebinds them to the new immutable Version.
      const allowedCanonicalAssetUrls = new Set<string>();
      if (input.expectedHeadVersionId !== null) {
        const expectedHead = await getDesignVersionUnlocked(root, nodeId, input.expectedHeadVersionId);
        for (const pin of expectedHead.assetPins) {
          const asset = await getDesignAssetManifest(dataDir, projectId, pin.assetId);
          if (asset.checksum !== pin.checksum) {
            throw new DesignStorageError("corrupt", `Expected Head Version ${expectedHead.id} has an invalid Asset pin`);
          }
          allowedCanonicalAssetUrls.add(
            `/api/projects/${projectId}/design-canvas/assets/${asset.id}/${asset.fileName}`
              + `?nodeId=${nodeId}&versionId=${expectedHead.id}&checksum=${asset.checksum}`,
          );
        }
      }
      validateDesignHtml(input.html, { allowCanonicalAssets: true });

      const existing = await listDesignVersionsUnlocked(root, nodeId);
      const sequence = existing.reduce((maximum, version) => Math.max(maximum, version.sequence), 0) + 1;
      const versionId = `version-${randomUUID()}`;
      const canonical = await canonicalizeVersionAssets({
        dataDir,
        projectId,
        nodeId,
        versionId,
        html: input.html,
        allowedCanonicalAssetUrls,
      });
      const timestamp = nowValue(now);
      const bytes = Buffer.byteLength(canonical.html, "utf8");
      const checksum = createHash("sha256").update(canonical.html, "utf8").digest("hex");
      const publicationStatus = node.currentVersionId === input.expectedHeadVersionId ? "published" : "superseded";
      const firstPageTitle = input.pageTitle ?? null;
      if (firstPageTitle !== null) {
        if (authorityJob === null || node.kind !== "page" || node.versionCount !== 0
          || extractDesignPageTitle(input.html) !== firstPageTitle) {
          throw new DesignStorageError("conflict", "First Page title does not match its publication authority");
        }
      }
      const nodeNameAfter = firstPageTitle !== null && node.name === "Page" ? firstPageTitle : node.name;
      const manifest: DesignVersionManifest = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        id: versionId,
        nodeId,
        contentKind: "html",
        assetId: null,
        sequence,
        checksum,
        bytes,
        contextHash: input.contextHash,
        canvasRevision: input.canvasRevision,
        expectedHeadVersionId: input.expectedHeadVersionId,
        publicationStatus,
        assetPins: canonical.pins,
        jobId: input.jobId,
        runnerId: input.runnerId,
        model: input.model,
        createdAt: timestamp,
      };

      if (authorityJob !== null) {
        const transactionContent: Omit<DesignVersionPublicationTransaction, "checksum"> = {
          schemaVersion: DESIGN_SCHEMA_VERSION,
          projectId,
          jobId: authorityJob.id,
          nodeId,
          manifest,
          terminalStatus: publicationStatus === "published" ? "ready" : "superseded",
          projectRevisionBefore: project.revision,
          previousVersionCount: node.versionCount,
          nodeNameBefore: node.name,
          nodeNameAfter,
          currentVersionIdBefore: node.currentVersionId,
          selectedVersionIdBefore: node.selectedVersionId,
          followsHead: node.selectedVersionId === null || node.selectedVersionId === node.currentVersionId,
          createdAt: timestamp,
        };
        const transaction: DesignVersionPublicationTransaction = {
          ...transactionContent,
          checksum: publicationTransactionChecksum(transactionContent),
        };
        let markerWritten = false;
        try {
          await mkdir(publicationTransactionsRoot(root), { recursive: true });
          const markerPath = publicationTransactionPath(root, authorityJob.id);
          if (await exists(markerPath)) {
            throw new DesignStorageError("conflict", `Design publication ${authorityJob.id} already has a transaction`);
          }
          await writeAtomicJson(markerPath, transaction);
          markerWritten = true;
          await hooks?.afterPhase?.("marker");

          const pending = pendingVersionRoot(root, nodeId, versionId);
          await mkdir(pending, { recursive: true });
          await hooks?.afterPendingDirectory?.();
          await writeFile(join(pending, "index.html"), canonical.html, { flag: "wx", mode: 0o600 });
          await hooks?.afterPendingIndex?.();
          await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          await hooks?.afterPhase?.("pending");
          const terminalJob = await rollForwardPublicationUnlocked(root, transaction, hooks);
          const committedProject = await readProject(root);
          const committedNode = readNodes(committedProject).get(nodeId);
          if (!committedNode) throw new DesignStorageError("corrupt", `Design publication ${authorityJob.id} lost its Node`);
          return { manifest, node: cloneNode(committedNode), job: terminalJob };
        } catch (error) {
          if (!markerWritten || hooks?.simulateProcessCrash) throw error;
          // Reconcile while this exact Project lock is still held. Letting the lock
          // go first would allow queued Canvas or cancellation writes to invalidate
          // the durable transaction's revision and Job authority.
          const recovered = await recoverPublicationTransactionUnlocked(root, transaction, timestamp);
          if (recovered.status !== transaction.terminalStatus || recovered.versionId !== manifest.id) throw error;
          const committedProject = await readProject(root);
          const committedNode = readNodes(committedProject).get(nodeId);
          if (!committedNode) throw new DesignStorageError("corrupt", `Design publication ${authorityJob.id} lost its Node`);
          return { manifest, node: cloneNode(committedNode), job: recovered };
        }
      }

      const pendingParent = join(nodeRoot(root, nodeId), ".pending");
      const pending = join(pendingParent, versionId);
      const target = versionRoot(root, nodeId, versionId);
      await mkdir(pending, { recursive: true });
      await mkdir(join(nodeRoot(root, nodeId), "versions"), { recursive: true });
      try {
        await writeFile(join(pending, "index.html"), canonical.html, { flag: "wx", mode: 0o600 });
        await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(pending, target);
      } catch (error) {
        await rm(pending, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      node.name = nodeNameAfter;
      node.versionCount = existing.length + 1;
      node.error = null;
      if (publicationStatus === "published") {
        const followsHead = node.selectedVersionId === null || node.selectedVersionId === node.currentVersionId;
        node.currentVersionId = versionId;
        if (followsHead) node.selectedVersionId = versionId;
        node.state = "ready";
      } else if (node.activeJobId === null || node.activeJobId === input.jobId) {
        node.state = "superseded";
      }
      if (node.activeJobId === input.jobId) node.activeJobId = null;
      node.updatedAt = timestamp;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      return { manifest, node: cloneNode(node), job: null };
    });
  }

  return {
    canonicalizeVersionAssets,
    assertStoredPublicationTransaction,
    readPublicationTransaction,
    verifyPublicationPayload,
    assertStoredVersionManifest,
    assertPublicationJobAuthority,
    publicationNodeState,
    rollForwardPublicationUnlocked,
    rollBackUnpublishedPublicationUnlocked,
    recoverablePendingPayloadError,
    recoverPublicationTransactionUnlocked,
    recoverPublicationTransactionsUnlocked,
    recoverDesignVersionPublication,
    listDesignVersionsUnlocked,
    listDesignVersions,
    getDesignVersionUnlocked,
    getDesignVersion,
    publishDesignVersion,
  };
}

export type DesignVersionPublication = ReturnType<typeof createDesignVersionPublication>;
