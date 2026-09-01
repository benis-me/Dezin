import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";

import type { AgentInfo } from "../lib/api.ts";
import {
  activeAgentActivityPhase,
  agentScopeKey,
  groupMainAgentJobs,
  relatedAgentJobs,
  retryFailureMessage,
  type OptimisticUserTurn,
} from "./agent-panel-model.ts";
import { isDesignAgentCommand, type DesignCanvasApi } from "./api.ts";
import type {
  DesignJob,
  DesignInvalidationTopic,
  DesignNode,
  DesignNodeVersion,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";

export interface CanvasAgentSelection {
  agentCommand: string;
  model: string;
}

const MAX_INITIAL_CONTEXT_NODES = 24;

function normalizedInitialContextNodeIds(
  initialContextNodeIds: readonly string[] | undefined,
  nodes: readonly DesignNode[],
): string[] {
  if (!initialContextNodeIds?.length || nodes.length === 0) return [];
  const existingIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const nodeId of initialContextNodeIds) {
    if (!existingIds.has(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    normalized.push(nodeId);
    if (normalized.length === MAX_INITIAL_CONTEXT_NODES) break;
  }
  return normalized;
}

export interface UseCanvasAgentPanelControllerOptions {
  projectId: string;
  api: DesignCanvasApi;
  scope: DesignThreadScope;
  nodes: readonly DesignNode[];
  jobs: readonly DesignJob[];
  versions: readonly DesignNodeVersion[];
  selectedVersionId?: string | null;
  agents: readonly AgentInfo[];
  initialAgentCommand: string;
  initialModel: string;
  initialContextNodeIds?: readonly string[];
  contextSeedGeneration?: number;
  initialDraft?: string;
  agentSelection?: CanvasAgentSelection;
  onAgentSelectionChange?: (selection: CanvasAgentSelection) => void;
  onSubmit: (
    prompt: string,
    nodeIds: readonly string[],
    selection: { agentCommand?: string; model?: string | null },
  ) => Promise<void>;
  onAppendMaterialVersion?: (file: File) => Promise<void>;
  onSelectVersion?: (versionId: string) => Promise<void>;
  onAttachFiles: (files: readonly File[]) => Promise<void>;
  onRescanAgents: () => Promise<void>;
}

function errorMessage(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}

export function useCanvasAgentPanelController({
  projectId,
  api,
  scope,
  nodes,
  jobs,
  versions,
  selectedVersionId,
  agents,
  initialAgentCommand,
  initialModel,
  initialContextNodeIds,
  contextSeedGeneration,
  initialDraft,
  agentSelection: controlledAgentSelection,
  onAgentSelectionChange,
  onSubmit,
  onAppendMaterialVersion,
  onSelectVersion,
  onAttachFiles,
  onRescanAgents,
}: UseCanvasAgentPanelControllerOptions) {
  const [thread, setThread] = useState<DesignThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(true);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [optimisticUserTurn, setOptimisticUserTurn] = useState<OptimisticUserTurn | null>(null);
  const [appendingRevision, setAppendingRevision] = useState(false);
  const [internalAgentSelection, setInternalAgentSelection] = useState<CanvasAgentSelection>(() => ({
    agentCommand: initialAgentCommand,
    model: initialModel,
  }));
  const agentSelection = controlledAgentSelection ?? internalAgentSelection;
  const setAgentSelection = useCallback((next: CanvasAgentSelection) => {
    setInternalAgentSelection((current) => (
      current.agentCommand === next.agentCommand && current.model === next.model ? current : next
    ));
    onAgentSelectionChange?.(next);
  }, [onAgentSelectionChange]);
  const [contextNodeIds, setContextNodeIds] = useState<string[]>(() => (
    normalizedInitialContextNodeIds(initialContextNodeIds, nodes)
  ));
  const consumedContextSeedGenerationRef = useRef(contextSeedGeneration);
  const optimisticTurnSequenceRef = useRef(0);
  const threadLoadSequenceRef = useRef(0);
  const loadedThreadScopeRef = useRef<string | null>(null);
  const scopeKey = agentScopeKey(scope);
  const relatedJobs = useMemo(
    () => relatedAgentJobs(jobs, scope),
    [jobs, scopeKey],
  );
  const activeTurnJob = useMemo(() => [...relatedJobs].reverse().find((job) => (
    activeAgentActivityPhase(job) !== null
    && (scope.type === "node" || job.kind === "main-agent")
  )) ?? null, [relatedJobs, scopeKey]);
  const nodeNames = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.name])),
    [nodes],
  );
  const scopedNode = scope.type === "node"
    ? nodes.find((node) => node.id === scope.nodeId) ?? null
    : null;
  const mainJobGroups = useMemo(
    () => scope.type === "main" ? groupMainAgentJobs(relatedJobs, thread) : [],
    [relatedJobs, scope.type, thread],
  );
  const availableAgents = useMemo(
    () => agents.filter((agent) => isDesignAgentCommand(agent.command) && agent.available),
    [agents],
  );
  const activeAgent = availableAgents.find((agent) => agent.command === agentSelection.agentCommand) ?? null;
  const threadInvalidationTopic: DesignInvalidationTopic = scope.type === "main"
    ? "thread:main"
    : `thread:node:${scope.nodeId}`;
  const transcriptTailKey = relatedJobs.map((job) => (
    `${job.id}:${job.status}:${job.activity.length}:${job.error ?? ""}`
  )).join("|");
  const requestedVersionId = selectedVersionId ?? versions.at(-1)?.id ?? "";
  const activeVersion = versions.find((version) => version.id === requestedVersionId)
    ?? versions.at(-1)
    ?? null;
  const activeVersionId = activeVersion?.id ?? "";
  const visibleOptimisticUserTurn = useMemo(() => {
    if (!optimisticUserTurn || optimisticUserTurn.scopeKey !== scopeKey) return null;
    const canonicalMessageArrived = thread?.messages.some((message) => (
      message.role === "user"
      && message.content.trim() === optimisticUserTurn.message.content
      && !optimisticUserTurn.existingMessageIds.has(message.id)
    )) ?? false;
    return canonicalMessageArrived ? null : optimisticUserTurn;
  }, [optimisticUserTurn, scopeKey, thread]);

  const loadThread = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++threadLoadSequenceRef.current;
    const initialLoad = loadedThreadScopeRef.current !== scopeKey;
    if (initialLoad) setThreadLoading(true);
    try {
      const next = await api.getThread(projectId, scope, signal);
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current) {
        loadedThreadScopeRef.current = scopeKey;
        setThread(next);
        setThreadError(null);
      }
    } catch (problem) {
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current) {
        loadedThreadScopeRef.current = scopeKey;
        setThreadError(errorMessage(problem));
      }
    } finally {
      if (!signal?.aborted && sequence === threadLoadSequenceRef.current && initialLoad) {
        setThreadLoading(false);
      }
    }
  }, [api, projectId, scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadThread(controller.signal);
    return () => controller.abort();
  }, [loadThread]);

  useEffect(() => {
    setOptimisticUserTurn(null);
  }, [scopeKey]);

  useEffect(() => {
    const existingIds = new Set(nodes.map((node) => node.id));
    setContextNodeIds((current) => {
      const next = current.filter((id) => existingIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [nodes]);

  useEffect(() => {
    if (contextSeedGeneration === undefined
      || consumedContextSeedGenerationRef.current === contextSeedGeneration) return;
    consumedContextSeedGenerationRef.current = contextSeedGeneration;
    setContextNodeIds(normalizedInitialContextNodeIds(initialContextNodeIds, nodes));
    setDraft(initialDraft ?? "");
  }, [contextSeedGeneration, initialContextNodeIds, initialDraft, nodes]);

  useEffect(() => {
    const selected = availableAgents.find((agent) => agent.command === agentSelection.agentCommand) ?? null;
    if (selected) {
      if (agentSelection.model && !selected.models.includes(agentSelection.model)) {
        setAgentSelection({ agentCommand: selected.command, model: "" });
      }
      return;
    }
    const fallback = availableAgents[0] ?? null;
    if (fallback) {
      setAgentSelection({ agentCommand: fallback.command, model: "" });
    } else if (agentSelection.agentCommand || agentSelection.model) {
      setAgentSelection({ agentCommand: "", model: "" });
    }
  }, [agentSelection.agentCommand, agentSelection.model, availableAgents, setAgentSelection]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const message of api.streamInvalidations(projectId, controller.signal)) {
          if (controller.signal.aborted) return;
          if (message.type === "reset" || message.topics.includes(threadInvalidationTopic)) {
            await loadThread(controller.signal);
          }
        }
      } catch (problem) {
        if (!controller.signal.aborted) setThreadError(errorMessage(problem));
      }
    })();
    return () => controller.abort();
  }, [api, loadThread, projectId, threadInvalidationTopic]);

  const submit = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || submittingRef.current || activeTurnJob !== null || !activeAgent) return;
    submittingRef.current = true;
    const optimisticId = `optimistic-user-${++optimisticTurnSequenceRef.current}`;
    setOptimisticUserTurn({
      scopeKey,
      message: {
        id: optimisticId,
        role: "user",
        content: prompt,
        jobId: null,
        createdAt: Date.now(),
      },
      existingMessageIds: new Set(thread?.messages.map((message) => message.id) ?? []),
      existingJobIds: new Set(relatedJobs.map((job) => job.id)),
    });
    setSubmitting(true);
    setThreadError(null);
    setDraft("");
    try {
      const selectedModel = agentSelection.model && activeAgent.models.includes(agentSelection.model)
        ? agentSelection.model
        : null;
      await onSubmit(prompt, contextNodeIds, {
        agentCommand: activeAgent.command,
        model: selectedModel,
      });
      await loadThread();
    } catch (problem) {
      setOptimisticUserTurn((current) => current?.message.id === optimisticId ? null : current);
      setDraft((current) => current || prompt);
      setThreadError(errorMessage(problem));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [activeAgent, activeTurnJob, agentSelection.model, contextNodeIds, draft, loadThread, onSubmit, relatedJobs, scopeKey, thread]);

  const appendMaterialRevision = useCallback(async (file: File) => {
    if (!onAppendMaterialVersion || appendingRevision) return;
    setAppendingRevision(true);
    setThreadError(null);
    try {
      await onAppendMaterialVersion(file);
    } catch (problem) {
      setThreadError(errorMessage(problem));
    } finally {
      setAppendingRevision(false);
    }
  }, [appendingRevision, onAppendMaterialVersion]);

  const selectVersion = useCallback(async (versionId: string) => {
    if (!onSelectVersion || versionId === activeVersionId) return;
    try {
      await onSelectVersion(versionId);
    } catch (problem) {
      setThreadError(errorMessage(problem));
    }
  }, [activeVersionId, onSelectVersion]);

  const attachFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return;
    try {
      await onAttachFiles(files);
    } catch (problem) {
      setThreadError(errorMessage(problem));
    }
  }, [onAttachFiles]);

  const rescanAgents = useCallback(async () => {
    try {
      await onRescanAgents();
    } catch (problem) {
      setThreadError(errorMessage(problem));
    }
  }, [onRescanAgents]);

  return {
    scopeKey,
    thread,
    threadLoading,
    threadError,
    dismissThreadError: () => setThreadError(null),
    draft,
    setDraft,
    submitting,
    visibleOptimisticUserTurn,
    appendingRevision,
    agentSelection,
    setAgentSelection,
    contextNodeIds,
    setContextNodeIds,
    relatedJobs,
    activeTurnJob,
    nodeNames,
    scopedNode,
    mainJobGroups,
    availableAgents,
    activeAgent,
    transcriptTailKey,
    activeVersion,
    activeVersionId,
    submit,
    appendMaterialRevision,
    selectVersion,
    attachFiles,
    rescanAgents,
  };
}

