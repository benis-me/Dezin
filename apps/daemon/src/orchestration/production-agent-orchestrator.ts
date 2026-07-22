import type {
  CreateWorkspaceProposalInput,
  GenerationTask,
  ProjectWorkspace,
  WorkspaceProposal,
} from "../../../../packages/core/src/index.ts";
import {
  ContextIntegrityError,
  cloneAndFreeze,
  normalizeAgentTurnRequest,
  type AgentTurnRequest,
  type ContextPack,
} from "../context/context-types.ts";

const CONTEXT_PACK_ID = /^context-pack-([0-9a-f]{64})$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ProductionAgentOrchestratorWorkspacePort {
  getWorkspace(workspaceId: string): Pick<ProjectWorkspace, "id" | "projectId"> | null;
}

export interface ProductionAgentContextResolverPort {
  resolve(request: AgentTurnRequest, signal: AbortSignal): Promise<ContextPack>;
}

export interface ProductionWorkspacePlannerInput {
  readonly projectId: string;
  readonly request: AgentTurnRequest;
  readonly contextPack: ContextPack;
}

export interface ProductionWorkspacePlannerPort {
  propose(
    input: ProductionWorkspacePlannerInput,
    signal: AbortSignal,
  ): Promise<CreateWorkspaceProposalInput>;
}

export interface ProductionWorkspaceTurnReplayInput {
  readonly projectId: string;
  readonly request: AgentTurnRequest;
}

export interface ProductionWorkspaceTurnCommitInput extends ProductionWorkspaceTurnReplayInput {
  readonly contextPack: ContextPack;
  readonly proposal: CreateWorkspaceProposalInput;
}

export interface ProductionWorkspaceTurnReceipt {
  readonly proposal: WorkspaceProposal;
  readonly contextPackId: string;
}

export interface ProductionWorkspaceTurnStorePort {
  replay(
    input: ProductionWorkspaceTurnReplayInput,
    signal: AbortSignal,
  ): Promise<ProductionWorkspaceTurnReceipt | null>;
  commit(
    input: ProductionWorkspaceTurnCommitInput,
    signal: AbortSignal,
  ): Promise<ProductionWorkspaceTurnReceipt>;
}

export interface ProductionScopedTaskEnqueueInput {
  readonly projectId: string;
  readonly request: AgentTurnRequest;
  readonly contextPack: ContextPack;
}

export interface ProductionScopedTaskReplayInput {
  readonly projectId: string;
  readonly request: AgentTurnRequest;
}

/**
 * The enqueue implementation owns durable Task/Plan insertion. Returning the
 * exact Context Pack binding lets this boundary reject a scheduler adapter that
 * silently substituted latest Context after dispatch.
 */
export interface ProductionScopedTaskEnqueueReceipt {
  readonly task: GenerationTask;
  readonly contextPackId: string;
}

export interface ProductionScopedTaskQueuePort {
  replay?(
    input: ProductionScopedTaskReplayInput,
    signal: AbortSignal,
  ): Promise<ProductionScopedTaskEnqueueReceipt | null>;
  enqueue(
    input: ProductionScopedTaskEnqueueInput,
    signal: AbortSignal,
  ): Promise<ProductionScopedTaskEnqueueReceipt>;
}

export interface ProductionAgentOrchestratorOptions {
  readonly workspace: ProductionAgentOrchestratorWorkspacePort;
  readonly contextResolver: ProductionAgentContextResolverPort;
  readonly workspacePlanner: ProductionWorkspacePlannerPort;
  /** Required fail-closed boundary for atomic Proposal + turn receipt persistence. */
  readonly workspaceTurns: ProductionWorkspaceTurnStorePort;
  readonly scopedTasks: ProductionScopedTaskQueuePort;
}

export type ProductionAgentTurnResult =
  | { readonly kind: "proposal"; readonly proposal: WorkspaceProposal }
  | {
      readonly kind: "task";
      readonly task: GenerationTask;
      readonly contextPackId: string;
    };

export type ProductionScopedAgentTurnResult = Extract<ProductionAgentTurnResult, { kind: "task" }>;
export type ProductionWorkspaceAgentTurnResult = Extract<ProductionAgentTurnResult, { kind: "proposal" }>;

/** Narrow HTTP/composition port; callers submit an already server-resolved scope. */
export interface ProductionAgentTurnPort {
  turn(request: AgentTurnRequest, signal: AbortSignal): Promise<ProductionAgentTurnResult>;
  /** Durable Workspace retry preflight, before current graph and Context work. */
  replayWorkspace?(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): Promise<ProductionWorkspaceAgentTurnResult | null>;
  /** Durable retry preflight; lets HTTP replay before current Head/graph fences. */
  replayScoped?(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): Promise<ProductionScopedAgentTurnResult | null>;
}

export class ProductionAgentOrchestratorError extends Error {
  readonly failureClass = "adapter" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProductionAgentOrchestratorError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent orchestration aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function invokeWithAbort<T>(
  signal: AbortSignal,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  checkAbort(signal);
  const value = Promise.resolve().then(operation);
  let listener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortReason(signal));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    if (listener !== null) signal.removeEventListener("abort", listener);
  }
}

