import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_NODE_KINDS,
  DESIGN_SCHEMA_VERSION,
  type DesignCanvas,
  type DesignCanvasIntent,
  type DesignCanvasSnapshot,
  type DesignJob,
  type DesignNode,
  type DesignNodeGeometry,
  type DesignNodeKind,
  type DesignProjectFile,
  type DesignVersionContentKind,
  type DesignVersionManifest,
  type DesignViewport,
} from "./design-types.ts";
import {
  DesignRevisionConflictError,
  DesignStorageError,
  MAX_HISTORY,
  MAX_RETIRED_NODE_IDS,
  SAFE_SEGMENT,
  SHA256,
  designRoot,
  exists,
  nowValue,
  projectFilePath,
  readJson,
  safeSegment,
  validStoredTimestamp,
  validStoredViewport,
  withProjectLock,
  writeAuthorityJson,
} from "./design-storage-primitives.ts";

export interface DesignCanvasStateSources {
  recoverPendingAssetImportsUnlocked(root: string): Promise<void>;
  getVersionUnlocked(root: string, nodeId: string, versionId: string): Promise<DesignVersionManifest>;
  readJob(root: string, jobId: string): Promise<DesignJob>;
  readMainPlanExecutionUnlocked(
    root: string,
    project: DesignProjectFile,
    receiptKey: string,
  ): Promise<{ planHash: string } | null>;
}