export function useAgentTranscriptController({
  scopeKey,
  tailKey,
  optimisticUserTurnId,
  threadMessageCount,
  threadUpdatedAt,
}: {
  scopeKey: string;
  tailKey: string;
  optimisticUserTurnId: string | null;
  threadMessageCount: number | undefined;
  threadUpdatedAt: number | undefined;
}) {
  const [historyPages, setHistoryPages] = useState(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const followTailRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    setHistoryPages(1);
    restoreScrollRef.current = null;
    followTailRef.current = true;
    setShowScrollToBottom(false);
  }, [scopeKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const restore = restoreScrollRef.current;
    if (restore) {
      transcript.scrollTop = restore.top + transcript.scrollHeight - restore.height;
      restoreScrollRef.current = null;
    } else if (followTailRef.current || optimisticUserTurnId !== null) {
      transcript.scrollTop = transcript.scrollHeight;
      followTailRef.current = true;
      setShowScrollToBottom(false);
    }
  }, [historyPages, optimisticUserTurnId, tailKey, threadMessageCount, threadUpdatedAt]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const transcript = event.currentTarget;
    followTailRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 56;
    setShowScrollToBottom(!followTailRef.current);
  }, []);

  const scrollToBottom = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
    followTailRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  const showEarlier = useCallback(() => {
    const transcript = transcriptRef.current;
    if (transcript) {
      restoreScrollRef.current = {
        height: transcript.scrollHeight,
        top: transcript.scrollTop,
      };
    }
    setHistoryPages((current) => current + 1);
  }, []);

  return { historyPages, transcriptRef, onScroll, showEarlier, showScrollToBottom, scrollToBottom };
}

export function useJobActionController({
  jobId,
  active,
  displayLabel,
  onCancel,
  onRetry,
}: {
  jobId: string;
  active: boolean;
  displayLabel: string;
  onCancel?: (jobId: string) => Promise<void>;
  onRetry?: (jobId: string) => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const stoppingRef = useRef(false);
  const retryingRef = useRef(false);

  useEffect(() => {
    if (!active) setStopError(null);
  }, [active]);

  const stop = useCallback(async () => {
    if (!onCancel || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setStopError(null);
    try {
      await onCancel(jobId);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "The Agent did not acknowledge cancellation";
      setStopError(`Couldn't stop ${displayLabel}. ${detail}`);
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [displayLabel, jobId, onCancel]);

  const dismissStopError = useCallback(() => setStopError(null), []);

  const retry = useCallback(async () => {
    if (!onRetry || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry(jobId);
    } catch (error) {
      setRetryError(retryFailureMessage(error, displayLabel));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }, [displayLabel, jobId, onRetry]);

  return {
    stopping,
    stopError,
    dismissStopError,
    stop,
    retrying,
    retryError,
    retry,
  };
}