function exactProjectOwner(
  port: ProductionAgentOrchestratorWorkspacePort,
  request: AgentTurnRequest,
): string {
  const workspace = port.getWorkspace(request.scope.workspaceId);
  if (!workspace || workspace.id !== request.scope.workspaceId
    || typeof workspace.projectId !== "string" || !RUNTIME_ID.test(workspace.projectId)) {
    throw new ProductionAgentOrchestratorError("Agent scope has no exact Project/Workspace owner");
  }
  if (request.scope.type === "workspace" && request.scope.id !== workspace.id) {
    throw new ProductionAgentOrchestratorError("Workspace Agent scope target is not its exact Workspace");
  }
  return workspace.projectId;
}

function exactContextPack(request: AgentTurnRequest, pack: ContextPack): ContextPack {
  const match = pack && typeof pack.id === "string" ? CONTEXT_PACK_ID.exec(pack.id) : null;
  if (!match || pack.hash !== match[1] || pack.workspaceId !== request.scope.workspaceId
    || pack.graphRevision !== request.graphRevision || pack.intent !== request.intent
    || !pack.target || pack.target.type !== request.scope.type || pack.target.id !== request.scope.id) {
    throw new ContextIntegrityError(
      "Agent Context Pack was substituted or does not match the exact scope, intent, and graph Revision",
    );
  }
  return pack;
}

function exactWorkspaceIntent(request: AgentTurnRequest): void {
  if (request.intent !== "plan") {
    throw new ProductionAgentOrchestratorError(
      "Workspace Agent is proposal-only; source mutation, approval, and direct generation are forbidden",
    );
  }
  if (request.turnId === undefined) {
    throw new ProductionAgentOrchestratorError(
      "Workspace Agent scope requires a durable canonical turnId",
    );
  }
}

function exactScopedIntent(request: AgentTurnRequest): void {
  if (request.intent !== "generate" && request.intent !== "edit" && request.intent !== "repair") {
    throw new ProductionAgentOrchestratorError(
      "Artifact/Resource Agent scope requires a queued generate, edit, or repair Task",
    );
  }
  if (request.turnId === undefined) {
    throw new ProductionAgentOrchestratorError(
      "Artifact/Resource Agent scope requires a durable canonical turnId",
    );
  }
}

function exactProposalInput(
  projectId: string,
  request: AgentTurnRequest,
  value: CreateWorkspaceProposalInput,
): CreateWorkspaceProposalInput {
  if (!value || typeof value !== "object" || value.projectId !== projectId
    || value.kind !== "workspace-generation" || value.generation?.kind !== "workspace-generation"
    || value.baseGraphRevision !== request.graphRevision) {
    throw new ProductionAgentOrchestratorError(
      "Workspace Planner returned a foreign or source-writing Proposal contract",
    );
  }
  return value;
}

function exactWorkspaceTurnReceipt(
  request: AgentTurnRequest,
  receipt: ProductionWorkspaceTurnReceipt,
  expectedContextPackId?: string,
): ProductionWorkspaceTurnReceipt {
  const proposal = receipt?.proposal;
  if (!proposal || typeof proposal !== "object"
    || !CONTEXT_PACK_ID.test(receipt.contextPackId)
    || (expectedContextPackId !== undefined && receipt.contextPackId !== expectedContextPackId)
    || proposal.workspaceId !== request.scope.workspaceId
    || proposal.kind !== "workspace-generation"
    || proposal.generation?.kind !== "workspace-generation"
    || proposal.baseGraphRevision !== request.graphRevision) {
    throw new ProductionAgentOrchestratorError(
      "Workspace Agent turn store returned a foreign Proposal or substituted Context Pack",
    );
  }
  return receipt;
}

function exactScopedReceipt(
  request: AgentTurnRequest,
  contextPackId: string,
  receipt: ProductionScopedTaskEnqueueReceipt,
): ProductionScopedTaskEnqueueReceipt {
  const task = receipt?.task;
  if (!task || typeof task !== "object" || receipt.contextPackId !== contextPackId
    || !CONTEXT_PACK_ID.test(receipt.contextPackId)
    || task.workspaceId !== request.scope.workspaceId
    || !RUNTIME_ID.test(task.id) || !RUNTIME_ID.test(task.planId)
    || !task.target || task.target.workspaceId !== request.scope.workspaceId
    || task.target.type !== request.scope.type || task.target.id !== request.scope.id
    || (request.scope.type === "artifact"
      && (task.target.type !== "artifact" || !RUNTIME_ID.test(task.target.trackId)
        || (task.kind !== "page" && task.kind !== "component")))
    || (request.scope.type === "resource"
      && (task.target.type !== "resource" || task.kind !== "resource"))) {
    throw new ProductionAgentOrchestratorError(
      "Scoped Agent Task enqueue returned a cross-target Task or substituted Context Pack",
    );
  }
  return receipt;
}

