import { useCallback, useEffect, useRef, useState } from "react";

import type { DesignCanvasApi, DesignImplementationExportSelection } from "./api.ts";
import type {
  DesignAgentSelection,
  DesignCanvas,
  DesignCanvasIntent,
  DesignExportResult,
  DesignJob,
  DesignThreadScope,
} from "./types.ts";

type LoadState = "loading" | "ready" | "error";

export interface DesignCanvasController {
  loadState: LoadState;
  canvas: DesignCanvas | null;
  jobs: DesignJob[];
  error: string | null;
  mutating: boolean;
  adoptCanvas: (canvas: DesignCanvas) => void;
  refresh: () => Promise<void>;
  applyIntents: (intents: readonly DesignCanvasIntent[]) => Promise<DesignCanvas>;
  undo: () => Promise<DesignCanvas | null>;
  redo: () => Promise<DesignCanvas | null>;
  importLocalFiles: (files: readonly File[], position: { x: number; y: number }) => Promise<DesignCanvas>;
  appendMaterialVersion: (nodeId: string, file: File) => Promise<DesignCanvas>;
  submitAgentTurn: (
    scope: DesignThreadScope,
    prompt: string,
    nodeIds: readonly string[],
    selection?: DesignAgentSelection,
  ) => Promise<void>;
  startExport: (selection: DesignImplementationExportSelection) => Promise<DesignExportResult>;
  cancelJob: (jobId: string) => Promise<void>;
  retryJob: (jobId: string) => Promise<void>;
  clearError: () => void;
}

