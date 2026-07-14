import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useApi } from "../lib/api-context.tsx";
import { ApiError } from "../lib/api.ts";
import type {
  ApiClient,
  Project,
  ProjectWorkspacePayload,
  ReadyProjectWorkspacePayload,
  UnsupportedProjectWorkspacePayload,
  WorkspaceGraphCommand,
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceViewport,
} from "../lib/api.ts";

export interface WorkspaceStudioTask {
  id: string;
  label: string;
  state: "queued" | "running" | "done" | "failed";
}

export type ProjectStudioLoadState =
  | { status: "loading" }
  | { status: "ready"; project: Project; workspace: ReadyProjectWorkspacePayload }
  | { status: "prototype"; project: Project; workspace: UnsupportedProjectWorkspacePayload }
  | { status: "error"; message: string };

export interface ProjectStudioState {
  load: ProjectStudioLoadState;
  workspaceAgentDraft: string;
  setWorkspaceAgentDraft: Dispatch<SetStateAction<string>>;
  selectedGraphObjectIds: string[];
  setSelectedGraphObjectIds: Dispatch<SetStateAction<string[]>>;
  viewport: WorkspaceViewport;
  setViewport: Dispatch<SetStateAction<WorkspaceViewport | null>>;
  taskQueue: WorkspaceStudioTask[];
  setTaskQueue: Dispatch<SetStateAction<WorkspaceStudioTask[]>>;
  saveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  applyGraphCommands: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
  retry: () => void;
}

const DEFAULT_VIEWPORT: WorkspaceViewport = { x: 0, y: 0, zoom: 1 };
type ProjectStudioRequest = Promise<[Project, ProjectWorkspacePayload]>;
const inFlightReads = new WeakMap<ApiClient, Map<string, ProjectStudioRequest>>();

function readProjectStudio(api: ApiClient, projectId: string): ProjectStudioRequest {
  let byProject = inFlightReads.get(api);
  if (!byProject) {
    byProject = new Map();
    inFlightReads.set(api, byProject);
  }
  const existing = byProject.get(projectId);
  if (existing) return existing;
  const request = Promise.all([api.getProject(projectId), api.getWorkspace(projectId)]);
  byProject.set(projectId, request);
  const release = () => {
    if (byProject?.get(projectId) === request) byProject.delete(projectId);
  };
  void request.then(release, release);
  return request;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Couldn't load this project workspace.";
}

function resolveLoadState(project: Project, workspace: ProjectWorkspacePayload): ProjectStudioLoadState {
  if (project.mode === "prototype") {
    if (workspace.status !== "unsupported" || workspace.projectId !== project.id) {
      return { status: "error", message: "Prototype project workspace response is invalid." };
    }
    return { status: "prototype", project, workspace };
  }
  if (workspace.status !== "ready") {
    return { status: "error", message: "Standard project workspace is unavailable." };
  }
  if (workspace.workspace.projectId !== project.id || workspace.workspace.mode !== "standard") {
    return { status: "error", message: "Project workspace identity does not match this project." };
  }
  return { status: "ready", project, workspace };
}

function isWorkspaceRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && error.details?.code === "workspace_revision_conflict";
}

function canReplayGraphCommands(graph: WorkspaceGraph, commands: readonly WorkspaceGraphCommand[]): boolean {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  return commands.length > 0 && commands.every((command) => (
    command.type === "add-edge"
    && nodeIds.has(command.edge.sourceNodeId)
    && nodeIds.has(command.edge.targetNodeId)
    && !edgeIds.has(command.edge.id)
  ));
}