/**
 * Strict Task 12 scope dispatcher.
 *
 * Workspace turns can only create a reviewable draft Proposal. Artifact and
 * Resource turns can only enqueue a target-owned durable Task. This class never
 * approves Proposals, writes source, moves Heads, publishes Revisions, mutates
 * the Kernel, or marks prototype edges interactive.
 */
export class ProductionAgentOrchestrator {
  readonly #options: ProductionAgentOrchestratorOptions;

  constructor(options: ProductionAgentOrchestratorOptions) {
    this.#options = Object.freeze({ ...options });
  }

  async #replayWorkspace(
    request: AgentTurnRequest,
    projectId: string,
    signal: AbortSignal,
  ): Promise<ProductionWorkspaceAgentTurnResult | null> {
    if (!this.#options.workspaceTurns) {
      throw new ProductionAgentOrchestratorError(
        "Workspace Agent durable turn store is not configured",
      );
    }
    const replay = await invokeWithAbort(signal, () => this.#options.workspaceTurns.replay({
      projectId,
      request,
    }, signal));
    if (replay === null) return null;
    const receipt = exactWorkspaceTurnReceipt(request, replay);
    checkAbort(signal);
    return cloneAndFreeze({ kind: "proposal", proposal: receipt.proposal });
  }

  async replayWorkspace(
    unsafeRequest: unknown,
    signal: AbortSignal,
  ): Promise<ProductionWorkspaceAgentTurnResult | null> {
    checkAbort(signal);
    const request = normalizeAgentTurnRequest(unsafeRequest);
    if (request.scope.type !== "workspace") {
      throw new ProductionAgentOrchestratorError("Scoped Agent turns do not have Workspace receipts");
    }
    const projectId = exactProjectOwner(this.#options.workspace, request);
    exactWorkspaceIntent(request);
    return this.#replayWorkspace(request, projectId, signal);
  }

  async #replayScoped(
    request: AgentTurnRequest,
    projectId: string,
    signal: AbortSignal,
  ): Promise<ProductionScopedAgentTurnResult | null> {
    if (!this.#options.scopedTasks.replay) return null;
    const replay = await invokeWithAbort(signal, () => this.#options.scopedTasks.replay!({
      projectId,
      request,
    }, signal));
    if (replay === null) return null;
    const receipt = exactScopedReceipt(request, replay.contextPackId, replay);
    checkAbort(signal);
    return cloneAndFreeze({
      kind: "task",
      task: receipt.task,
      contextPackId: receipt.contextPackId,
    });
  }

  async replayScoped(
    unsafeRequest: unknown,
    signal: AbortSignal,
  ): Promise<ProductionScopedAgentTurnResult | null> {
    checkAbort(signal);
    const request = normalizeAgentTurnRequest(unsafeRequest);
    if (request.scope.type === "workspace") {
      throw new ProductionAgentOrchestratorError("Workspace Agent turns do not have scoped receipts");
    }
    const projectId = exactProjectOwner(this.#options.workspace, request);
    exactScopedIntent(request);
    return this.#replayScoped(request, projectId, signal);
  }

  async turn(unsafeRequest: unknown, signal: AbortSignal): Promise<ProductionAgentTurnResult> {
    checkAbort(signal);
    const request = normalizeAgentTurnRequest(unsafeRequest);
    const projectId = exactProjectOwner(this.#options.workspace, request);
    if (request.scope.type === "workspace") exactWorkspaceIntent(request);
    else exactScopedIntent(request);

    if (request.scope.type === "workspace") {
      const replay = await this.#replayWorkspace(request, projectId, signal);
      if (replay !== null) return replay;
    } else {
      const replay = await this.#replayScoped(request, projectId, signal);
      if (replay !== null) return replay;
    }

    const contextPack = exactContextPack(
      request,
      await invokeWithAbort(signal, () => this.#options.contextResolver.resolve(request, signal)),
    );
    checkAbort(signal);

    if (request.scope.type === "workspace") {
      const proposalInput = exactProposalInput(
        projectId,
        request,
        await invokeWithAbort(signal, () => this.#options.workspacePlanner.propose({
          projectId,
          request,
          contextPack,
        }, signal)),
      );
      checkAbort(signal);
      const proposal = exactWorkspaceTurnReceipt(
        request,
        await invokeWithAbort(signal, () => this.#options.workspaceTurns.commit({
          projectId,
          request,
          contextPack,
          proposal: proposalInput,
        }, signal)),
        contextPack.id,
      ).proposal;
      checkAbort(signal);
      return cloneAndFreeze({ kind: "proposal", proposal });
    }

    const receipt = exactScopedReceipt(
      request,
      contextPack.id,
      await invokeWithAbort(signal, () => this.#options.scopedTasks.enqueue({
        projectId,
        request,
        contextPack,
      }, signal)),
    );
    checkAbort(signal);
    return cloneAndFreeze({
      kind: "task",
      task: receipt.task,
      contextPackId: receipt.contextPackId,
    });
  }
}

export function createProductionAgentOrchestrator(
  options: ProductionAgentOrchestratorOptions,
): ProductionAgentOrchestrator {
  return new ProductionAgentOrchestrator(options);
}