export function useDesignCanvasController({
  projectId,
  api,
  onExportReady,
}: {
  projectId: string;
  api: DesignCanvasApi;
  onExportReady?: (result: DesignExportResult) => void;
}): DesignCanvasController {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [canvas, setCanvasState] = useState<DesignCanvas | null>(null);
  const [jobs, setJobs] = useState<DesignJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const canvasRef = useRef<DesignCanvas | null>(null);
  const projectRef = useRef(projectId);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mutationCountRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const appliedRefreshSequenceRef = useRef(0);

  if (projectRef.current !== projectId) {
    projectRef.current = projectId;
    canvasRef.current = null;
    mutationQueueRef.current = Promise.resolve();
    mutationCountRef.current = 0;
    refreshSequenceRef.current += 1;
    appliedRefreshSequenceRef.current = refreshSequenceRef.current;
  }

  const setCanvas = useCallback((next: DesignCanvas): boolean => {
    if (next.projectId !== projectRef.current) return false;
    if (canvasRef.current && next.revision < canvasRef.current.revision) return false;
    canvasRef.current = next;
    setCanvasState(next);
    return true;
  }, []);

  const adoptCanvas = useCallback((next: DesignCanvas) => {
    if (!setCanvas(next)) return;
    setLoadState("ready");
    setError(null);
  }, [setCanvas]);

  const reportError = useCallback((problem: unknown) => {
    const message = problem instanceof Error ? problem.message : String(problem);
    setError(message || "The Design canvas could not be updated.");
  }, []);

  const beginMutation = useCallback(() => {
    mutationCountRef.current += 1;
    setMutating(true);
  }, []);

  const finishMutation = useCallback(() => {
    mutationCountRef.current = Math.max(0, mutationCountRef.current - 1);
    if (mutationCountRef.current === 0) setMutating(false);
  }, []);

  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    mutationQueueRef.current = mutationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        beginMutation();
        try {
          const value = await work();
          resolveResult(value);
        } catch (problem) {
          reportError(problem);
          rejectResult(problem);
        } finally {
          finishMutation();
        }
      });
    return result;
  }, [beginMutation, finishMutation, reportError]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    const controller = new AbortController();
    try {
      const [nextCanvas, nextJobs] = await Promise.all([
        api.getCanvas(projectId, controller.signal),
        api.listJobs(projectId, controller.signal),
      ]);
      if (projectRef.current !== projectId || sequence < appliedRefreshSequenceRef.current) return;
      appliedRefreshSequenceRef.current = sequence;
      const recoveredInitialLoad = canvasRef.current === null;
      setCanvas(nextCanvas);
      setJobs(nextJobs);
      setLoadState("ready");
      if (recoveredInitialLoad) setError(null);
    } catch (problem) {
      if (
        controller.signal.aborted
        || projectRef.current !== projectId
        || sequence < appliedRefreshSequenceRef.current
      ) return;
      reportError(problem);
      setLoadState(canvasRef.current ? "ready" : "error");
    }
  }, [api, projectId, reportError, setCanvas]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++refreshSequenceRef.current;
    setLoadState("loading");
    setError(null);
    void Promise.all([
      api.getCanvas(projectId, controller.signal),
      api.listJobs(projectId, controller.signal),
    ]).then(([nextCanvas, nextJobs]) => {
      if (controller.signal.aborted || projectRef.current !== projectId || sequence < appliedRefreshSequenceRef.current) return;
      appliedRefreshSequenceRef.current = sequence;
      setCanvas(nextCanvas);
      setJobs(nextJobs);
      setLoadState("ready");
    }).catch((problem: unknown) => {
      if (
        controller.signal.aborted
        || projectRef.current !== projectId
        || sequence < appliedRefreshSequenceRef.current
      ) return;
      reportError(problem);
      setLoadState("error");
    });
    return () => controller.abort();
  }, [api, projectId, reportError, setCanvas]);

  const applyIntents = useCallback((intents: readonly DesignCanvasIntent[]) => enqueue(async () => {
    const current = canvasRef.current;
    if (!current) throw new Error("Design canvas is not ready.");
    try {
      const next = await api.applyIntents(projectId, { baseRevision: current.revision, intents });
      setCanvas(next);
      return next;
    } catch (problem) {
      if (!isConflict(problem)) throw problem;
      await refresh();
      const canonical = canvasRef.current;
      if (!canonical) throw problem;
      const next = await api.applyIntents(projectId, { baseRevision: canonical.revision, intents });
      setCanvas(next);
      return next;
    }
  }), [api, enqueue, projectId, refresh, setCanvas]);

  const undo = useCallback(() => enqueue(async () => {
    const current = canvasRef.current;
    if (!current || current.undoDepth === 0) return null;
    try {
      const next = await api.undo(projectId, current.revision);
      setCanvas(next);
      return next;
    } catch (problem) {
      if (!isConflict(problem)) throw problem;
      await refresh();
      const canonical = canvasRef.current;
      if (!canonical || canonical.undoDepth === 0) return null;
      const next = await api.undo(projectId, canonical.revision);
      setCanvas(next);
      return next;
    }
  }), [api, enqueue, projectId, refresh, setCanvas]);

  const redo = useCallback(() => enqueue(async () => {
    const current = canvasRef.current;
    if (!current || current.redoDepth === 0) return null;
    try {
      const next = await api.redo(projectId, current.revision);
      setCanvas(next);
      return next;
    } catch (problem) {
      if (!isConflict(problem)) throw problem;
      await refresh();
      const canonical = canvasRef.current;
      if (!canonical || canonical.redoDepth === 0) return null;
      const next = await api.redo(projectId, canonical.revision);
      setCanvas(next);
      return next;
    }
  }), [api, enqueue, projectId, refresh, setCanvas]);

  const importLocalFiles = useCallback((files: readonly File[], position: { x: number; y: number }) => enqueue(async () => {
    const next = await api.importLocalFiles(projectId, files, position);
    setCanvas(next);
    return next;
  }), [api, enqueue, projectId, setCanvas]);

  const appendMaterialVersion = useCallback((nodeId: string, file: File) => enqueue(async () => {
    const next = await api.appendMaterialVersion(projectId, nodeId, file);
    setCanvas(next);
    return next;
  }), [api, enqueue, projectId, setCanvas]);

  const submitAgentTurn = useCallback(async (
    scope: DesignThreadScope,
    prompt: string,
    nodeIds: readonly string[],
    selection: DesignAgentSelection = {},
  ) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    beginMutation();
    try {
      const result = await api.submitAgentTurn(projectId, scope, {
        prompt: trimmed,
        context: { nodeIds: [...new Set(nodeIds)] },
        ...selection,
      });
      if (projectRef.current !== projectId) return;
      if (result.canvas) setCanvas(result.canvas);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      await refresh();
    } catch (problem) {
      reportError(problem);
      throw problem;
    } finally {
      finishMutation();
    }
  }, [api, beginMutation, finishMutation, projectId, refresh, reportError, setCanvas]);

  const startExport = useCallback(async (selection: DesignImplementationExportSelection) => {
    const current = canvasRef.current;
    if (!current) throw new Error("Design canvas is not ready.");
    beginMutation();
    try {
      const result = await api.startImplementationExport(projectId, current.revision, selection);
      setJobs((existing) => [result.job, ...existing.filter((job) => job.id !== result.job.id)]);
      onExportReady?.(result);
      await refresh();
      return result;
    } catch (problem) {
      reportError(problem);
      throw problem;
    } finally {
      finishMutation();
    }
  }, [api, beginMutation, finishMutation, onExportReady, projectId, refresh, reportError]);

  const cancelJob = useCallback(async (jobId: string) => {
    beginMutation();
    try {
      const cancelled = await api.cancelJob(projectId, jobId);
      setJobs((current) => current.map((job) => job.id === cancelled.id ? cancelled : job));
      await refresh();
    } catch (problem) {
      reportError(problem);
      throw problem;
    } finally {
      finishMutation();
    }
  }, [api, beginMutation, finishMutation, projectId, refresh, reportError]);

  const retryJob = useCallback(async (jobId: string) => {
    beginMutation();
    try {
      const result = await api.retryJob(projectId, jobId);
      if (projectRef.current !== projectId) return;
      if ("canvas" in result) setCanvas(result.canvas);
      if ("exportId" in result) onExportReady?.({ exportId: result.exportId, job: result.job });
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      await refresh();
    } catch (problem) {
      reportError(problem);
      throw problem;
    } finally {
      finishMutation();
    }
  }, [api, beginMutation, finishMutation, onExportReady, projectId, refresh, reportError, setCanvas]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const message of api.streamInvalidations(projectId, controller.signal)) {
          if (controller.signal.aborted || projectRef.current !== projectId) return;
          if (message.type === "reset"
            || message.topics.includes("canvas")
            || message.topics.includes("jobs")) {
            await refresh();
          }
        }
      } catch (problem) {
        if (!controller.signal.aborted && projectRef.current === projectId) reportError(problem);
      }
    })();
    return () => controller.abort();
  }, [api, projectId, refresh, reportError]);

  return {
    loadState,
    canvas,
    jobs,
    error,
    mutating,
    adoptCanvas,
    refresh,
    applyIntents,
    undo,
    redo,
    importLocalFiles,
    appendMaterialVersion,
    submitAgentTurn,
    startExport,
    cancelJob,
    retryJob,
    clearError: () => setError(null),
  };
}

function isConflict(problem: unknown): boolean {
  return problem instanceof Error && "status" in problem && problem.status === 409;
}
