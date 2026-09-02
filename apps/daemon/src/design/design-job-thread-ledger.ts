import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_JOB_TOOL_NAMES,
  DESIGN_SCHEMA_VERSION,
  type DesignCanvas,
  type DesignFrozenContext,
  type DesignInvalidationTopic,
  type DesignJob,
  type DesignJobActivity,
  type DesignJobKind,
  type DesignJobStatus,
  type DesignJobToolName,
  type DesignMainSessionList,
  type DesignNode,
  type DesignNodeState,
  type DesignProjectFile,
  type DesignThread,
  type DesignThreadMessage,
  type DesignThreadRole,
} from "./design-types.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";
import type { DesignAssetVersionPublication } from "./design-asset-version-publication.ts";
import { stableStringify } from "../canonical-json.ts";
import { commitDesignAuthorityChange } from "./design-invalidation-journal.ts";
import {
  assertStoredFrozenContext,
  buildFrozenContextUnlocked,
} from "./design-frozen-context.ts";
import {
  DesignRevisionConflictError,
  DesignStorageError,
  MAX_JOB_ACTIVITY,
  MAX_THREAD_CONTENT_BYTES,
  MAX_THREAD_MESSAGES,
  SAFE_SEGMENT,
  SHA256,
  designRoot,
  exists,
  jobFilePath,
  nodeRoot,
  nowValue,
  projectFilePath,
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

const DESIGN_JOB_TOOL_CALL_ID_MAX_BYTES = 512;
const DESIGN_JOB_TOOL_INPUT_MAX_BYTES = 64 * 1024;
const DESIGN_JOB_TOOL_RESULT_MAX_BYTES = 64 * 1024;
const DESIGN_JOB_TOOL_DIFF_MAX_BYTES = 128 * 1024;

function validDesignJobToolInput(value: unknown): value is string {
  if (!validStoredText(value, DESIGN_JOB_TOOL_INPUT_MAX_BYTES)) return false;
  try {
    const parsed = JSON.parse(value as string);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export interface DesignMainPlanExecution {
  executionId: string;
  sourceJobId: string;
  planHash: string;
  planPayload: string;
  planningAuthorityHash: string;
  canvasRevision: number;
  runnerId: string;
  model: string | null;
  appliedRevision: number | null;
}

export const DESIGN_JOB_RESTART_INTERRUPTION_ERROR = "Interrupted by daemon restart";

export type DesignJobTerminalReceiptPolicy =
  | "reuse"
  | "retry-restart-interrupted";

export interface CreateDesignJobInput {
  kind: DesignJobKind;
  runnerId: string;
  model: string | null;
  nodeId?: string | null;
  parentJobId?: string | null;
  /** Optional daemon-owned Export identity persisted with a fresh Export Job. */
  exportId?: string | null;
  expectedCanvasRevision?: number;
  idempotencyKey?: string | null;
  /**
   * Controls exact terminal receipt replay. Bootstrap recovery retries only a
   * daemon-restart orphan; provider failures and user cancellations stay
   * terminal until an explicit Repair action.
   */
  terminalReceiptPolicy?: DesignJobTerminalReceiptPolicy;
  /** SHA-256 of the normalized system prompt and user message, supplied by the turn caller. */
  promptHash?: string | null;
  /** Ordered priority context whose semantics affect the turn. */
  contextNodeIds?: readonly string[];
  /**
   * Reserve the request/status message and its assistant projection under the
   * same Project lock as fresh Job creation. Scope and request role are derived
   * from the Job kind so callers cannot reserve a turn in another authority.
   */
  reserveThreadTurn?: { requestContent: string; assistantContent: string };
  /** Reserve both Main Agent messages under the same Project lock as Job creation. */
  reserveMainThreadTurn?: { userContent: string; assistantContent: string };
}

export interface DesignThreadTurnReservation {
  thread: DesignThread;
  requestMessageId: string;
  assistantMessageId: string;
}

export interface CreatedDesignJob {
  job: DesignJob;
  reused: boolean;
  canvas: DesignCanvas;
  receiptKey: string | null;
  threadTurnReservation: DesignThreadTurnReservation | null;
  /** @deprecated Main-only compatibility alias for threadTurnReservation. */
  mainThreadReservation: { thread: DesignThread; assistantMessageId: string } | null;
}

export interface DesignJobReceiptLookup {
  kind: DesignJobKind;
  nodeId: string | null;
  idempotencyKey: string;
  /** The normalized turn request hash stored in the Project receipt. */
  requestHash: string;
}

export type DesignJobCreationPhase =
  | "marker"
  | "context"
  | "job"
  | "thread"
  | "project"
  | "committed"
  | "delete";

export interface DesignJobCreationTestHooks {
  /** Test-only: leave the durable marker exactly as a process exit would. */
  simulateProcessCrash?: boolean;
  afterPhase?: (phase: DesignJobCreationPhase) => void | Promise<void>;
}

type DesignJobCreationTransactionPhase = "pending" | "committed";

interface DesignJobCreationThreadBinding {
  scope: { type: "main" } | { type: "node"; nodeId: string };
  existedBefore: boolean;
  beforeUpdatedAt: number;
  beforeHash: string;
  afterHash: string;
  requestMessage: DesignThreadMessage;
  assistantMessage: DesignThreadMessage;
}

interface DesignJobCreationTransaction {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  projectId: string;
  phase: DesignJobCreationTransactionPhase;
  job: DesignJob;
  jobHash: string;
  contextHash: string;
  thread: DesignJobCreationThreadBinding | null;
  receiptKey: string | null;
  projectBefore: DesignProjectFile;
  projectAfter: DesignProjectFile;
  projectBeforeHash: string;
  projectAfterHash: string;
  createdAt: number;
  checksum: string;
}

export interface DesignJobThreadLedgerSources {
  canvasState: Pick<
    DesignCanvasState,
    | "canvas"
    | "cloneNode"
    | "assertStoredProject"
    | "readNodes"
    | "readProject"
    | "requireInitialized"
  >;
  publicationState: Pick<
    DesignAssetVersionPublication,
    | "getDesignAssetManifest"
    | "getDesignVersionUnlocked"
    | "recoverPublicationTransactionsUnlocked"
  >;
}

export function createDesignJobThreadLedger(sources: DesignJobThreadLedgerSources) {
  const assertStoredProject: DesignCanvasState["assertStoredProject"] = sources.canvasState.assertStoredProject;
  const {
    canvas,
    cloneNode,
    readNodes,
    readProject,
    requireInitialized,
  } = sources.canvasState;
  const {
    getDesignAssetManifest,
    getDesignVersionUnlocked,
    recoverPublicationTransactionsUnlocked,
  } = sources.publicationState;
  const frozenContextSources = {
    readNodes,
    getVersionUnlocked: getDesignVersionUnlocked,
    getAsset: getDesignAssetManifest,
  };

  function threadFilePath(root: string, scope: { type: "main" } | { type: "node"; nodeId: string }): string {
    if (scope.type === "main") return join(root, "agents", "main", "thread.json");
    return join(nodeRoot(root, scope.nodeId), "agent", "thread.json");
  }

  function threadInvalidationTopic(
    scope: { type: "main" } | { type: "node"; nodeId: string },
  ): DesignInvalidationTopic {
    return scope.type === "main" ? "thread:main" : `thread:node:${scope.nodeId}`;
  }

  function newThread(
    scope: { type: "main" } | { type: "node"; nodeId: string },
    timestamp: number,
  ): DesignThread {
    return {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id: scope.type === "main" ? "thread-main" : `thread-${scope.nodeId}`,
      scope: scope.type === "main" ? { type: "main" } : { type: "node", nodeId: scope.nodeId },
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  function assertStoredThread(
    value: unknown,
    expectedScope: { type: "main" } | { type: "node"; nodeId: string },
  ): asserts value is DesignThread {
    const expectedId = expectedScope.type === "main" ? "thread-main" : `thread-${expectedScope.nodeId}`;
    const thread = storedRecord(value, "Design Agent thread", [
      "schemaVersion", "id", "scope", "messages", "createdAt", "updatedAt",
    ]);
    const scope = storedRecord(thread.scope, "Design Agent thread scope", expectedScope.type === "main" ? ["type"] : ["type", "nodeId"]);
    const validScope = expectedScope.type === "main"
      ? scope.type === "main"
      : scope.type === "node" && scope.nodeId === expectedScope.nodeId && SAFE_SEGMENT.test(expectedScope.nodeId);
    if (thread.schemaVersion !== DESIGN_SCHEMA_VERSION || thread.id !== expectedId || !validScope
      || !Array.isArray(thread.messages) || thread.messages.length > MAX_THREAD_MESSAGES
      || !validStoredTimestamp(thread.createdAt) || !validStoredTimestamp(thread.updatedAt)) {
      throw new DesignStorageError("corrupt", "Design Agent thread is invalid");
    }
    const messageIds = new Set<string>();
    for (const [index, entry] of thread.messages.entries()) {
      const message = storedRecord(entry, `Design Agent thread message ${index}`, ["id", "role", "content", "jobId", "createdAt"]);
      if (typeof message.id !== "string" || !SAFE_SEGMENT.test(message.id) || messageIds.has(message.id)
        || !["user", "assistant", "system", "tool"].includes(String(message.role))
        || !validStoredText(message.content, MAX_THREAD_CONTENT_BYTES)
        || (message.content as string).trim() !== message.content
        || !validStoredNullableId(message.jobId)
        || !validStoredTimestamp(message.createdAt)) {
        throw new DesignStorageError("corrupt", `Design Agent thread message ${index} is invalid`);
      }
      messageIds.add(message.id);
    }
  }

  async function readThreadOrNewUnlocked(
    root: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
    now?: number,
  ): Promise<DesignThread> {
    if (scope.type === "node") {
      safeSegment(scope.nodeId, "Node id");
      const project = await readProject(root);
      if (!project.nodeOrder.includes(scope.nodeId)) {
        throw new DesignStorageError("not-found", `Design Node ${scope.nodeId} was not found`);
      }
    }
    const path = threadFilePath(root, scope);
    if (!(await exists(path))) return newThread(scope, nowValue(now));
    const thread = await readJson<DesignThread>(path, "Design Agent thread");
    assertStoredThread(thread, scope);
    return thread;
  }

  async function readOrCreateThreadUnlocked(
    root: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
    now?: number,
  ): Promise<DesignThread> {
    const path = threadFilePath(root, scope);
    const existed = await exists(path);
    const thread = await readThreadOrNewUnlocked(root, scope, now);
    if (!existed) await writeAuthorityJson(root, path, thread, [threadInvalidationTopic(scope)]);
    return thread;
  }

  async function getDesignThread(
    dataDir: string,
    projectId: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
  ): Promise<DesignThread> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return readOrCreateThreadUnlocked(root, scope);
    });
  }

  async function appendDesignThreadMessage(
    dataDir: string,
    projectId: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
    input: { role: DesignThreadRole; content: string; jobId?: string | null },
    now?: number,
  ): Promise<{ thread: DesignThread; message: DesignThreadMessage }> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const thread = await readOrCreateThreadUnlocked(root, scope, now);
      if (!["user", "assistant", "system", "tool"].includes(input?.role)
        || typeof input?.content !== "string" || !input.content.trim()
        || Buffer.byteLength(input.content, "utf8") > MAX_THREAD_CONTENT_BYTES) {
        throw new DesignStorageError("invalid-input", "Design Agent message is invalid");
      }
      if (thread.messages.length >= MAX_THREAD_MESSAGES) {
        throw new DesignStorageError("limit", "Design Agent thread message limit reached");
      }
      const jobId = input.jobId ?? null;
      if (jobId !== null) safeSegment(jobId, "Job id");
      const timestamp = nowValue(now);
      const message: DesignThreadMessage = {
        id: `message-${randomUUID()}`,
        role: input.role,
        content: input.content.trim(),
        jobId,
        createdAt: timestamp,
      };
      thread.messages.push(message);
      thread.updatedAt = timestamp;
      await writeAuthorityJson(
        root,
        threadFilePath(root, scope),
        thread,
        [threadInvalidationTopic(scope)],
      );
      return { thread, message };
    });
  }

  async function updateDesignThreadMessage(
    dataDir: string,
    projectId: string,
    scope: { type: "main" } | { type: "node"; nodeId: string },
    messageId: string,
    input: { content: string; expectedRole?: DesignThreadRole; expectedJobId?: string | null },
    now?: number,
  ): Promise<{ thread: DesignThread; message: DesignThreadMessage }> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      safeSegment(messageId, "Thread message id");
      if (typeof input?.content !== "string" || !input.content.trim()
        || Buffer.byteLength(input.content, "utf8") > MAX_THREAD_CONTENT_BYTES) {
        throw new DesignStorageError("invalid-input", "Design Agent message is invalid");
      }
      if (input.expectedRole !== undefined && !["user", "assistant", "system", "tool"].includes(input.expectedRole)) {
        throw new DesignStorageError("invalid-input", "Design Agent expected message role is invalid");
      }
      const expectedJobId = input.expectedJobId === undefined ? undefined : input.expectedJobId;
      if (expectedJobId !== undefined && expectedJobId !== null) safeSegment(expectedJobId, "Expected Job id");
      const thread = await readThreadOrNewUnlocked(root, scope, now);
      const index = thread.messages.findIndex((message) => message.id === messageId);
      if (index < 0) throw new DesignStorageError("not-found", `Design Agent message ${messageId} was not found`);
      const current = thread.messages[index]!;
      if ((input.expectedRole !== undefined && current.role !== input.expectedRole)
        || (expectedJobId !== undefined && current.jobId !== expectedJobId)) {
        throw new DesignStorageError("conflict", `Design Agent message ${messageId} no longer matches its reservation`);
      }
      const message = { ...current, content: input.content.trim() };
      thread.messages[index] = message;
      thread.updatedAt = nowValue(now);
      await writeAuthorityJson(
        root,
        threadFilePath(root, scope),
        thread,
        [threadInvalidationTopic(scope)],
      );
      return { thread, message };
    });
  }

  // ── Main Agent sessions ──────────────────────────────────────────────────
  // The active session IS agents/main/thread.json, so Jobs, receipts, and the
  // Main Agent prompt keep reading one path. Other sessions are parked as
  // agents/main/sessions/<id>.json and swapped in on activation.
  // ponytail: three sequential writes, not one transaction; a crash between them
  // leaves an orphan session file at worst (never lost messages).
  const MAX_MAIN_SESSIONS = 200;
  const MAX_SESSION_TITLE_BYTES = 160;

  interface MainSessionEntry {
    id: string;
    title: string | null;
    createdAt: number;
    updatedAt: number;
    turns: number;
  }

  interface MainSessionIndex {
    activeId: string;
    sessions: MainSessionEntry[];
  }

  function mainSessionsIndexPath(root: string): string {
    return join(root, "agents", "main", "sessions.json");
  }

  function mainSessionFilePath(root: string, sessionId: string): string {
    return join(root, "agents", "main", "sessions", `${safeSegment(sessionId, "Session id")}.json`);
  }

  function userTurns(thread: DesignThread): number {
    return thread.messages.filter((message) => message.role === "user").length;
  }

  function assertStoredMainSessionIndex(value: unknown): asserts value is MainSessionIndex {
    const index = storedRecord(value, "Main Agent session index", ["activeId", "sessions"]);
    if (typeof index.activeId !== "string" || !SAFE_SEGMENT.test(index.activeId)
      || !Array.isArray(index.sessions) || index.sessions.length === 0 || index.sessions.length > MAX_MAIN_SESSIONS) {
      throw new DesignStorageError("corrupt", "Main Agent session index is invalid");
    }
    const ids = new Set<string>();
    for (const candidate of index.sessions) {
      const entry = storedRecord(candidate, "Main Agent session", ["id", "title", "createdAt", "updatedAt", "turns"]);
      if (typeof entry.id !== "string" || !SAFE_SEGMENT.test(entry.id) || ids.has(entry.id)
        || !validStoredText(entry.title, MAX_SESSION_TITLE_BYTES, { nullable: true })
        || !validStoredTimestamp(entry.createdAt) || !validStoredTimestamp(entry.updatedAt)
        || !Number.isSafeInteger(entry.turns) || (entry.turns as number) < 0) {
        throw new DesignStorageError("corrupt", "Main Agent session index is invalid");
      }
      ids.add(entry.id);
    }
    if (!ids.has(index.activeId)) throw new DesignStorageError("corrupt", "Main Agent session index is invalid");
  }

  async function readMainSessionIndexUnlocked(root: string, now?: number): Promise<MainSessionIndex> {
    const path = mainSessionsIndexPath(root);
    if (await exists(path)) {
      const index = await readJson<MainSessionIndex>(path, "Main Agent session index");
      assertStoredMainSessionIndex(index);
      return index;
    }
    // First contact: the existing (or empty) main thread becomes session one.
    const thread = await readThreadOrNewUnlocked(root, { type: "main" }, now);
    const index: MainSessionIndex = {
      activeId: `session-${randomUUID()}`,
      sessions: [{ id: "", title: null, createdAt: thread.createdAt, updatedAt: thread.updatedAt, turns: userTurns(thread) }],
    };
    index.sessions[0]!.id = index.activeId;
    await writeAtomicJson(path, index);
    return index;
  }

  function mainSessionList(index: MainSessionIndex, active: DesignThread): DesignMainSessionList {
    return {
      activeId: index.activeId,
      sessions: index.sessions.map((entry) => (
        entry.id === index.activeId
          ? { ...entry, updatedAt: active.updatedAt, turns: userTurns(active) }
          : { ...entry }
      )),
    };
  }

  async function assertNoLiveMainJobUnlocked(root: string): Promise<void> {
    const jobs = await listDesignJobsUnlocked(root);
    if (jobs.some((job) => job.kind === "main-agent" && !TERMINAL_JOB_STATUSES.has(job.status))) {
      throw new DesignStorageError("conflict", "Wait for the running Main Agent turn to finish before switching sessions");
    }
  }

  /** Park the active thread under its session id and record its final shape in the index. */
  async function parkActiveMainSessionUnlocked(root: string, index: MainSessionIndex, active: DesignThread): Promise<void> {
    await writeAtomicJson(mainSessionFilePath(root, index.activeId), active);
    const entry = index.sessions.find((candidate) => candidate.id === index.activeId)!;
    entry.updatedAt = active.updatedAt;
    entry.turns = userTurns(active);
  }

  async function listDesignMainSessions(dataDir: string, projectId: string): Promise<DesignMainSessionList> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const index = await readMainSessionIndexUnlocked(root);
      return mainSessionList(index, await readThreadOrNewUnlocked(root, { type: "main" }));
    });
  }

  async function createDesignMainSession(dataDir: string, projectId: string, now?: number): Promise<DesignMainSessionList> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const index = await readMainSessionIndexUnlocked(root, now);
      const active = await readThreadOrNewUnlocked(root, { type: "main" }, now);
      // An empty session is already "new"; do not stack blank sessions.
      if (active.messages.length === 0) return mainSessionList(index, active);
      if (index.sessions.length >= MAX_MAIN_SESSIONS) {
        throw new DesignStorageError("limit", "Main Agent session limit reached");
      }
      await assertNoLiveMainJobUnlocked(root);
      const timestamp = nowValue(now);
      await parkActiveMainSessionUnlocked(root, index, active);
      const fresh = newThread({ type: "main" }, timestamp);
      const sessionId = `session-${randomUUID()}`;
      await writeAuthorityJson(root, threadFilePath(root, { type: "main" }), fresh, [threadInvalidationTopic({ type: "main" })]);
      index.sessions.push({ id: sessionId, title: null, createdAt: timestamp, updatedAt: timestamp, turns: 0 });
      index.activeId = sessionId;
      await writeAtomicJson(mainSessionsIndexPath(root), index);
      return mainSessionList(index, fresh);
    });
  }

  async function activateDesignMainSession(dataDir: string, projectId: string, sessionId: string, now?: number): Promise<DesignMainSessionList> {
    const root = designRoot(dataDir, projectId);
    safeSegment(sessionId, "Session id");
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const index = await readMainSessionIndexUnlocked(root, now);
      const active = await readThreadOrNewUnlocked(root, { type: "main" }, now);
      if (sessionId === index.activeId) return mainSessionList(index, active);
      if (!index.sessions.some((entry) => entry.id === sessionId)) {
        throw new DesignStorageError("not-found", `Main Agent session ${sessionId} was not found`);
      }
      await assertNoLiveMainJobUnlocked(root);
      await parkActiveMainSessionUnlocked(root, index, active);
      const parkedPath = mainSessionFilePath(root, sessionId);
      let target: DesignThread;
      if (await exists(parkedPath)) {
        target = await readJson<DesignThread>(parkedPath, "Design Agent thread");
        assertStoredThread(target, { type: "main" });
      } else {
        target = newThread({ type: "main" }, nowValue(now));
      }
      await writeAuthorityJson(root, threadFilePath(root, { type: "main" }), target, [threadInvalidationTopic({ type: "main" })]);
      await rm(parkedPath, { force: true });
      index.activeId = sessionId;
      await writeAtomicJson(mainSessionsIndexPath(root), index);
      return mainSessionList(index, target);
    });
  }

  async function renameDesignMainSession(dataDir: string, projectId: string, sessionId: string, title: string | null): Promise<DesignMainSessionList> {
    const root = designRoot(dataDir, projectId);
    safeSegment(sessionId, "Session id");
    const normalized = title === null ? null : title.trim();
    if (normalized !== null && (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_SESSION_TITLE_BYTES)) {
      throw new DesignStorageError("invalid-input", "Main Agent session title is invalid");
    }
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const index = await readMainSessionIndexUnlocked(root);
      const entry = index.sessions.find((candidate) => candidate.id === sessionId);
      if (!entry) throw new DesignStorageError("not-found", `Main Agent session ${sessionId} was not found`);
      entry.title = normalized;
      await writeAuthorityJson(root, mainSessionsIndexPath(root), index, [threadInvalidationTopic({ type: "main" })]);
      return mainSessionList(index, await readThreadOrNewUnlocked(root, { type: "main" }));
    });
  }

  async function deleteDesignMainSession(dataDir: string, projectId: string, sessionId: string, now?: number): Promise<DesignMainSessionList> {
    const root = designRoot(dataDir, projectId);
    safeSegment(sessionId, "Session id");
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const index = await readMainSessionIndexUnlocked(root, now);
      if (!index.sessions.some((entry) => entry.id === sessionId)) {
        throw new DesignStorageError("not-found", `Main Agent session ${sessionId} was not found`);
      }
      if (sessionId !== index.activeId) {
        await rm(mainSessionFilePath(root, sessionId), { force: true });
        index.sessions = index.sessions.filter((entry) => entry.id !== sessionId);
        await writeAuthorityJson(root, mainSessionsIndexPath(root), index, [threadInvalidationTopic({ type: "main" })]);
        return mainSessionList(index, await readThreadOrNewUnlocked(root, { type: "main" }));
      }
      await assertNoLiveMainJobUnlocked(root);
      index.sessions = index.sessions.filter((entry) => entry.id !== sessionId);
      // Fall back to the most recently touched remaining session, else a fresh one.
      const next = [...index.sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
      let target: DesignThread;
      if (next) {
        const parkedPath = mainSessionFilePath(root, next.id);
        if (await exists(parkedPath)) {
          target = await readJson<DesignThread>(parkedPath, "Design Agent thread");
          assertStoredThread(target, { type: "main" });
          await rm(parkedPath, { force: true });
        } else {
          target = newThread({ type: "main" }, nowValue(now));
        }
        index.activeId = next.id;
      } else {
        const timestamp = nowValue(now);
        target = newThread({ type: "main" }, timestamp);
        index.activeId = `session-${randomUUID()}`;
        index.sessions.push({ id: index.activeId, title: null, createdAt: timestamp, updatedAt: timestamp, turns: 0 });
      }
      await writeAuthorityJson(root, threadFilePath(root, { type: "main" }), target, [threadInvalidationTopic({ type: "main" })]);
      await writeAtomicJson(mainSessionsIndexPath(root), index);
      return mainSessionList(index, target);
    });
  }

  type TerminalDesignJobStatus = Extract<DesignJobStatus, "ready" | "failed" | "cancelled" | "superseded">;

  function terminalDesignJobThreadContent(
    job: DesignJob,
    status: TerminalDesignJobStatus = job.status as TerminalDesignJobStatus,
    interrupted = false,
  ): string {
    if (job.kind === "main-agent") {
      if (interrupted) return "Main Agent orchestration was interrupted by daemon restart and cancelled.";
      if (status === "ready") return "Main Agent completed.";
      if (status === "superseded") return "Main Agent orchestration was superseded.";
      if (status === "cancelled") return "Main Agent orchestration cancelled.";
      return `Main Agent failed: ${job.error ?? "Main Agent turn failed"}`;
    }
    if (job.kind === "implementation-export") {
      const identity = job.exportId === null ? "Implementation export" : `Implementation export ${job.exportId}`;
      if (interrupted) return `${identity} was interrupted by daemon restart and cancelled.`;
      if (status === "ready") return `${identity} is ready.`;
      if (status === "superseded") return `${identity} was superseded.`;
      if (status === "cancelled") return `${identity} was cancelled.`;
      return `Implementation export failed: ${job.error ?? "Implementation export failed"}`;
    }
    const action = job.kind === "node-analysis" ? "Analysis" : "Generation";
    if (interrupted) return `${action} was interrupted by daemon restart and cancelled.`;
    if (status === "ready") {
      return job.kind === "node-analysis"
        ? "Material Node analysis completed."
        : `Published ${job.versionId ?? "the generated Version"}`;
    }
    if (status === "superseded") {
      return "Generation completed, but this result was retained as a superseded candidate because the Node head changed.";
    }
    if (status === "cancelled") return `${action} cancelled.`;
    return `${action} failed: ${job.error ?? `${action} failed`}`;
  }

  function designJobThreadScope(job: DesignJob): { type: "main" } | { type: "node"; nodeId: string } {
    return job.nodeId === null ? { type: "main" } : { type: "node", nodeId: job.nodeId };
  }

  async function projectDesignJobThreadMessageUnlocked(
    root: string,
    job: DesignJob,
    content: string,
    timestamp: number,
    options: { onlyReserved?: boolean } = {},
  ): Promise<boolean> {
    const scope = designJobThreadScope(job);
    const path = threadFilePath(root, scope);
    if (!(await exists(path))) return false;
    const thread = await readJson<DesignThread>(path, "Design Agent thread");
    assertStoredThread(thread, scope);
    const reservations = thread.messages.filter((message) => (
      message.role === "assistant" && message.jobId === job.id
    ));
    if (reservations.length > 1) {
      throw new DesignStorageError("corrupt", `Design Agent Job ${job.id} has duplicate assistant reservations`);
    }
    const reservation = reservations[0];
    if (reservation === undefined
      || (options.onlyReserved === true && reservation.content !== DESIGN_MAIN_AGENT_QUEUED_MESSAGE)
      || reservation.content === content) return false;
    assertThreadTurnContent(content);
    reservation.content = content;
    thread.updatedAt = timestamp;
    await writeAuthorityJson(root, path, thread, [threadInvalidationTopic(scope)]);
    return true;
  }

  const MAX_MAIN_PLAN_PAYLOAD_BYTES = 512 * 1024;
  const DESIGN_MAIN_AGENT_QUEUED_MESSAGE =
    "Main Agent orchestration is queued. The final result will replace this status.";

  interface StoredDesignMainPlanExecution {
    schemaVersion: typeof DESIGN_SCHEMA_VERSION;
    executionId: string;
    requestHash: string;
    sourceJobId: string;
    planHash: string;
    planPayload: string;
    planningAuthorityHash: string;
    canvasRevision: number;
    runnerId: string;
    model: string | null;
    createdAt: number;
    checksum: string;
  }

  function mainPlanExecutionId(receiptKey: string): string {
    return createHash("sha256").update(`dezin-design-main-plan-v1\0${receiptKey}`).digest("hex");
  }

  function mainPlanExecutionPath(root: string, receiptKey: string): string {
    return join(root, "agents", "main", "executions", `${mainPlanExecutionId(receiptKey)}.json`);
  }

  function mainPlanExecutionChecksum(value: Omit<StoredDesignMainPlanExecution, "checksum">): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  function assertStoredMainPlanExecution(
    value: unknown,
    expectedExecutionId: string,
  ): asserts value is StoredDesignMainPlanExecution {
    const record = storedRecord(value, "Design Main Agent plan execution", [
      "schemaVersion", "executionId", "requestHash", "sourceJobId", "planHash", "planPayload",
      "planningAuthorityHash", "canvasRevision", "runnerId", "model", "createdAt", "checksum",
    ]);
    if (record.schemaVersion !== DESIGN_SCHEMA_VERSION || record.executionId !== expectedExecutionId
      || !SHA256.test(String(record.executionId)) || !SHA256.test(String(record.requestHash))
      || typeof record.sourceJobId !== "string" || !SAFE_SEGMENT.test(record.sourceJobId)
      || !SHA256.test(String(record.planHash)) || typeof record.planPayload !== "string"
      || !record.planPayload.trim() || Buffer.byteLength(record.planPayload, "utf8") > MAX_MAIN_PLAN_PAYLOAD_BYTES
      || createHash("sha256").update(record.planPayload).digest("hex") !== record.planHash
      || !SHA256.test(String(record.planningAuthorityHash))
      || !Number.isSafeInteger(record.canvasRevision) || (record.canvasRevision as number) < 0
      || !validStoredText(record.runnerId, 512) || (record.runnerId as string).trim() !== record.runnerId
      || !validStoredText(record.model, 512, { nullable: true })
      || (typeof record.model === "string" && record.model.trim() !== record.model)
      || !validStoredTimestamp(record.createdAt) || !SHA256.test(String(record.checksum))) {
      throw new DesignStorageError("corrupt", "Design Main Agent plan execution is invalid");
    }
    const { checksum, ...content } = record as unknown as StoredDesignMainPlanExecution;
    if (mainPlanExecutionChecksum(content) !== checksum) {
      throw new DesignStorageError("corrupt", "Design Main Agent plan execution checksum is invalid");
    }
  }

  async function readDesignMainPlanExecutionUnlocked(
    root: string,
    project: DesignProjectFile,
    receiptKey: string,
  ): Promise<DesignMainPlanExecution | null> {
    const receipt = project.turnReceipts[receiptKey];
    if (!receipt || receipt.kind !== "main-agent" || receipt.nodeId !== null || !SHA256.test(receipt.requestHash ?? "")) {
      throw new DesignStorageError("conflict", "Main Agent plan execution is not bound to this idempotent request");
    }
    const executionId = mainPlanExecutionId(receiptKey);
    const path = mainPlanExecutionPath(root, receiptKey);
    if (!(await exists(path))) {
      if (receipt.mainPlanHash !== undefined) {
        throw new DesignStorageError("corrupt", "Design Main Agent plan receipt is missing its immutable payload");
      }
      return null;
    }
    const stored = await readJson<StoredDesignMainPlanExecution>(path, "Design Main Agent plan execution");
    assertStoredMainPlanExecution(stored, executionId);
    if (stored.requestHash !== receipt.requestHash) {
      throw new DesignStorageError("corrupt", "Design Main Agent plan no longer matches its request authority");
    }
    if (receipt.mainPlanHash === undefined) {
      // The immutable payload is written before the Project receipt. Reconcile
      // the only safe partial state after an exit between those two writes.
      receipt.mainPlanHash = stored.planHash;
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
    } else if (receipt.mainPlanHash !== stored.planHash) {
      throw new DesignStorageError("corrupt", "Design Main Agent plan receipt checksum diverges");
    }
    const sourceJob = await readJob(root, stored.sourceJobId);
    if (sourceJob.kind !== "main-agent" || sourceJob.contextHash === null
      || sourceJob.canvasRevision !== stored.canvasRevision
      || sourceJob.runnerId !== stored.runnerId || sourceJob.model !== stored.model) {
      throw new DesignStorageError("corrupt", "Design Main Agent plan source Job authority diverges");
    }
    return {
      executionId,
      sourceJobId: stored.sourceJobId,
      planHash: stored.planHash,
      planPayload: stored.planPayload,
      planningAuthorityHash: stored.planningAuthorityHash,
      canvasRevision: stored.canvasRevision,
      runnerId: stored.runnerId,
      model: stored.model,
      appliedRevision: receipt.mainPlanAppliedRevision ?? null,
    };
  }

  async function getDesignMainPlanExecution(
    dataDir: string,
    projectId: string,
    receiptKey: string,
  ): Promise<DesignMainPlanExecution | null> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      if (typeof receiptKey !== "string" || !receiptKey || receiptKey.length > 512) {
        throw new DesignStorageError("invalid-input", "Main Agent receipt key is invalid");
      }
      const project = await readProject(root);
      return readDesignMainPlanExecutionUnlocked(root, project, receiptKey);
    });
  }

  async function reserveDesignMainPlanExecution(
    dataDir: string,
    projectId: string,
    input: {
      jobId: string;
      receiptKey: string;
      planPayload: string;
      planningAuthorityHash: string;
      canvasRevision: number;
    },
    now?: number,
  ): Promise<DesignMainPlanExecution> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const jobId = safeSegment(input.jobId, "Job id");
      if (typeof input.receiptKey !== "string" || !input.receiptKey || input.receiptKey.length > 512
        || typeof input.planPayload !== "string" || !input.planPayload.trim()
        || Buffer.byteLength(input.planPayload, "utf8") > MAX_MAIN_PLAN_PAYLOAD_BYTES
        || !SHA256.test(input.planningAuthorityHash)
        || !Number.isSafeInteger(input.canvasRevision) || input.canvasRevision < 0) {
        throw new DesignStorageError("invalid-input", "Main Agent plan execution input is invalid");
      }
      const project = await readProject(root);
      const receipt = project.turnReceipts[input.receiptKey];
      const job = await readJob(root, jobId);
      if (!receipt || receipt.kind !== "main-agent" || receipt.nodeId !== null || receipt.jobId !== job.id
        || receipt.authorityHash !== job.contextHash || !SHA256.test(receipt.requestHash ?? "")
        || job.kind !== "main-agent" || job.status !== "running" || job.contextHash === null
        || job.canvasRevision !== input.canvasRevision) {
        throw new DesignStorageError("conflict", "Main Agent plan requires the active idempotent Job authority");
      }
      const planHash = createHash("sha256").update(input.planPayload).digest("hex");
      const existing = await readDesignMainPlanExecutionUnlocked(root, project, input.receiptKey);
      if (existing !== null) {
        if (existing.planHash !== planHash || existing.planPayload !== input.planPayload
          || existing.planningAuthorityHash !== input.planningAuthorityHash) {
          throw new DesignStorageError("conflict", "Main Agent idempotent request already has a different immutable plan");
        }
        return existing;
      }
      const executionId = mainPlanExecutionId(input.receiptKey);
      const content: Omit<StoredDesignMainPlanExecution, "checksum"> = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        executionId,
        requestHash: receipt.requestHash!,
        sourceJobId: job.id,
        planHash,
        planPayload: input.planPayload,
        planningAuthorityHash: input.planningAuthorityHash,
        canvasRevision: input.canvasRevision,
        runnerId: job.runnerId,
        model: job.model,
        createdAt: nowValue(now),
      };
      await writeAtomicJson(mainPlanExecutionPath(root, input.receiptKey), {
        ...content,
        checksum: mainPlanExecutionChecksum(content),
      });
      receipt.mainPlanHash = planHash;
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      return {
        executionId,
        sourceJobId: job.id,
        planHash,
        planPayload: input.planPayload,
        planningAuthorityHash: input.planningAuthorityHash,
        canvasRevision: input.canvasRevision,
        runnerId: job.runnerId,
        model: job.model,
        appliedRevision: null,
      };
    });
  }

  function assertStoredJob(value: unknown, expectedId: string): asserts value is DesignJob {
    const job = storedRecord(value, `Design Job ${expectedId}`, [
      "schemaVersion", "id", "kind", "runnerId", "model", "status", "nodeId", "parentJobId", "contextHash", "canvasRevision",
      "expectedHeadVersionId", "versionId", "exportId", "error", "cancelRequested", "conversationOnly", "activity",
      "createdAt", "updatedAt", "finishedAt",
    ]);
    const kinds = ["node-generation", "node-analysis", "main-agent", "implementation-export"];
    const statuses = ["queued", "running", "validating", "ready", "failed", "cancelled", "superseded"];
    const kind = String(job.kind);
    const status = String(job.status);
    const terminal = ["ready", "failed", "cancelled", "superseded"].includes(status);
    const nodeScoped = kind === "node-generation" || kind === "node-analysis";
    if (job.schemaVersion !== DESIGN_SCHEMA_VERSION || job.id !== expectedId || !SAFE_SEGMENT.test(expectedId)
      || !kinds.includes(kind) || !statuses.includes(status)
      || !validStoredText(job.runnerId, 512) || (job.runnerId as string).trim() !== job.runnerId
      || !validStoredText(job.model, 512, { nullable: true })
      || (typeof job.model === "string" && job.model.trim() !== job.model)
      || !validStoredNullableId(job.nodeId) || (nodeScoped !== (job.nodeId !== null))
      || !validStoredNullableId(job.parentJobId)
      || !(job.contextHash === null || (typeof job.contextHash === "string" && SHA256.test(job.contextHash)))
      || !(job.canvasRevision === null || (Number.isSafeInteger(job.canvasRevision) && (job.canvasRevision as number) >= 0))
      || !validStoredNullableId(job.expectedHeadVersionId)
      || (kind !== "node-generation" && job.expectedHeadVersionId !== null)
      || !validStoredNullableId(job.versionId) || (kind !== "node-generation" && job.versionId !== null)
      || !validStoredNullableId(job.exportId) || (kind !== "implementation-export" && job.exportId !== null)
      || !validStoredText(job.error, 16_384, { nullable: true, empty: true })
      || typeof job.cancelRequested !== "boolean"
      || !(job.conversationOnly === undefined || typeof job.conversationOnly === "boolean")
      || (job.conversationOnly === true && kind !== "main-agent")
      || !Array.isArray(job.activity) || job.activity.length > MAX_JOB_ACTIVITY
      || !validStoredTimestamp(job.createdAt) || !validStoredTimestamp(job.updatedAt)
      || !(job.finishedAt === null || validStoredTimestamp(job.finishedAt))
      || (terminal !== (job.finishedAt !== null))) {
      throw new DesignStorageError("corrupt", `Design Job ${expectedId} is invalid`);
    }
    const activityIds = new Set<string>();
    for (const [index, entry] of job.activity.entries()) {
      const activity = storedRecord(entry, `Design Job ${expectedId} activity ${index}`, [
        "id", "kind", "text", "toolName", "toolCallId", "toolInput", "toolResult", "toolResultError", "diff",
        "createdAt",
      ]);
      const activityKind = String(activity.kind);
      const hasToolDetails = activity.toolName !== undefined || activity.toolCallId !== undefined
        || activity.toolInput !== undefined || activity.toolResult !== undefined
        || activity.toolResultError !== undefined || activity.diff !== undefined;
      const hasToolPayload = activity.toolCallId !== undefined || activity.toolInput !== undefined
        || activity.toolResult !== undefined || activity.toolResultError !== undefined || activity.diff !== undefined;
      if (typeof activity.id !== "string" || !SAFE_SEGMENT.test(activity.id) || activityIds.has(activity.id)
        || !["text", "tool", "status"].includes(activityKind)
        || !validStoredText(activity.text, 16_384) || (activity.text as string).trim() !== activity.text
        || (hasToolDetails && activityKind !== "tool")
        || (hasToolPayload && activity.toolName === undefined)
        || (activity.toolName !== undefined
          && !DESIGN_JOB_TOOL_NAMES.includes(activity.toolName as DesignJobToolName))
        || (activity.toolCallId !== undefined && (!validStoredText(
          activity.toolCallId,
          DESIGN_JOB_TOOL_CALL_ID_MAX_BYTES,
        ) || (activity.toolCallId as string).trim() !== activity.toolCallId))
        || (activity.toolInput !== undefined && !validDesignJobToolInput(activity.toolInput))
        || (activity.toolResult !== undefined
          && !validStoredText(activity.toolResult, DESIGN_JOB_TOOL_RESULT_MAX_BYTES))
        || !(activity.toolResultError === undefined || typeof activity.toolResultError === "boolean")
        || (activity.toolResultError !== undefined && activity.toolResult === undefined)
        || (activity.toolResult !== undefined && activity.toolCallId === undefined)
        || (activity.diff !== undefined && !validStoredText(activity.diff, DESIGN_JOB_TOOL_DIFF_MAX_BYTES))
        || !validStoredTimestamp(activity.createdAt)) {
        throw new DesignStorageError("corrupt", `Design Job ${expectedId} activity ${index} is invalid`);
      }
      activityIds.add(activity.id);
    }
  }

  async function readJob(root: string, jobId: string): Promise<DesignJob> {
    const job = await readJson<DesignJob>(jobFilePath(root, jobId), `Design Job ${jobId}`);
    assertStoredJob(job, jobId);
    return job;
  }

  function jobContextFilePath(root: string, jobId: string): string {
    return join(root, "jobs", `${safeSegment(jobId, "Job id")}.context.json`);
  }

  function jobCreationTransactionsRoot(root: string): string {
    return join(root, "transactions", "job-creations");
  }

  function jobCreationTransactionPath(root: string, transactionId: string): string {
    return join(jobCreationTransactionsRoot(root), `${safeSegment(transactionId, "Job creation transaction id")}.json`);
  }

  function stableAuthorityHash(value: unknown): string {
    return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
  }

  function jobCreationTransactionChecksum(
    value: Omit<DesignJobCreationTransaction, "checksum">,
  ): string {
    return stableAuthorityHash(value);
  }

  function withJobCreationTransactionChecksum(
    value: Omit<DesignJobCreationTransaction, "checksum">,
  ): DesignJobCreationTransaction {
    return { ...value, checksum: jobCreationTransactionChecksum(value) };
  }

  function assertStoredJobCreationMessage(
    value: unknown,
    label: string,
    expectedRole: "user" | "system" | "assistant",
    expectedJobId: string,
  ): asserts value is DesignThreadMessage {
    const message = storedRecord(value, label, ["id", "role", "content", "jobId", "createdAt"]);
    if (typeof message.id !== "string" || !SAFE_SEGMENT.test(message.id)
      || message.role !== expectedRole || message.jobId !== expectedJobId
      || !validStoredText(message.content, MAX_THREAD_CONTENT_BYTES)
      || (message.content as string).trim() !== message.content
      || !validStoredTimestamp(message.createdAt)) {
      throw new DesignStorageError("corrupt", `${label} is invalid`);
    }
  }

  function assertJobCreationProjectTransition(
    transaction: DesignJobCreationTransaction,
    transactionId: string,
  ): void {
    const before = transaction.projectBefore;
    const after = transaction.projectAfter;
    const fail = (): never => {
      throw new DesignStorageError("corrupt", `Design Job creation ${transactionId} Project transition is invalid`);
    };
    if (transaction.job.canvasRevision !== before.revision
      || stableStringify(after.viewport) !== stableStringify(before.viewport)
      || stableStringify(after.nodeOrder) !== stableStringify(before.nodeOrder)
      || stableStringify(after.retiredNodeIds) !== stableStringify(before.retiredNodeIds)
      || stableStringify(after.undo) !== stableStringify(before.undo)
      || stableStringify(after.redo) !== stableStringify(before.redo)
      || after.createdAt !== before.createdAt) fail();

    const scopedNodeJob = transaction.job.kind === "node-generation"
      || transaction.job.kind === "node-analysis";
    if (scopedNodeJob !== (transaction.job.nodeId !== null)) fail();
    if (transaction.job.nodeId === null) {
      if (after.revision !== before.revision || after.updatedAt !== before.updatedAt
        || stableStringify(after.nodes) !== stableStringify(before.nodes)) fail();
    } else {
      if (after.revision !== before.revision + 1
        || after.updatedAt !== Math.max(before.updatedAt, transaction.createdAt)) fail();
      const nodeId = transaction.job.nodeId;
      const beforeNode = before.nodes.find((node) => node.id === nodeId);
      const afterNode = after.nodes.find((node) => node.id === nodeId);
      if (beforeNode === undefined || afterNode === undefined) fail();
      const validBeforeNode = beforeNode!;
      const validAfterNode = afterNode!;
      if (validBeforeNode.activeJobId !== null) fail();
      const expectedNode: DesignNode = {
        ...validBeforeNode,
        state: "queued",
        activeJobId: transaction.job.id,
        error: null,
        updatedAt: transaction.createdAt,
      };
      if (stableStringify(validAfterNode) !== stableStringify(expectedNode)) fail();
      for (const candidate of before.nodes) {
        if (candidate.id === nodeId) continue;
        const next = after.nodes.find((node) => node.id === candidate.id);
        if (next === undefined || stableStringify(next) !== stableStringify(candidate)) fail();
      }
    }

    const beforeReceipts = { ...before.turnReceipts };
    const afterReceipts = { ...after.turnReceipts };
    if (transaction.receiptKey === null) {
      if (stableStringify(afterReceipts) !== stableStringify(beforeReceipts)) fail();
      return;
    }
    const priorReceipt = beforeReceipts[transaction.receiptKey];
    const receipt = afterReceipts[transaction.receiptKey];
    delete beforeReceipts[transaction.receiptKey];
    delete afterReceipts[transaction.receiptKey];
    if (receipt === undefined) fail();
    const boundReceipt = receipt!;
    if (!SHA256.test(boundReceipt.requestHash ?? "")
      || boundReceipt.jobId !== transaction.job.id || boundReceipt.kind !== transaction.job.kind
      || boundReceipt.nodeId !== transaction.job.nodeId || boundReceipt.authorityHash !== transaction.contextHash
      || boundReceipt.createdAt !== transaction.createdAt
      || stableStringify(afterReceipts) !== stableStringify(beforeReceipts)) fail();
    const expectedReceipt = {
      jobId: transaction.job.id,
      kind: transaction.job.kind,
      nodeId: transaction.job.nodeId,
      requestHash: boundReceipt.requestHash,
      authorityHash: transaction.contextHash,
      ...(priorReceipt?.mainPlanHash === undefined ? {} : { mainPlanHash: priorReceipt.mainPlanHash }),
      ...(priorReceipt?.mainPlanAppliedRevision === undefined
        ? {}
        : { mainPlanAppliedRevision: priorReceipt.mainPlanAppliedRevision }),
      createdAt: transaction.createdAt,
    };
    if (stableStringify(boundReceipt) !== stableStringify(expectedReceipt)) fail();
  }

  function assertStoredJobCreationTransaction(
    value: unknown,
    expectedProjectId: string,
    expectedTransactionId: string,
  ): asserts value is DesignJobCreationTransaction {
    const record = storedRecord(value, `Design Job creation ${expectedTransactionId}`, [
      "schemaVersion", "id", "projectId", "phase", "job", "jobHash", "contextHash", "thread",
      "receiptKey", "projectBefore", "projectAfter", "projectBeforeHash", "projectAfterHash", "createdAt", "checksum",
    ]);
    const transaction = record as unknown as DesignJobCreationTransaction;
    const { checksum, ...content } = transaction;
    if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION || transaction.id !== expectedTransactionId
      || transaction.projectId !== expectedProjectId
      || (transaction.phase !== "pending" && transaction.phase !== "committed")
      || !validStoredTimestamp(transaction.createdAt)
      || typeof transaction.jobHash !== "string" || !SHA256.test(transaction.jobHash)
      || typeof transaction.contextHash !== "string" || !SHA256.test(transaction.contextHash)
      || typeof transaction.projectBeforeHash !== "string" || !SHA256.test(transaction.projectBeforeHash)
      || typeof transaction.projectAfterHash !== "string" || !SHA256.test(transaction.projectAfterHash)
      || typeof checksum !== "string" || !SHA256.test(checksum)
      || checksum !== jobCreationTransactionChecksum(content)) {
      throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} is invalid`);
    }
    const jobId = transaction.job?.id;
    if (typeof jobId !== "string" || transaction.id !== `creation-${jobId}`) {
      throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} identity is invalid`);
    }
    assertStoredJob(transaction.job, jobId);
    if (transaction.jobHash !== stableAuthorityHash(transaction.job)
      || transaction.job.contextHash !== transaction.contextHash
      || transaction.job.status !== "queued" || transaction.job.createdAt !== transaction.createdAt
      || transaction.job.updatedAt !== transaction.createdAt || transaction.job.finishedAt !== null) {
      throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} Job authority is invalid`);
    }
    if (transaction.receiptKey !== null && (typeof transaction.receiptKey !== "string"
      || !transaction.receiptKey.startsWith(`${transaction.job.kind}:${transaction.job.nodeId ?? "main"}:`)
      || Buffer.byteLength(transaction.receiptKey, "utf8") > 512)) {
      throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} receipt identity is invalid`);
    }
    assertStoredProject(transaction.projectBefore, expectedProjectId);
    assertStoredProject(transaction.projectAfter, expectedProjectId);
    if (transaction.projectBeforeHash !== stableAuthorityHash(transaction.projectBefore)
      || transaction.projectAfterHash !== stableAuthorityHash(transaction.projectAfter)) {
      throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} Project authority is invalid`);
    }
    assertJobCreationProjectTransition(transaction, expectedTransactionId);
    if (transaction.thread !== null) {
      const binding = storedRecord(transaction.thread, "Design Job creation thread binding", [
        "scope", "existedBefore", "beforeUpdatedAt", "beforeHash", "afterHash", "requestMessage", "assistantMessage",
      ]) as unknown as DesignJobCreationThreadBinding;
      const scope = storedRecord(binding.scope, "Design Job creation thread scope",
        binding.scope?.type === "main" ? ["type"] : ["type", "nodeId"]);
      const expectedScope = transaction.job.nodeId === null
        ? { type: "main" as const }
        : { type: "node" as const, nodeId: transaction.job.nodeId };
      const scopeMatches = expectedScope.type === "main"
        ? scope.type === "main"
        : scope.type === "node" && scope.nodeId === expectedScope.nodeId;
      if (!scopeMatches || typeof binding.existedBefore !== "boolean"
        || !validStoredTimestamp(binding.beforeUpdatedAt)
        || typeof binding.beforeHash !== "string" || !SHA256.test(binding.beforeHash)
        || typeof binding.afterHash !== "string" || !SHA256.test(binding.afterHash)) {
        throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} thread authority is invalid`);
      }
      const requestRole = transaction.job.kind === "implementation-export" ? "system" : "user";
      assertStoredJobCreationMessage(binding.requestMessage, "Design Job creation request", requestRole, jobId);
      assertStoredJobCreationMessage(binding.assistantMessage, "Design Job creation assistant", "assistant", jobId);
      if (binding.requestMessage.id === binding.assistantMessage.id
        || binding.requestMessage.createdAt !== transaction.createdAt
        || binding.assistantMessage.createdAt !== transaction.createdAt) {
        throw new DesignStorageError("corrupt", `Design Job creation ${expectedTransactionId} message authority is invalid`);
      }
    }
  }

  async function readFrozenJobContextUnlocked(
    root: string,
    projectId: string,
    jobId: string,
  ): Promise<DesignFrozenContext> {
    const context = await readJson<DesignFrozenContext>(jobContextFilePath(root, jobId), `Design Job ${jobId} Context`);
    const record = storedRecord(context, `Design Job ${jobId} Context`, [
      "schemaVersion", "projectId", "canvasRevision", "targetNodeId", "checksum", "viewport", "nodes",
    ]);
    const { checksum, ...content } = record;
    const actual = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    if (typeof checksum !== "string" || !SHA256.test(checksum) || checksum !== actual) {
      throw new DesignStorageError("corrupt", `Design Job ${jobId} Context checksum is invalid`);
    }
    assertStoredFrozenContext(context, projectId);
    return context;
  }

  async function removeAuthorityPath(
    root: string,
    path: string,
    topics: readonly DesignInvalidationTopic[],
  ): Promise<void> {
    await commitDesignAuthorityChange(root, topics, () => rm(path, { force: true }));
  }

  async function rollbackJobCreationThreadUnlocked(
    root: string,
    binding: DesignJobCreationThreadBinding,
  ): Promise<void> {
    const path = threadFilePath(root, binding.scope);
    if (!(await exists(path))) {
      if (binding.existedBefore) {
        throw new DesignStorageError("corrupt", "Interrupted Design Job creation lost its prior thread authority");
      }
      return;
    }
    const thread = await readJson<DesignThread>(path, "Design Agent thread");
    assertStoredThread(thread, binding.scope);
    const currentHash = stableAuthorityHash(thread);
    if (currentHash === binding.beforeHash) {
      if (!binding.existedBefore) {
        await removeAuthorityPath(root, path, [threadInvalidationTopic(binding.scope)]);
      }
      return;
    }
    if (currentHash !== binding.afterHash) {
      throw new DesignStorageError("corrupt", "Interrupted Design Job creation thread is in a third state");
    }
    const request = thread.messages.at(-2);
    const assistant = thread.messages.at(-1);
    if (stableStringify(request) !== stableStringify(binding.requestMessage)
      || stableStringify(assistant) !== stableStringify(binding.assistantMessage)) {
      throw new DesignStorageError("corrupt", "Interrupted Design Job creation thread turn diverged");
    }
    thread.messages.splice(-2, 2);
    thread.updatedAt = binding.beforeUpdatedAt;
    if (stableAuthorityHash(thread) !== binding.beforeHash) {
      throw new DesignStorageError("corrupt", "Interrupted Design Job creation cannot restore its prior thread authority");
    }
    if (binding.existedBefore) {
      await writeAuthorityJson(root, path, thread, [threadInvalidationTopic(binding.scope)]);
    } else {
      await removeAuthorityPath(root, path, [threadInvalidationTopic(binding.scope)]);
    }
  }

  async function rollForwardJobCreationThreadUnlocked(
    root: string,
    binding: DesignJobCreationThreadBinding,
  ): Promise<void> {
    const path = threadFilePath(root, binding.scope);
    let thread: DesignThread;
    if (await exists(path)) {
      thread = await readJson<DesignThread>(path, "Design Agent thread");
      assertStoredThread(thread, binding.scope);
      const currentHash = stableAuthorityHash(thread);
      if (currentHash === binding.afterHash) return;
      if (currentHash !== binding.beforeHash) {
        throw new DesignStorageError("corrupt", "Committed Design Job creation thread is in a third state");
      }
    } else {
      if (binding.existedBefore) {
        throw new DesignStorageError("corrupt", "Committed Design Job creation lost its prior thread authority");
      }
      thread = newThread(binding.scope, binding.requestMessage.createdAt);
      if (stableAuthorityHash(thread) !== binding.beforeHash) {
        throw new DesignStorageError("corrupt", "Committed Design Job creation prior thread authority is invalid");
      }
    }
    thread.messages.push(binding.requestMessage, binding.assistantMessage);
    thread.updatedAt = binding.assistantMessage.createdAt;
    if (stableAuthorityHash(thread) !== binding.afterHash) {
      throw new DesignStorageError("corrupt", "Committed Design Job creation cannot restore its thread authority");
    }
    await writeAuthorityJson(root, path, thread, [threadInvalidationTopic(binding.scope)]);
  }

  async function recoverJobCreationTransactionUnlocked(
    root: string,
    transaction: DesignJobCreationTransaction,
  ): Promise<void> {
    const currentProject = await readProject(root);
    const currentProjectHash = stableAuthorityHash(currentProject);
    if (transaction.phase === "pending") {
      if (transaction.projectBeforeHash === transaction.projectAfterHash) {
        if (currentProjectHash !== transaction.projectBeforeHash) {
          throw new DesignStorageError("corrupt", "Interrupted Design Job creation Project is in a third state");
        }
      } else if (currentProjectHash === transaction.projectAfterHash) {
        await writeAuthorityJson(root, projectFilePath(root), transaction.projectBefore, ["canvas"]);
      } else if (currentProjectHash !== transaction.projectBeforeHash) {
        throw new DesignStorageError("corrupt", "Interrupted Design Job creation Project is in a third state");
      }
      if (transaction.thread !== null) await rollbackJobCreationThreadUnlocked(root, transaction.thread);
      if (await exists(jobFilePath(root, transaction.job.id))) {
        const job = await readJob(root, transaction.job.id);
        if (stableAuthorityHash(job) !== transaction.jobHash) {
          throw new DesignStorageError("corrupt", "Interrupted Design Job creation Job diverged from its WAL");
        }
        await removeAuthorityPath(root, jobFilePath(root, transaction.job.id), ["jobs"]);
      }
      if (await exists(jobContextFilePath(root, transaction.job.id))) {
        const context = await readFrozenJobContextUnlocked(root, transaction.projectId, transaction.job.id);
        if (context.checksum !== transaction.contextHash) {
          throw new DesignStorageError("corrupt", "Interrupted Design Job creation Context diverged from its WAL");
        }
        await rm(jobContextFilePath(root, transaction.job.id), { force: true });
      }
      return;
    }

    const context = await readFrozenJobContextUnlocked(root, transaction.projectId, transaction.job.id);
    if (context.checksum !== transaction.contextHash) {
      throw new DesignStorageError("corrupt", "Committed Design Job creation Context diverged from its WAL");
    }
    if (await exists(jobFilePath(root, transaction.job.id))) {
      const job = await readJob(root, transaction.job.id);
      if (stableAuthorityHash(job) !== transaction.jobHash) {
        throw new DesignStorageError("corrupt", "Committed Design Job creation Job diverged from its WAL");
      }
    } else {
      await writeAuthorityJson(root, jobFilePath(root, transaction.job.id), transaction.job, ["jobs"]);
    }
    if (transaction.thread !== null) await rollForwardJobCreationThreadUnlocked(root, transaction.thread);
    if (transaction.projectBeforeHash === transaction.projectAfterHash) {
      if (currentProjectHash !== transaction.projectBeforeHash) {
        throw new DesignStorageError("corrupt", "Committed Design Job creation Project is in a third state");
      }
    } else if (currentProjectHash === transaction.projectBeforeHash) {
      await writeAuthorityJson(root, projectFilePath(root), transaction.projectAfter, ["canvas"]);
    } else if (currentProjectHash !== transaction.projectAfterHash) {
      throw new DesignStorageError("corrupt", "Committed Design Job creation Project is in a third state");
    }
  }

  async function recoverPendingJobCreationsUnlocked(root: string): Promise<void> {
    const transactionsRoot = jobCreationTransactionsRoot(root);
    if (!(await exists(transactionsRoot))) return;
    const entries = (await readdir(transactionsRoot, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !/^creation-job-[0-9a-f-]{36}\.json$/.test(entry.name)) {
        throw new DesignStorageError("corrupt", "Design Job creation transaction ledger contains an invalid entry");
      }
      const transactionId = entry.name.slice(0, -5);
      const path = jobCreationTransactionPath(root, transactionId);
      const projectId = (await readProject(root)).projectId;
      const transaction = await readJson<DesignJobCreationTransaction>(path, `Design Job creation ${transactionId}`);
      assertStoredJobCreationTransaction(transaction, projectId, transactionId);
      await recoverJobCreationTransactionUnlocked(root, transaction);
      await rm(path, { force: true });
    }
  }

  function normalizedDesignJobRequestHash(input: {
    kind: DesignJobKind;
    runnerId: string;
    model: string | null;
    nodeId: string | null;
    parentJobId: string | null;
    expectedCanvasRevision: number | null;
    promptHash: string;
    contextNodeIds: readonly string[];
  }): string {
    return createHash("sha256").update(stableStringify({
      protocol: "dezin-design-turn-request-v1",
      ...input,
    })).digest("hex");
  }

  function assertThreadTurnContent(content: unknown): asserts content is string {
    if (typeof content !== "string" || !content.trim()
      || Buffer.byteLength(content, "utf8") > MAX_THREAD_CONTENT_BYTES) {
      throw new DesignStorageError("invalid-input", "Design Agent message is invalid");
    }
  }

  async function createDesignJob(
    dataDir: string,
    projectId: string,
    input: CreateDesignJobInput,
    now?: number,
    hooks?: DesignJobCreationTestHooks,
  ): Promise<CreatedDesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      if (!["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(input?.kind)) {
        throw new DesignStorageError("invalid-input", "Design Job kind is unsupported");
      }
      if (!validStoredText(input.runnerId, 512) || input.runnerId.trim() !== input.runnerId
        || !validStoredText(input.model, 512, { nullable: true })
        || (typeof input.model === "string" && input.model.trim() !== input.model)) {
        throw new DesignStorageError("invalid-input", "Design Job runner identity is invalid");
      }
      const nodeId = input.nodeId ?? null;
      if (nodeId !== null) safeSegment(nodeId, "Node id");
      const parentJobId = input.parentJobId ?? null;
      if (parentJobId !== null) safeSegment(parentJobId, "Parent Job id");
      const initialExportId = input.exportId ?? null;
      if (initialExportId !== null) {
        safeSegment(initialExportId, "Export id");
        if (input.kind !== "implementation-export") {
          throw new DesignStorageError("invalid-input", "Only Implementation Export Jobs may bind an Export identity");
        }
      }
      const rawIdempotencyKey = input.idempotencyKey ?? null;
      if (rawIdempotencyKey !== null && (typeof rawIdempotencyKey !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(rawIdempotencyKey))) {
        throw new DesignStorageError("invalid-input", "idempotencyKey is invalid");
      }
      if (input.terminalReceiptPolicy !== undefined
        && input.terminalReceiptPolicy !== "reuse"
        && input.terminalReceiptPolicy !== "retry-restart-interrupted") {
        throw new DesignStorageError("invalid-input", "terminalReceiptPolicy is invalid");
      }
      if (input.terminalReceiptPolicy !== undefined && rawIdempotencyKey === null) {
        throw new DesignStorageError("invalid-input", "terminalReceiptPolicy requires an idempotencyKey");
      }
      const promptHash = input.promptHash ?? null;
      if (rawIdempotencyKey !== null && (typeof promptHash !== "string" || !SHA256.test(promptHash))) {
        throw new DesignStorageError("invalid-input", "Idempotent Design Agent turns require an exact prompt hash");
      }
      if (promptHash !== null && (typeof promptHash !== "string" || !SHA256.test(promptHash))) {
        throw new DesignStorageError("invalid-input", "Design Agent prompt hash is invalid");
      }
      if (input.contextNodeIds !== undefined && (!Array.isArray(input.contextNodeIds)
        || input.contextNodeIds.length > 100)) {
        throw new DesignStorageError("invalid-input", "Design Agent priority context is invalid");
      }
      const contextNodeIds = Array.from(new Set((input.contextNodeIds ?? []).map((id) =>
        safeSegment(id, "Context Node id"))));
      if (input.reserveThreadTurn !== undefined && input.reserveMainThreadTurn !== undefined) {
        throw new DesignStorageError("invalid-input", "Design Job may reserve only one thread turn");
      }
      const reservedTurn = input.reserveThreadTurn ?? (input.reserveMainThreadTurn === undefined
        ? undefined
        : {
            requestContent: input.reserveMainThreadTurn.userContent,
            assistantContent: input.reserveMainThreadTurn.assistantContent,
          });
      if (input.reserveMainThreadTurn !== undefined) {
        if (input.kind !== "main-agent") {
          throw new DesignStorageError("invalid-input", "Only Main Agent Jobs may reserve a Main Agent turn");
        }
      }
      if (reservedTurn !== undefined) {
        assertThreadTurnContent(reservedTurn.requestContent);
        assertThreadTurnContent(reservedTurn.assistantContent);
      }
      const requestHash = normalizedDesignJobRequestHash({
        kind: input.kind,
        runnerId: input.runnerId,
        model: input.model,
        nodeId,
        parentJobId,
        expectedCanvasRevision: input.expectedCanvasRevision ?? null,
        promptHash: promptHash ?? createHash("sha256").update("").digest("hex"),
        contextNodeIds,
      });
      const project = await readProject(root);
      const nodes = readNodes(project);
      const receiptKey = rawIdempotencyKey === null
        ? null
        : `${input.kind}:${nodeId ?? "main"}:${rawIdempotencyKey}`;
      const priorReceipt = receiptKey === null ? undefined : project.turnReceipts[receiptKey];
      if (priorReceipt) {
        if (priorReceipt.kind !== input.kind || priorReceipt.nodeId !== nodeId) {
          throw new DesignStorageError("conflict", "idempotencyKey is already bound to another Design Agent scope");
        }
        if (priorReceipt.requestHash !== requestHash) {
          throw new DesignStorageError("conflict", "idempotencyKey is already bound to a different Design Agent request");
        }
        const priorJob = await readJob(root, priorReceipt.jobId);
        if (priorReceipt.authorityHash !== priorJob.contextHash) {
          throw new DesignStorageError("corrupt", "Design Agent receipt authority no longer matches its frozen Job context");
        }
        const committedMainPlan = priorJob.kind === "main-agent"
          && priorReceipt.mainPlanAppliedRevision !== undefined;
        const retryRestartInterrupted = input.terminalReceiptPolicy === "retry-restart-interrupted"
          && priorJob.status === "cancelled"
          && priorJob.cancelRequested
          && priorJob.error === DESIGN_JOB_RESTART_INTERRUPTION_ERROR;
        const reuseTerminal = input.terminalReceiptPolicy === "reuse"
          || (input.terminalReceiptPolicy === "retry-restart-interrupted" && !retryRestartInterrupted);
        if (reuseTerminal
          || (priorJob.status !== "failed" && priorJob.status !== "cancelled")
          || committedMainPlan) {
          return {
            job: priorJob,
            reused: true,
            canvas: canvas(project, nodes),
            receiptKey,
            threadTurnReservation: null,
            mainThreadReservation: null,
          };
        }
      }
      if (input.kind === "main-agent") {
        // ponytail: Main turns are rare; scan the existing Jobs instead of maintaining a second active-run index.
        const activeMainJob = (await listDesignJobsUnlocked(root)).find((job) => (
          job.kind === "main-agent"
          && (job.status === "queued" || job.status === "running" || job.status === "validating")
        ));
        if (activeMainJob) {
          throw new DesignStorageError("conflict", "Design project already has an active Main Agent Job");
        }
      }
      const unavailableContextId = contextNodeIds.find((id) => !nodes.has(id));
      if (unavailableContextId !== undefined) {
        throw new DesignStorageError(
          "invalid-input",
          `Design Agent priority context references unavailable Node ${unavailableContextId}`,
        );
      }
      if (input.expectedCanvasRevision !== undefined && input.expectedCanvasRevision !== project.revision) {
        throw new DesignRevisionConflictError(input.expectedCanvasRevision, project.revision);
      }
      if (receiptKey !== null && priorReceipt === undefined && Object.keys(project.turnReceipts).length >= 5_000) {
        throw new DesignStorageError("limit", "Design Agent idempotency receipt limit reached");
      }
      let node: DesignNode | undefined;
      if (input.kind === "node-generation" || input.kind === "node-analysis") {
        if (nodeId === null) throw new DesignStorageError("invalid-input", "Scoped Node Job requires a Node");
        node = nodes.get(safeSegment(nodeId, "Node id"));
        if (!node) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
        const generative = (DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind);
        if (input.kind === "node-generation" && !generative) {
          throw new DesignStorageError("invalid-input", "Material Nodes cannot run generation Jobs");
        }
        if (input.kind === "node-analysis" && generative) {
          throw new DesignStorageError("invalid-input", "Generative Nodes use generation Jobs");
        }
        if (node.activeJobId !== null) {
          throw new DesignStorageError("conflict", `Design Node ${nodeId} already has an active Job`);
        }
      } else if (nodeId !== null) {
        throw new DesignStorageError("invalid-input", "Only Node generation Jobs may bind a Node");
      }
      const timestamp = nowValue(now);
      const reservedScope = reservedTurn === undefined
        ? null
        : input.kind === "node-generation" || input.kind === "node-analysis"
          ? { type: "node" as const, nodeId: nodeId! }
          : { type: "main" as const };
      let reservedThread: DesignThread | null = null;
      let reservedThreadExistedBefore = false;
      let reservedThreadBeforeHash: string | null = null;
      let reservedThreadBeforeUpdatedAt: number | null = null;
      if (reservedScope !== null) {
        reservedThreadExistedBefore = await exists(threadFilePath(root, reservedScope));
        reservedThread = await readThreadOrNewUnlocked(root, reservedScope, timestamp);
        if (reservedThread.messages.length + 2 > MAX_THREAD_MESSAGES) {
          throw new DesignStorageError("limit", "Design Agent thread does not have capacity for a complete turn");
        }
        reservedThreadBeforeHash = stableAuthorityHash(reservedThread);
        reservedThreadBeforeUpdatedAt = reservedThread.updatedAt;
      }
      const jobId = `job-${randomUUID()}`;
      const frozenCanvas = canvas(project, nodes);
      const frozenContext = await buildFrozenContextUnlocked(
        root,
        dataDir,
        projectId,
        project,
        nodeId,
        frozenContextSources,
      );
      const job: DesignJob = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        id: jobId,
        kind: input.kind,
        runnerId: input.runnerId,
        model: input.model,
        status: "queued",
        nodeId,
        parentJobId,
        contextHash: frozenContext.checksum,
        canvasRevision: project.revision,
        expectedHeadVersionId: input.kind === "node-generation" ? (node?.currentVersionId ?? null) : null,
        versionId: null,
        exportId: initialExportId,
        error: null,
        cancelRequested: false,
        conversationOnly: false,
        activity: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        finishedAt: null,
      };
      let reservedRequestMessage: DesignThreadMessage | null = null;
      let reservedAssistantMessage: DesignThreadMessage | null = null;
      if (reservedThread !== null && reservedScope !== null && reservedTurn !== undefined) {
        reservedRequestMessage = {
          id: `message-${randomUUID()}`,
          role: input.kind === "implementation-export" ? "system" : "user",
          content: reservedTurn.requestContent.trim(),
          jobId: job.id,
          createdAt: timestamp,
        };
        reservedAssistantMessage = {
          id: `message-${randomUUID()}`,
          role: "assistant",
          content: reservedTurn.assistantContent.trim(),
          jobId: job.id,
          createdAt: timestamp,
        };
        reservedThread.messages.push(reservedRequestMessage, reservedAssistantMessage);
        reservedThread.updatedAt = timestamp;
      }
      const projectBefore = structuredClone(project);
      const threadBinding: DesignJobCreationThreadBinding | null = reservedThread === null
        || reservedScope === null
        || reservedRequestMessage === null
        || reservedAssistantMessage === null
        || reservedThreadBeforeHash === null
        || reservedThreadBeforeUpdatedAt === null
        ? null
        : {
            scope: reservedScope,
            existedBefore: reservedThreadExistedBefore,
            beforeUpdatedAt: reservedThreadBeforeUpdatedAt,
            beforeHash: reservedThreadBeforeHash,
            afterHash: stableAuthorityHash(reservedThread),
            requestMessage: reservedRequestMessage,
            assistantMessage: reservedAssistantMessage,
          };
      if (receiptKey !== null) {
        project.turnReceipts[receiptKey] = {
          jobId: job.id,
          kind: job.kind,
          nodeId,
          requestHash,
          authorityHash: frozenContext.checksum,
          ...(priorReceipt?.mainPlanHash === undefined ? {} : { mainPlanHash: priorReceipt.mainPlanHash }),
          ...(priorReceipt?.mainPlanAppliedRevision === undefined
            ? {}
            : { mainPlanAppliedRevision: priorReceipt.mainPlanAppliedRevision }),
          createdAt: timestamp,
        };
      }
      if (node) {
        node.state = "queued";
        node.activeJobId = job.id;
        node.error = null;
        node.updatedAt = timestamp;
        project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
        project.revision += 1;
        project.updatedAt = Math.max(project.updatedAt, timestamp);
      }
      const created: CreatedDesignJob = {
        job,
        reused: false,
        canvas: frozenCanvas,
        receiptKey,
        threadTurnReservation: reservedThread === null
          || reservedRequestMessage === null
          || reservedAssistantMessage === null
          ? null
          : {
              thread: reservedThread,
              requestMessageId: reservedRequestMessage.id,
              assistantMessageId: reservedAssistantMessage.id,
            },
        mainThreadReservation: input.kind !== "main-agent"
          || reservedThread === null
          || reservedAssistantMessage === null
          ? null
          : { thread: reservedThread, assistantMessageId: reservedAssistantMessage.id },
      };
      const transactionId = `creation-${job.id}`;
      const transactionPath = jobCreationTransactionPath(root, transactionId);
      let transaction = withJobCreationTransactionChecksum({
        schemaVersion: DESIGN_SCHEMA_VERSION,
        id: transactionId,
        projectId,
        phase: "pending",
        job,
        jobHash: stableAuthorityHash(job),
        contextHash: frozenContext.checksum,
        thread: threadBinding,
        receiptKey,
        projectBefore,
        projectAfter: structuredClone(project),
        projectBeforeHash: stableAuthorityHash(projectBefore),
        projectAfterHash: stableAuthorityHash(project),
        createdAt: timestamp,
      });
      try {
        await writeAtomicJson(transactionPath, transaction);
        await hooks?.afterPhase?.("marker");
        await writeAtomicJson(jobContextFilePath(root, job.id), frozenContext);
        await hooks?.afterPhase?.("context");
        await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
        await hooks?.afterPhase?.("job");
        if (reservedThread !== null && reservedScope !== null) {
          await writeAuthorityJson(
            root,
            threadFilePath(root, reservedScope),
            reservedThread,
            [threadInvalidationTopic(reservedScope)],
          );
        }
        await hooks?.afterPhase?.("thread");
        if (node !== undefined || receiptKey !== null) {
          await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
        }
        await hooks?.afterPhase?.("project");
        const { checksum: _pendingChecksum, ...committedTransaction } = transaction;
        transaction = withJobCreationTransactionChecksum({
          ...committedTransaction,
          phase: "committed",
        });
        await writeAtomicJson(transactionPath, transaction);
        await hooks?.afterPhase?.("committed");
        await rm(transactionPath, { force: true });
        await hooks?.afterPhase?.("delete");
        return created;
      } catch (error) {
        if (hooks?.simulateProcessCrash) throw error;
        if (await exists(transactionPath)) await recoverPendingJobCreationsUnlocked(root);
        throw error;
      }
    });
  }

  async function getDesignJobContext(
    dataDir: string,
    projectId: string,
    jobId: string,
  ): Promise<DesignFrozenContext> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return readFrozenJobContextUnlocked(root, projectId, safeSegment(jobId, "Job id"));
    });
  }

  async function getDesignJob(dataDir: string, projectId: string, jobId: string): Promise<DesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return readJob(root, safeSegment(jobId, "Job id"));
    });
  }

  async function getDesignJobByIdempotencyKey(
    dataDir: string,
    projectId: string,
    input: DesignJobReceiptLookup,
  ): Promise<{ job: DesignJob } | null> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      if (!["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(input?.kind)
        || (input.nodeId !== null && (typeof input.nodeId !== "string" || !SAFE_SEGMENT.test(input.nodeId)))
        || typeof input.idempotencyKey !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.idempotencyKey)
        || typeof input.requestHash !== "string" || !SHA256.test(input.requestHash)) {
        throw new DesignStorageError("invalid-input", "Design Job receipt lookup authority is invalid");
      }
      const receiptKey = `${input.kind}:${input.nodeId ?? "main"}:${input.idempotencyKey}`;
      const project = await readProject(root);
      const receipt = project.turnReceipts[receiptKey];
      if (receipt === undefined) return null;
      if (receipt.kind !== input.kind || receipt.nodeId !== input.nodeId) {
        throw new DesignStorageError("conflict", "idempotencyKey is already bound to another Design Agent scope");
      }
      if (receipt.requestHash !== input.requestHash) {
        throw new DesignStorageError("conflict", "idempotencyKey is already bound to a different Design Agent request");
      }
      const job = await readJob(root, receipt.jobId);
      if (receipt.authorityHash !== job.contextHash) {
        throw new DesignStorageError("corrupt", "Design Agent receipt authority no longer matches its frozen Job context");
      }
      return { job };
    });
  }

  /**
   * Resolve the Job a server-derived idempotency key already produced, without
   * re-deriving the request hash. Used by Retry replays: the key `retry-<jobId>`
   * can only ever mean "the successor of that Job", and its prompt/canvas hash
   * legitimately changes once the successor publishes, so hashing again would
   * turn an honest duplicate click into a conflict.
   */
  async function getDesignJobByReceiptKey(
    dataDir: string,
    projectId: string,
    input: { kind: DesignJobReceiptLookup["kind"]; nodeId: string | null; idempotencyKey: string },
  ): Promise<{ job: DesignJob } | null> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      if (!["node-generation", "node-analysis", "main-agent", "implementation-export"].includes(input?.kind)
        || (input.nodeId !== null && (typeof input.nodeId !== "string" || !SAFE_SEGMENT.test(input.nodeId)))
        || typeof input.idempotencyKey !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.idempotencyKey)) {
        throw new DesignStorageError("invalid-input", "Design Job receipt lookup authority is invalid");
      }
      const receiptKey = `${input.kind}:${input.nodeId ?? "main"}:${input.idempotencyKey}`;
      const project = await readProject(root);
      const receipt = project.turnReceipts[receiptKey];
      if (receipt === undefined || receipt.kind !== input.kind || receipt.nodeId !== input.nodeId) return null;
      const job = await readJob(root, receipt.jobId);
      if (receipt.authorityHash !== job.contextHash) {
        throw new DesignStorageError("corrupt", "Design Agent receipt authority no longer matches its frozen Job context");
      }
      return { job };
    });
  }

  async function listDesignJobsUnlocked(root: string): Promise<DesignJob[]> {
    const entries = await readdir(join(root, "jobs"), { withFileTypes: true });
    const jobs = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^job-[0-9a-f-]{36}\.json$/.test(entry.name))
      .map((entry) => readJob(root, entry.name.slice(0, -5))));
    return jobs.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  }

  async function listDesignJobs(dataDir: string, projectId: string): Promise<DesignJob[]> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return listDesignJobsUnlocked(root);
    });
  }

  const TERMINAL_JOB_STATUSES = new Set<DesignJobStatus>(["ready", "failed", "cancelled", "superseded"]);
  const JOB_TRANSITIONS: Record<DesignJobStatus, ReadonlySet<DesignJobStatus>> = {
    queued: new Set(["running", "failed", "cancelled"]),
    running: new Set(["validating", "ready", "failed", "cancelled", "superseded"]),
    validating: new Set(["ready", "failed", "cancelled", "superseded"]),
    ready: new Set(),
    failed: new Set(),
    cancelled: new Set(),
    superseded: new Set(),
  };

  /** Reconcile process-local work after a daemon restart. Immutable heads stay intact. */
  async function recoverInterruptedDesignJobs(
    dataDir: string,
    projectId: string,
    now?: number,
  ): Promise<DesignJob[]> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      if (!(await exists(projectFilePath(root)))) return [];
      const timestamp = nowValue(now);
      const publicationJobs = await recoverPublicationTransactionsUnlocked(root, projectId, timestamp);
      const jobs = await listDesignJobsUnlocked(root);
      const interrupted = jobs
        .filter((job) => job.status === "queued" || job.status === "running" || job.status === "validating");
      const interruptedIds = new Set(interrupted.map((job) => job.id));
      for (const job of jobs) {
        const interruptedByThisRecovery = interruptedIds.has(job.id);
        const interruptedByPriorRecovery = job.status === "cancelled"
          && job.error === DESIGN_JOB_RESTART_INTERRUPTION_ERROR;
        const terminal = TERMINAL_JOB_STATUSES.has(job.status);
        if (!interruptedByThisRecovery && !terminal) continue;
        const projectedStatus = interruptedByThisRecovery
          ? "cancelled"
          : job.status as TerminalDesignJobStatus;
        await projectDesignJobThreadMessageUnlocked(
          root,
          job,
          terminalDesignJobThreadContent(
            job,
            projectedStatus,
            interruptedByThisRecovery || interruptedByPriorRecovery,
          ),
          timestamp,
          {
            // Preserve a rich success response. Recovery only needs to repair a
            // success/supersession when the reserved marker survived a crash.
            onlyReserved: !interruptedByThisRecovery
              && (projectedStatus === "ready" || projectedStatus === "superseded"),
          },
        );
      }
      for (const job of interrupted) {
        if (job.kind === "implementation-export" && job.exportId !== null) {
          await Promise.all([
            rm(join(root, "exports", job.exportId), { recursive: true, force: true }),
            rm(join(root, "exports", ".pending", job.exportId), { recursive: true, force: true }),
            rm(join(root, "exports", ".validation", job.exportId), { recursive: true, force: true }),
          ]);
        } else if (job.kind === "main-agent") {
          await rm(join(root, "exports", ".pending", `main-${job.id}`), { recursive: true, force: true });
        } else if (job.nodeId !== null) {
          await rm(join(nodeRoot(root, job.nodeId), ".pending", "jobs", job.id), {
            recursive: true,
            force: true,
          });
        }
        job.status = "cancelled";
        job.cancelRequested = true;
        job.error = DESIGN_JOB_RESTART_INTERRUPTION_ERROR;
        job.updatedAt = timestamp;
        job.finishedAt = timestamp;
        await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
      }

      const project = await readProject(root);
      const nodes = readNodes(project);
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      const publicationIds = new Set(publicationJobs.map((job) => job.id));
      const reprojectedTerminalJobs: DesignJob[] = [];
      let projectChanged = interrupted.length > 0;
      for (const node of nodes.values()) {
        if (node.activeJobId === null) continue;
        const activeJob = jobsById.get(node.activeJobId);
        if (!activeJob || activeJob.nodeId !== node.id) {
          throw new DesignStorageError("corrupt", `Design Node ${node.id} has invalid active Job authority`);
        }
        if (!TERMINAL_JOB_STATUSES.has(activeJob.status)) continue;
        node.state = nodeStateForJob(activeJob.status);
        node.activeJobId = null;
        node.error = activeJob.status === "failed" ? (activeJob.error ?? "Generation failed") : null;
        node.updatedAt = timestamp;
        projectChanged = true;
        if (!interruptedIds.has(activeJob.id) && !publicationIds.has(activeJob.id)) {
          reprojectedTerminalJobs.push(activeJob);
        }
      }
      if (projectChanged) {
        project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
        project.revision += 1;
        project.updatedAt = Math.max(project.updatedAt, timestamp);
        await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      }
      return [...publicationJobs, ...interrupted, ...reprojectedTerminalJobs];
    }, { allowPublicationTransactions: true });
  }

  function nodeStateForJob(status: DesignJobStatus): DesignNodeState {
    switch (status) {
      case "queued": return "queued";
      case "running": return "generating";
      case "validating": return "validating";
      case "ready": return "ready";
      case "failed": return "failed";
      case "cancelled": return "cancelled";
      case "superseded": return "superseded";
    }
  }

  async function updateDesignJob(
    dataDir: string,
    projectId: string,
    jobId: string,
    patch: {
      status?: DesignJobStatus;
      runnerId?: string;
      model?: string | null;
      contextHash?: string;
      versionId?: string | null;
      exportId?: string | null;
      error?: string | null;
      conversationOnly?: boolean;
    },
    now?: number,
  ): Promise<DesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      const job = await readJob(root, safeSegment(jobId, "Job id"));
      const timestamp = nowValue(now);
      const updatesIdentity = patch.runnerId !== undefined || patch.model !== undefined;
      if (updatesIdentity) {
        if (patch.runnerId === undefined || patch.model === undefined
          || !validStoredText(patch.runnerId, 512) || patch.runnerId.trim() !== patch.runnerId
          || !validStoredText(patch.model, 512, { nullable: true })
          || (typeof patch.model === "string" && patch.model.trim() !== patch.model)) {
          throw new DesignStorageError("invalid-input", "Observed Job runner identity is invalid");
        }
        if (job.status !== "running") {
          throw new DesignStorageError("conflict", "Observed Job runner identity may only bind a running Job");
        }
        job.runnerId = patch.runnerId;
        job.model = patch.model;
      }
      if (patch.contextHash !== undefined) {
        if (!SHA256.test(patch.contextHash)) throw new DesignStorageError("invalid-input", "Job context hash is invalid");
        job.contextHash = patch.contextHash;
      }
      if (patch.versionId !== undefined) {
        if (patch.versionId !== null) safeSegment(patch.versionId, "Version id");
        job.versionId = patch.versionId;
      }
      if (patch.exportId !== undefined) {
        if (patch.exportId !== null) safeSegment(patch.exportId, "Export id");
        job.exportId = patch.exportId;
      }
      if (patch.error !== undefined) {
        if (patch.error !== null && (typeof patch.error !== "string" || Buffer.byteLength(patch.error, "utf8") > 16_384)) {
          throw new DesignStorageError("invalid-input", "Job error is invalid");
        }
        job.error = patch.error;
      }
      if (patch.conversationOnly !== undefined) {
        if (typeof patch.conversationOnly !== "boolean" || job.kind !== "main-agent" || job.status !== "running") {
          throw new DesignStorageError("invalid-input", "Only a running Main Agent Job may bind conversation semantics");
        }
        job.conversationOnly = patch.conversationOnly;
      }
      if (patch.status !== undefined && patch.status !== job.status) {
        if (!JOB_TRANSITIONS[job.status].has(patch.status)) {
          throw new DesignStorageError("conflict", `Design Job cannot transition from ${job.status} to ${patch.status}`);
        }
        job.status = patch.status;
        if (TERMINAL_JOB_STATUSES.has(job.status)) job.finishedAt = timestamp;
      }
      job.updatedAt = timestamp;
      await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
      if (job.nodeId !== null) {
        const project = await readProject(root);
        const nodes = readNodes(project);
        const node = nodes.get(job.nodeId);
        if (!node) throw new DesignStorageError("not-found", `Design Node ${job.nodeId} was not found`);
        if (node.activeJobId === job.id) {
          node.state = nodeStateForJob(job.status);
          node.error = job.status === "failed" ? (job.error ?? "Generation failed") : null;
          if (TERMINAL_JOB_STATUSES.has(job.status)) node.activeJobId = null;
          node.updatedAt = timestamp;
          project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
          project.revision += 1;
          project.updatedAt = Math.max(project.updatedAt, timestamp);
          await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
        }
      }
      return job;
    });
  }

  async function appendDesignJobActivity(
    dataDir: string,
    projectId: string,
    jobId: string,
    input:
      | {
          kind: "tool";
          text: string;
          toolName: DesignJobToolName;
          toolCallId?: string;
          toolInput?: string;
          diff?: string;
        }
      | { kind: Exclude<DesignJobActivity["kind"], "tool">; text: string; toolName?: never },
    now?: number,
  ): Promise<DesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      const job = await readJob(root, safeSegment(jobId, "Job id"));
      if (!["text", "tool", "status"].includes(input?.kind) || typeof input?.text !== "string"
        || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 16_384
        || (input.kind === "tool"
          ? (!DESIGN_JOB_TOOL_NAMES.includes(input.toolName)
            || (input.toolCallId !== undefined && (!validStoredText(
              input.toolCallId,
              DESIGN_JOB_TOOL_CALL_ID_MAX_BYTES,
            ) || input.toolCallId.trim() !== input.toolCallId))
            || (input.toolInput !== undefined && !validDesignJobToolInput(input.toolInput))
            || (input.diff !== undefined && !validStoredText(input.diff, DESIGN_JOB_TOOL_DIFF_MAX_BYTES)))
          : input.toolName !== undefined)) {
        throw new DesignStorageError("invalid-input", "Design Job activity is invalid");
      }
      const timestamp = nowValue(now);
      job.activity.push({
        id: `activity-${randomUUID()}`,
        kind: input.kind,
        text: input.text.trim(),
        ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
        ...(input.kind !== "tool" || input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(input.kind !== "tool" || input.toolInput === undefined ? {} : { toolInput: input.toolInput }),
        ...(input.kind !== "tool" || input.diff === undefined ? {} : { diff: input.diff }),
        createdAt: timestamp,
      });
      job.activity = job.activity.slice(-MAX_JOB_ACTIVITY);
      job.updatedAt = timestamp;
      await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
      return job;
    });
  }

  async function updateDesignJobToolActivity(
    dataDir: string,
    projectId: string,
    jobId: string,
    input: { toolCallId: string; toolResult: string; toolResultError: boolean },
    now?: number,
  ): Promise<DesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      const job = await readJob(root, safeSegment(jobId, "Job id"));
      if (!validStoredText(input?.toolCallId, DESIGN_JOB_TOOL_CALL_ID_MAX_BYTES)
        || input.toolCallId.trim() !== input.toolCallId
        || !validStoredText(input?.toolResult, DESIGN_JOB_TOOL_RESULT_MAX_BYTES)
        || typeof input?.toolResultError !== "boolean") {
        throw new DesignStorageError("invalid-input", "Design Job tool result is invalid");
      }
      const activity = job.activity.findLast((entry) => (
        entry.kind === "tool" && entry.toolCallId === input.toolCallId
      ));
      if (activity === undefined) {
        throw new DesignStorageError("not-found", `Design Job tool call ${input.toolCallId} was not found`);
      }
      activity.toolResult = input.toolResult;
      activity.toolResultError = input.toolResultError;
      job.updatedAt = nowValue(now);
      await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
      return job;
    });
  }

  /**
   * Make cancellation durable in the same serialized critical section that clears
   * a Node's active Job. The process-local AbortController is owned by the Agent
   * executor, but storage never leaves cancellation as an in-memory-only request.
   */
  async function cancelDesignJob(
    dataDir: string,
    projectId: string,
    jobId: string,
    now?: number,
  ): Promise<DesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      const job = await readJob(root, safeSegment(jobId, "Job id"));
      const timestamp = nowValue(now);
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        await projectDesignJobThreadMessageUnlocked(
          root,
          job,
          terminalDesignJobThreadContent(job),
          timestamp,
          { onlyReserved: true },
        );
        return job;
      }
      await projectDesignJobThreadMessageUnlocked(
        root,
        job,
        terminalDesignJobThreadContent(job, "cancelled"),
        timestamp,
      );
      job.cancelRequested = true;
      job.status = "cancelled";
      job.error = "Agent turn cancelled";
      job.updatedAt = timestamp;
      job.finishedAt = timestamp;
      await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);

      const project = await readProject(root);
      const nodes = readNodes(project);
      if (job.nodeId !== null) {
        const node = nodes.get(job.nodeId);
        if (!node) throw new DesignStorageError("not-found", `Design Node ${job.nodeId} was not found`);
        if (node.activeJobId === job.id) {
          node.state = "cancelled";
          node.activeJobId = null;
          node.error = null;
          node.updatedAt = timestamp;
        }
      }
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      return job;
    });
  }

  async function requestDesignJobCancellation(
    dataDir: string,
    projectId: string,
    jobId: string,
    now?: number,
  ): Promise<DesignJob> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      const job = await readJob(root, safeSegment(jobId, "Job id"));
      if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
      job.cancelRequested = true;
      job.updatedAt = nowValue(now);
      await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
      return job;
    });
  }

  return {
    DESIGN_MAIN_AGENT_QUEUED_MESSAGE,
    appendDesignJobActivity,
    appendDesignThreadMessage,
    cancelDesignJob,
    createDesignJob,
    getDesignJob,
    getDesignJobByIdempotencyKey,
    getDesignJobByReceiptKey,
    getDesignJobContext,
    getDesignMainPlanExecution,
    getDesignThread,
    listDesignJobs,
    listDesignMainSessions,
    createDesignMainSession,
    activateDesignMainSession,
    renameDesignMainSession,
    deleteDesignMainSession,
    readDesignMainPlanExecutionUnlocked,
    readJob,
    recoverPendingJobCreationsUnlocked,
    recoverInterruptedDesignJobs,
    requestDesignJobCancellation,
    reserveDesignMainPlanExecution,
    updateDesignJob,
    updateDesignJobToolActivity,
    updateDesignThreadMessage,
  };
}

export type DesignJobThreadLedger = ReturnType<typeof createDesignJobThreadLedger>;
