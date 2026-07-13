import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useApi } from "../lib/api-context.tsx";
import type {
  ApiClient,
  Project,
  ProjectWorkspacePayload,
  ReadyProjectWorkspacePayload,
  UnsupportedProjectWorkspacePayload,
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

export function useProjectStudio(projectId: string): ProjectStudioState {
  const api = useApi();
  const [load, setLoad] = useState<ProjectStudioLoadState>({ status: "loading" });
  const [workspaceAgentDraft, setWorkspaceAgentDraft] = useState("");
  const [selectedGraphObjectIds, setSelectedGraphObjectIds] = useState<string[]>([]);
  const [viewportOverride, setViewport] = useState<WorkspaceViewport | null>(null);
  const [taskQueue, setTaskQueue] = useState<WorkspaceStudioTask[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retry = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    void readProjectStudio(api, projectId)
      .then(([project, workspace]) => {
        if (current) setLoad(resolveLoadState(project, workspace));
      })
      .catch((error: unknown) => {
        if (current) setLoad({ status: "error", message: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [api, loadAttempt, projectId]);

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
    retry,
  };
}