export function useProjectStudio(projectId: string): ProjectStudioState {
  const api = useApi();
  const [load, setLoad] = useState<ProjectStudioLoadState>({ status: "loading" });
  const [workspaceAgentDraft, setWorkspaceAgentDraft] = useState("");
  const [selectedGraphObjectIds, setSelectedGraphObjectIds] = useState<string[]>([]);
  const [viewportOverride, setViewport] = useState<WorkspaceViewport | null>(null);
  const [taskQueue, setTaskQueue] = useState<WorkspaceStudioTask[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadRef = useRef<ProjectStudioLoadState>(load);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const retry = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  const commitLoad = useCallback((next: ProjectStudioLoadState) => {
    loadRef.current = next;
    setLoad(next);
  }, []);

  const requireReady = useCallback((): Extract<ProjectStudioLoadState, { status: "ready" }> => {
    const current = loadRef.current;
    if (current.status !== "ready") throw new Error("The project workspace is not ready.");
    return current;
  }, []);

  const updateReadyWorkspace = useCallback((workspace: ReadyProjectWorkspacePayload) => {
    const current = requireReady();
    commitLoad({ ...current, workspace });
  }, [commitLoad, requireReady]);

  const enqueueMutation = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const result = mutationQueueRef.current.then(work);
    mutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  useEffect(() => {
    let current = true;
    commitLoad({ status: "loading" });
    void readProjectStudio(api, projectId)
      .then(([project, workspace]) => {
        if (current) commitLoad(resolveLoadState(project, workspace));
      })
      .catch((error: unknown) => {
        if (current) commitLoad({ status: "error", message: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [api, commitLoad, loadAttempt, projectId]);

  const saveLayout = useCallback((commands: readonly WorkspaceLayoutCommand[]): Promise<WorkspaceLayout> => (
    enqueueMutation(async () => {
      let current = requireReady();
      if (commands.length === 0) return current.workspace.layout;
      const save = (graphRevision: number) => api.saveWorkspaceLayout(projectId, {
        layoutId: current.workspace.layout.layoutId,
        graphRevision,
        commands,
      });
      let saved: WorkspaceLayout;
      try {
        saved = await save(current.workspace.graph.revision);
      } catch (error) {
        if (!isWorkspaceRevisionConflict(error)) throw error;
        const refreshedPayload = await api.getWorkspace(projectId);
        const refreshed = resolveLoadState(current.project, refreshedPayload);
        if (refreshed.status !== "ready") throw new Error("The refreshed Standard workspace is unavailable.");
        commitLoad(refreshed);
        current = refreshed;
        saved = await save(current.workspace.graph.revision);
      }
      updateReadyWorkspace({ ...requireReady().workspace, layout: saved });
      return saved;
    })
  ), [api, commitLoad, enqueueMutation, projectId, requireReady, updateReadyWorkspace]);

  const applyGraphCommands = useCallback((commands: readonly WorkspaceGraphCommand[]): Promise<void> => (
    enqueueMutation(async () => {
      if (commands.length === 0) return;
      let current = requireReady();
      const apply = (ready: Extract<ProjectStudioLoadState, { status: "ready" }>) => api.applyWorkspaceGraphCommands(projectId, {
        baseGraphRevision: ready.workspace.graph.revision,
        expectedSnapshotId: ready.workspace.activeSnapshot.id,
        commands,
      });
      let result;
      try {
        result = await apply(current);
      } catch (error) {
        if (!isWorkspaceRevisionConflict(error)) throw error;
        const refreshedPayload = await api.getWorkspace(projectId);
        const refreshed = resolveLoadState(current.project, refreshedPayload);
        if (refreshed.status !== "ready") throw new Error("The refreshed Standard workspace is unavailable.");
        commitLoad(refreshed);
        current = refreshed;
        if (!canReplayGraphCommands(current.workspace.graph, commands)) throw error;
        result = await apply(current);
      }
      const snapshots = current.workspace.snapshots.some((snapshot) => snapshot.id === result.snapshot.id)
        ? current.workspace.snapshots.map((snapshot) => snapshot.id === result.snapshot.id ? result.snapshot : snapshot)
        : [...current.workspace.snapshots, result.snapshot];
      updateReadyWorkspace({
        ...current.workspace,
        workspace: {
          ...current.workspace.workspace,
          graphRevision: result.graph.revision,
          activeSnapshotId: result.snapshot.id,
          updatedAt: Math.max(current.workspace.workspace.updatedAt, result.snapshot.createdAt),
        },
        graph: result.graph,
        activeSnapshot: result.snapshot,
        snapshots,
      });
    })
  ), [api, commitLoad, enqueueMutation, projectId, requireReady, updateReadyWorkspace]);

  const viewport = viewportOverride
    ?? (load.status === "ready" ? load.workspace.layout.viewport : DEFAULT_VIEWPORT);

  return {
    load,
    workspaceAgentDraft,
    setWorkspaceAgentDraft,
    selectedGraphObjectIds,
    setSelectedGraphObjectIds,
    viewport,
    setViewport,
    taskQueue,
    setTaskQueue,
    saveLayout,
    applyGraphCommands,
    retry,
  };
}