export function createDesignCanvasState(sources: DesignCanvasStateSources) {
  const recoverPendingAssetImportsUnlocked = sources.recoverPendingAssetImportsUnlocked;
  const getDesignVersionUnlocked = sources.getVersionUnlocked;
  const readJob = sources.readJob;
  const readDesignMainPlanExecutionUnlocked = sources.readMainPlanExecutionUnlocked;

  const defaultViewport = (): DesignViewport => ({ x: 0, y: 0, zoom: 1 });

  function defaultGeometry(kind: DesignNodeKind): DesignNodeGeometry {
    if (kind === "page") return { x: 0, y: 0, width: 720, height: 540 };
    if (kind === "component") return { x: 0, y: 0, width: 480, height: 360 };
    if (kind === "image" || kind === "video") return { x: 0, y: 0, width: 420, height: 300 };
    return { x: 0, y: 0, width: 420, height: 280 };
  }

  function finite(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DesignStorageError("invalid-input", `${label} must be finite`);
    }
    return value;
  }

  function geometry(value: Partial<DesignNodeGeometry> | undefined, base: DesignNodeGeometry): DesignNodeGeometry {
    const next = {
      x: value?.x === undefined ? base.x : finite(value.x, "Node x"),
      y: value?.y === undefined ? base.y : finite(value.y, "Node y"),
      width: value?.width === undefined ? base.width : finite(value.width, "Node width"),
      height: value?.height === undefined ? base.height : finite(value.height, "Node height"),
    };
    if (next.width < 120 || next.width > 4_096 || next.height < 80 || next.height > 4_096) {
      throw new DesignStorageError("invalid-input", "Node size is outside the supported bounds");
    }
    return next;
  }

  function viewport(value: DesignViewport): DesignViewport {
    const normalized = {
      x: finite(value?.x, "Viewport x"),
      y: finite(value?.y, "Viewport y"),
      zoom: finite(value?.zoom, "Viewport zoom"),
    };
    if (normalized.zoom < 0.05 || normalized.zoom > 8) {
      throw new DesignStorageError("invalid-input", "Viewport zoom is outside the supported bounds");
    }
    return normalized;
  }

  function nodeKind(value: unknown): DesignNodeKind {
    if (typeof value !== "string" || !(DESIGN_NODE_KINDS as readonly string[]).includes(value)) {
      throw new DesignStorageError("invalid-input", "Node kind is unsupported");
    }
    return value as DesignNodeKind;
  }

  function nodeName(value: unknown, kind: DesignNodeKind): string {
    if (value === undefined) return kind.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 256) {
      throw new DesignStorageError("invalid-input", "Node name is invalid");
    }
    return value.trim();
  }

  function cloneNode(node: DesignNode): DesignNode {
    return { ...node, geometry: { ...node.geometry } };
  }

  function snapshot(project: DesignProjectFile, nodes: Map<string, DesignNode>): DesignCanvasSnapshot {
    return {
      viewport: { ...project.viewport },
      nodeOrder: [...project.nodeOrder],
      nodes: project.nodeOrder.map((id) => cloneNode(nodes.get(id)!)),
    };
  }

  async function ensureDesignDirectories(root: string): Promise<void> {
    await Promise.all([
      mkdir(join(root, "nodes"), { recursive: true }),
      mkdir(join(root, "assets"), { recursive: true }),
      mkdir(join(root, "agents", "main"), { recursive: true }),
      mkdir(join(root, "agents", "main", "executions"), { recursive: true }),
      mkdir(join(root, "jobs"), { recursive: true }),
      mkdir(join(root, "exports"), { recursive: true }),
      mkdir(join(root, "transactions", "publications"), { recursive: true }),
    ]);
  }

  async function initializeUnlocked(root: string, projectId: string, now?: number): Promise<DesignCanvas> {
    await ensureDesignDirectories(root);
    if (!(await exists(projectFilePath(root)))) {
      const timestamp = nowValue(now);
      const project: DesignProjectFile = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        projectId,
        revision: 0,
        viewport: defaultViewport(),
        nodeOrder: [],
        nodes: [],
        retiredNodeIds: [],
        undo: [],
        redo: [],
        turnReceipts: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
    }
    await recoverPendingAssetImportsUnlocked(root);
    return readCanvasUnlocked(root);
  }

  async function requireInitialized(root: string): Promise<void> {
    if (!(await exists(projectFilePath(root)))) {
      throw new DesignStorageError("not-found", "This Project is not a Design Canvas project");
    }
  }

  async function readProject(root: string): Promise<DesignProjectFile> {
    const project = await readJson<DesignProjectFile>(projectFilePath(root), "Design project");
    const expectedProjectId = basename(resolve(root, ".."));
    assertStoredProject(project, expectedProjectId);
    return project;
  }

  function assertStoredProject(
    project: DesignProjectFile,
    expectedProjectId: string,
  ): asserts project is DesignProjectFile {
    if (project.schemaVersion !== DESIGN_SCHEMA_VERSION || !Number.isSafeInteger(project.revision)
      || project.revision < 0 || !Array.isArray(project.nodeOrder) || !Array.isArray(project.nodes)
      || !Array.isArray(project.retiredNodeIds) || project.retiredNodeIds.length > MAX_RETIRED_NODE_IDS
      || new Set(project.retiredNodeIds).size !== project.retiredNodeIds.length
      || project.retiredNodeIds.some((id) => typeof id !== "string" || !SAFE_SEGMENT.test(id))
      || !Array.isArray(project.undo)
      || !Array.isArray(project.redo) || project.turnReceipts === null
      || typeof project.turnReceipts !== "object" || Array.isArray(project.turnReceipts)
      || project.projectId !== expectedProjectId
      || !validStoredViewport(project.viewport)
      || !validStoredTimestamp(project.createdAt) || !validStoredTimestamp(project.updatedAt)
      || project.nodes.length > 500 || project.undo.length > MAX_HISTORY || project.redo.length > MAX_HISTORY
      || Object.keys(project.turnReceipts).length > 5_000) {
      throw new DesignStorageError("corrupt", "Design project schema is invalid");
    }
    const nodeIds = project.nodes.map((node) => node?.id);
    if (nodeIds.length !== project.nodeOrder.length
      || new Set(nodeIds).size !== nodeIds.length
      || project.nodeOrder.some((id, index) => id !== nodeIds[index] || !SAFE_SEGMENT.test(id))) {
      throw new DesignStorageError("corrupt", "Design project Node authority is inconsistent");
    }
    for (const node of project.nodes) assertStoredNode(node);
    for (const history of [...project.undo, ...project.redo]) assertStoredSnapshot(history);
    for (const [key, receipt] of Object.entries(project.turnReceipts)) {
      if (typeof key !== "string" || key.length < 1 || key.length > 512 || !receipt
        || typeof receipt !== "object" || !SAFE_SEGMENT.test(receipt.jobId)
        || !["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(receipt.kind)
        || (receipt.nodeId !== null && !SAFE_SEGMENT.test(receipt.nodeId))
        || !(receipt.requestHash === undefined || SHA256.test(receipt.requestHash))
        || !(receipt.authorityHash === undefined || SHA256.test(receipt.authorityHash))
        || !(receipt.mainPlanHash === undefined || SHA256.test(receipt.mainPlanHash))
        || !(receipt.mainPlanAppliedRevision === undefined
          || (Number.isSafeInteger(receipt.mainPlanAppliedRevision)
            && receipt.mainPlanAppliedRevision >= 0
            && receipt.mainPlanAppliedRevision <= project.revision))
        || ((receipt.mainPlanHash !== undefined || receipt.mainPlanAppliedRevision !== undefined)
          && receipt.kind !== "main-agent")
        || (receipt.mainPlanAppliedRevision !== undefined && receipt.mainPlanHash === undefined)
        || !validStoredTimestamp(receipt.createdAt)) {
        throw new DesignStorageError("corrupt", "Design project contains an invalid Agent receipt");
      }
    }
  }

  function assertStoredNode(value: unknown): asserts value is DesignNode {
    if (!value || typeof value !== "object") throw new DesignStorageError("corrupt", "Design project contains an invalid Node");
    const node = value as Partial<DesignNode>;
    const validGeometry = node.geometry && typeof node.geometry === "object"
      && [node.geometry.x, node.geometry.y, node.geometry.width, node.geometry.height]
        .every((part) => typeof part === "number" && Number.isFinite(part))
      && node.geometry.width >= 120 && node.geometry.width <= 4_096
      && node.geometry.height >= 80 && node.geometry.height <= 4_096;
    const validOptionalId = (candidate: unknown) => candidate === null
      || (typeof candidate === "string" && SAFE_SEGMENT.test(candidate));
    if (typeof node.id !== "string" || !SAFE_SEGMENT.test(node.id)
      || typeof node.kind !== "string" || !(DESIGN_NODE_KINDS as readonly string[]).includes(node.kind)
      || typeof node.name !== "string" || !node.name.trim() || Buffer.byteLength(node.name, "utf8") > 256
      || !validGeometry
      || typeof node.state !== "string" || !["empty", "queued", "generating", "validating", "ready", "failed", "cancelled", "superseded"].includes(node.state)
      || !validOptionalId(node.currentVersionId) || !validOptionalId(node.selectedVersionId)
      || !Number.isSafeInteger(node.versionCount) || (node.versionCount as number) < 0
      || !validOptionalId(node.assetId) || !validOptionalId(node.activeJobId)
      || (node.error !== null && (typeof node.error !== "string" || Buffer.byteLength(node.error, "utf8") > 16_384))
      || !validStoredTimestamp(node.createdAt) || !validStoredTimestamp(node.updatedAt)) {
      throw new DesignStorageError("corrupt", "Design project contains an invalid Node record");
    }
    const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
    const hasHead = node.currentVersionId !== null;
    if ((generative && node.assetId !== null)
      || (!generative && (
        hasHead !== ((node.versionCount as number) > 0)
        || (hasHead !== (node.assetId !== null))
        || (!hasHead && node.selectedVersionId !== null)
      ))) {
      throw new DesignStorageError("corrupt", "Design project Node payload ownership is inconsistent");
    }
  }

  function assertStoredSnapshot(value: unknown): asserts value is DesignCanvasSnapshot {
    if (!value || typeof value !== "object") throw new DesignStorageError("corrupt", "Design canvas history is invalid");
    const history = value as Partial<DesignCanvasSnapshot>;
    if (!validStoredViewport(history.viewport) || !Array.isArray(history.nodeOrder) || !Array.isArray(history.nodes)
      || history.nodes.length > 500 || history.nodeOrder.length !== history.nodes.length) {
      throw new DesignStorageError("corrupt", "Design canvas history is invalid");
    }
    for (const node of history.nodes) assertStoredNode(node);
    const ids = history.nodes.map((node) => node.id);
    if (new Set(ids).size !== ids.length || history.nodeOrder.some((id, index) => id !== ids[index])) {
      throw new DesignStorageError("corrupt", "Design canvas history Node order is invalid");
    }
  }

  function readNodes(project: DesignProjectFile): Map<string, DesignNode> {
    const ids = new Set<string>();
    const nodes = new Map<string, DesignNode>();
    for (const node of project.nodes) {
      if (!node || typeof node.id !== "string") {
        throw new DesignStorageError("corrupt", "Design project contains an invalid Node record");
      }
      const id = node.id;
      safeSegment(id, "Node id");
      if (ids.has(id)) throw new DesignStorageError("corrupt", "Design project contains duplicate Node ids");
      ids.add(id);
      nodes.set(id, cloneNode(node));
    }
    return nodes;
  }

  function canvas(project: DesignProjectFile, nodes: Map<string, DesignNode>): DesignCanvas {
    return {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      projectId: project.projectId,
      revision: project.revision,
      viewport: { ...project.viewport },
      nodeOrder: [...project.nodeOrder],
      nodes: project.nodeOrder.map((id) => cloneNode(nodes.get(id)!)),
      undoDepth: project.undo.length,
      redoDepth: project.redo.length,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  async function readCanvasUnlocked(root: string): Promise<DesignCanvas> {
    const project = await readProject(root);
    return canvas(project, readNodes(project));
  }

  async function initializeDesignProject(dataDir: string, projectId: string, now?: number): Promise<DesignCanvas> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, () => initializeUnlocked(root, projectId, now), {
      allowPublicationTransactions: true,
    });
  }

  async function getDesignCanvas(dataDir: string, projectId: string): Promise<DesignCanvas> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      return readCanvasUnlocked(root);
    });
  }

  function retireNodeIdentities(project: DesignProjectFile, candidates: Iterable<string>): void {
    const additions: string[] = [];
    for (const id of candidates) {
      if (!project.retiredNodeIds.includes(id) && !additions.includes(id)) additions.push(id);
    }
    if (project.retiredNodeIds.length + additions.length > MAX_RETIRED_NODE_IDS) {
      throw new DesignStorageError(
        "limit",
        "Design canvas retired Node identity limit reached",
      );
    }
    project.retiredNodeIds.push(...additions);
  }

  async function addNode(
    project: DesignProjectFile,
    nodes: Map<string, DesignNode>,
    intent: Extract<DesignCanvasIntent, { type: "add-node" }>,
    timestamp: number,
  ): Promise<DesignNode> {
    const kind = nodeKind(intent.node?.kind);
    const id = safeSegment(intent.node.id ?? `node-${randomUUID()}`, "Node id");
    if (nodes.has(id) || project.nodeOrder.includes(id) || project.retiredNodeIds.includes(id) || project.nodeOrder.length >= 500) {
      throw new DesignStorageError(
        "conflict",
        nodes.has(id) || project.retiredNodeIds.includes(id)
          ? `Design Node identity ${id} already exists or was retired`
          : "Design canvas Node limit reached",
      );
    }
    const assetId = intent.node.assetId ?? null;
    if (assetId !== null) safeSegment(assetId, "Asset id");
    if (assetId !== null) {
      throw new DesignStorageError(
        "invalid-input",
        "Material Assets must be bound through the atomic Asset import API so v1 cannot be skipped",
      );
    }
    const created: DesignNode = {
      id,
      kind,
      name: nodeName(intent.node.name, kind),
      geometry: geometry(intent.node.geometry, defaultGeometry(kind)),
      state: "empty",
      currentVersionId: null,
      selectedVersionId: null,
      versionCount: 0,
      assetId: null,
      activeJobId: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    nodes.set(id, created);
    project.nodeOrder.push(id);
    return created;
  }

  async function applyIntent(
    dataDir: string,
    projectId: string,
    project: DesignProjectFile,
    nodes: Map<string, DesignNode>,
    intent: DesignCanvasIntent,
    timestamp: number,
    changed: Set<string>,
  ): Promise<void> {
    if (!intent || typeof intent !== "object") throw new DesignStorageError("invalid-input", "Canvas intent is invalid");
    if (intent.type === "add-node") {
      changed.add((await addNode(project, nodes, intent, timestamp)).id);
      return;
    }
    if (intent.type === "remove-node") {
      const id = safeSegment(intent.nodeId, "Node id");
      const node = nodes.get(id);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${id} was not found`);
      if (node.activeJobId !== null) {
        throw new DesignStorageError("conflict", "Cancel the active scoped Agent Job before removing this Node");
      }
      nodes.delete(id);
      project.nodeOrder = project.nodeOrder.filter((candidate) => candidate !== id);
      retireNodeIdentities(project, [id]);
      return;
    }
    if (intent.type === "set-viewport") {
      project.viewport = viewport(intent.viewport);
      return;
    }
    if (intent.type === "replace-layout") {
      if (!Array.isArray(intent.nodes) || intent.nodes.length > project.nodeOrder.length) {
        throw new DesignStorageError("invalid-input", "Replacement layout is invalid");
      }
      const seen = new Set<string>();
      for (const entry of intent.nodes) {
        const id = safeSegment(entry.nodeId, "Node id");
        if (seen.has(id)) throw new DesignStorageError("invalid-input", "Replacement layout repeats a Node");
        seen.add(id);
        const node = nodes.get(id);
        if (!node) throw new DesignStorageError("not-found", `Design Node ${id} was not found`);
        node.geometry = geometry(entry.geometry, node.geometry);
        node.updatedAt = timestamp;
        changed.add(id);
      }
      return;
    }
    if (intent.type === "update-node") {
      const id = safeSegment(intent.nodeId, "Node id");
      const node = nodes.get(id);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${id} was not found`);
      const patch = intent.patch;
      if (!patch || typeof patch !== "object") throw new DesignStorageError("invalid-input", "Node patch is invalid");
      if (patch.name !== undefined) node.name = nodeName(patch.name, node.kind);
      if (patch.geometry !== undefined) node.geometry = geometry(patch.geometry, node.geometry);
      if (patch.selectedVersionId !== undefined) {
        if (patch.selectedVersionId !== null) {
          safeSegment(patch.selectedVersionId, "Version id");
          const selected = await getDesignVersionUnlocked(designRoot(dataDir, projectId), node.id, patch.selectedVersionId);
          const expectedContentKind: DesignVersionContentKind = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[])
            .includes(node.kind) ? "html" : "asset";
          if (selected.contentKind !== expectedContentKind) {
            throw new DesignStorageError("corrupt", `Design Version ${selected.id} does not match Node kind ${node.kind}`);
          }
        }
        node.selectedVersionId = patch.selectedVersionId;
      }
      node.updatedAt = timestamp;
      changed.add(id);
      return;
    }
    throw new DesignStorageError("invalid-input", "Canvas intent is unsupported");
  }

  async function mutateDesignCanvas(
    dataDir: string,
    projectId: string,
    input: {
      expectedRevision: number;
      intents: DesignCanvasIntent[];
      /** Internal Main Agent application receipt committed with the Canvas bytes. */
      mainPlanApplication?: { jobId: string; receiptKey: string; planHash: string };
    },
    now?: number,
  ): Promise<DesignCanvas> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const project = await readProject(root);
      let mainPlanReceipt: DesignProjectFile["turnReceipts"][string] | null = null;
      if (input.mainPlanApplication !== undefined) {
        const application = input.mainPlanApplication;
        if (!application || typeof application !== "object" || Array.isArray(application)
          || Object.keys(application).some((key) => !["jobId", "receiptKey", "planHash"].includes(key))
          || typeof application.receiptKey !== "string" || !application.receiptKey
          || application.receiptKey.length > 512 || !SHA256.test(application.planHash)) {
          throw new DesignStorageError("invalid-input", "Main Agent plan application receipt is invalid");
        }
        const jobId = safeSegment(application.jobId, "Job id");
        const receipt = project.turnReceipts[application.receiptKey];
        const job = await readJob(root, jobId);
        const execution = await readDesignMainPlanExecutionUnlocked(root, project, application.receiptKey);
        if (!receipt || receipt.kind !== "main-agent" || receipt.nodeId !== null || receipt.jobId !== job.id
          || receipt.authorityHash !== job.contextHash || job.kind !== "main-agent" || job.status !== "running"
          || execution === null || execution.planHash !== application.planHash) {
          throw new DesignStorageError("conflict", "Main Agent plan application requires its active Job authority");
        }
        if (receipt.mainPlanAppliedRevision !== undefined) return canvas(project, readNodes(project));
        mainPlanReceipt = receipt;
      }
      if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
        throw new DesignStorageError("invalid-input", "expectedRevision is invalid");
      }
      if (input.expectedRevision !== project.revision) {
        throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
      }
      if (!Array.isArray(input.intents) || input.intents.length > 100
        || (input.intents.length < 1 && mainPlanReceipt === null)) {
        throw new DesignStorageError("invalid-input", "Canvas mutation must contain 1 to 100 intents");
      }
      const timestamp = nowValue(now);
      const nodes = readNodes(project);
      if (input.intents.length === 0) {
        mainPlanReceipt!.mainPlanAppliedRevision = project.revision;
        project.updatedAt = Math.max(project.updatedAt, timestamp);
        await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
        return canvas(project, nodes);
      }
      const before = snapshot(project, nodes);
      const changed = new Set<string>();
      for (const intent of input.intents) await applyIntent(dataDir, projectId, project, nodes, intent, timestamp, changed);
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      if (input.intents.some((intent) => intent.type !== "set-viewport")) {
        project.undo = [...project.undo, before].slice(-MAX_HISTORY);
        project.redo = [];
      }
      project.revision += 1;
      if (mainPlanReceipt !== null) mainPlanReceipt.mainPlanAppliedRevision = project.revision;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      return canvas(project, nodes);
    });
  }

  async function restoreCanvasHistory(
    dataDir: string,
    projectId: string,
    expectedRevision: number,
    direction: "undo" | "redo",
    now?: number,
  ): Promise<DesignCanvas> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const project = await readProject(root);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== project.revision) {
        throw new DesignRevisionConflictError(expectedRevision, project.revision);
      }
      const source = direction === "undo" ? project.undo : project.redo;
      if (source.length === 0) throw new DesignStorageError("conflict", `There is nothing to ${direction}`);
      const currentNodes = readNodes(project);
      const current = snapshot(project, currentNodes);
      const target = source.at(-1)!;
      const targetNodeIds = new Set(target.nodeOrder);
      const activeNodeRemoved = project.nodeOrder.find((id) => (
        currentNodes.get(id)?.activeJobId !== null && !targetNodeIds.has(id)
      ));
      const activeNodeRevived = target.nodes.find((node) => (
        node.activeJobId !== null && !currentNodes.has(node.id)
      ));
      if (activeNodeRemoved || activeNodeRevived) {
        throw new DesignStorageError(
          "conflict",
          "Cancel active scoped Agent Jobs before undoing or redoing a structural Node change",
        );
      }
      // A Node id is also the durable namespace for its immutable Versions and
      // scoped Agent thread. History may restore that same Node, but once any
      // restore removes it from the live Canvas, a later add-node must never
      // alias a fresh Node onto the old on-disk namespace.
      retireNodeIdentities(project, project.nodeOrder.filter((id) => !targetNodeIds.has(id)));
      const restored = new Map(target.nodes.map((snapshotNode) => {
        const currentNode = currentNodes.get(snapshotNode.id);
        if (!currentNode) return [snapshotNode.id, cloneNode(snapshotNode)] as const;
        const generationAuthorityAdvanced = currentNode.currentVersionId !== snapshotNode.currentVersionId;
        return [snapshotNode.id, {
          ...cloneNode(snapshotNode),
          state: currentNode.state,
          currentVersionId: currentNode.currentVersionId,
          selectedVersionId: generationAuthorityAdvanced
            ? currentNode.selectedVersionId
            : snapshotNode.selectedVersionId,
          versionCount: currentNode.versionCount,
          assetId: currentNode.assetId,
          activeJobId: currentNode.activeJobId,
          error: currentNode.error,
          updatedAt: currentNode.updatedAt,
        }] as const;
      }));
      for (const id of target.nodeOrder) {
        if (!restored.get(id)) throw new DesignStorageError("corrupt", "Canvas history snapshot is incomplete");
      }
      // Camera position is a durable user preference, not an undoable document edit.
      // Preserve the live viewport across undo/redo of ordinary Node mutations.
      project.nodeOrder = [...target.nodeOrder];
      project.nodes = project.nodeOrder.map((id) => cloneNode(restored.get(id)!));
      if (direction === "undo") {
        project.undo = project.undo.slice(0, -1);
        project.redo = [...project.redo, current].slice(-MAX_HISTORY);
      } else {
        project.redo = project.redo.slice(0, -1);
        project.undo = [...project.undo, current].slice(-MAX_HISTORY);
      }
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, nowValue(now));
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      return canvas(project, restored);
    });
  }

  function undoDesignCanvas(
    dataDir: string,
    projectId: string,
    expectedRevision: number,
    now?: number,
  ): Promise<DesignCanvas> {
    return restoreCanvasHistory(dataDir, projectId, expectedRevision, "undo", now);
  }

  function redoDesignCanvas(
    dataDir: string,
    projectId: string,
    expectedRevision: number,
    now?: number,
  ): Promise<DesignCanvas> {
    return restoreCanvasHistory(dataDir, projectId, expectedRevision, "redo", now);
  }

  return {
    addNode,
    assertStoredProject,
    canvas,
    cloneNode,
    getDesignCanvas,
    initializeDesignProject,
    mutateDesignCanvas,
    readCanvasUnlocked,
    readNodes,
    readProject,
    redoDesignCanvas,
    requireInitialized,
    snapshot,
    undoDesignCanvas,
  };
}

export type DesignCanvasState = ReturnType<typeof createDesignCanvasState>;
