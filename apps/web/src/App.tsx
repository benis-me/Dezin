import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Shell } from "./components/Shell.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Button, Dialog, Loading } from "./components/ui/index.ts";
import { useToast } from "./components/Toast.tsx";
import { useRoute, navigate, replace, routeToPath, type Route } from "./router.tsx";
import { useApi } from "./lib/api-context.tsx";
import type { ApiClient } from "./lib/api.ts";
import {
  setPendingAgent,
  discardPendingDesignWorkspaceTurn,
  setPendingBrief,
  setPendingDesignWorkspaceTurn,
  setPendingImages,
  setPendingRefs,
  type PendingDesignWorkspaceAttachment,
  type PendingProjectAttachments,
} from "./lib/pending-brief.ts";
import { persistedDesignSystemId } from "./lib/design-system-selection.ts";
import { slugify } from "./lib/project-ref.ts";
import { HomeScreen } from "./screens/HomeScreen.tsx";

const WorkspaceScreen = lazy(() => import("./screens/WorkspaceScreen.tsx").then((module) => ({ default: module.WorkspaceScreen })));
const ProjectStudioScreen = lazy(() =>
  import("./project-studio/ProjectStudioScreen.tsx").then((module) => ({ default: module.ProjectStudioScreen })),
);
const DesignSystemsScreen = lazy(() => import("./screens/DesignSystemsScreen.tsx").then((module) => ({ default: module.DesignSystemsScreen })));
const DesignSystemDetailScreen = lazy(() =>
  import("./screens/DesignSystemDetailScreen.tsx").then((module) => ({ default: module.DesignSystemDetailScreen })),
);
const DesignSystemNewScreen = lazy(() => import("./screens/DesignSystemNewScreen.tsx").then((module) => ({ default: module.DesignSystemNewScreen })));
const EffectsScreen = lazy(() => import("./screens/EffectsScreen.tsx").then((module) => ({ default: module.EffectsScreen })));
const EffectScreen = lazy(() => import("./screens/EffectScreen.tsx").then((module) => ({ default: module.EffectScreen })));
const SettingsScreen = lazy(() => import("./screens/SettingsScreen.tsx").then((module) => ({ default: module.SettingsScreen })));
const OnboardingScreen = lazy(() => import("./screens/OnboardingScreen.tsx").then((module) => ({ default: module.OnboardingScreen })));
const MoodboardsScreen = lazy(() => import("./screens/MoodboardsScreen.tsx").then((module) => ({ default: module.MoodboardsScreen })));

const MoodboardScreen = lazy(() =>
  import("./screens/MoodboardScreen.tsx").then((module) => ({ default: module.MoodboardScreen })),
);

function briefToName(brief: string): string {
  const t = brief.trim().replace(/\s+/g, " ");
  return t.length === 0 ? "Untitled" : t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function stagedImageName(
  name: string,
  index: number,
  mimeType: "image/png" | "image/jpeg" | undefined,
): string {
  const safe = (name.split(/[/\\]/).pop() ?? "image")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const dot = safe.lastIndexOf(".");
  const suppliedExtension = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : "";
  const extension = mimeType === "image/png"
    ? ".png"
    : mimeType === "image/jpeg"
      ? ".jpg"
      : suppliedExtension;
  const stem = (dot > 0 && suppliedExtension ? safe.slice(0, dot) : safe)
    .replace(/^\.+/, "")
    .slice(0, 48) || "image";
  return `home-image-${index + 1}-${stem}${extension}`;
}

function stagedAttachmentTitle(value: string, fallback: string): string {
  return value.trim().slice(0, 256) || fallback;
}

async function stageDesignWorkspaceAttachments(
  api: Pick<ApiClient, "uploadRef">,
  projectId: string,
  attachments: PendingProjectAttachments | undefined,
  onStaged: (attachments: PendingDesignWorkspaceAttachment[]) => void,
): Promise<PendingDesignWorkspaceAttachment[]> {
  const staged: PendingDesignWorkspaceAttachment[] = [];
  for (const [index, image] of (attachments?.images ?? []).entries()) {
    const uploaded = await api.uploadRef(
      projectId,
      stagedImageName(image.name, index, image.mimeType),
      image.base64,
    );
    staged.push({
      title: stagedAttachmentTitle(image.name, `Image ${index + 1}`),
      uploadedFileId: uploaded.path,
      preview: true,
    });
    onStaged([...staged]);
  }
  for (const [index, ref] of (attachments?.refs ?? []).entries()) {
    if (ref.projectReference !== undefined) {
      staged.push({
        title: stagedAttachmentTitle(ref.name, `Reference ${index + 1}`),
        projectReference: ref.projectReference,
      });
      onStaged([...staged]);
      continue;
    }
    const uploaded = await api.uploadRef(
      projectId,
      `home-reference-${index + 1}-${slugify(ref.name)}.html`,
      ref.base64,
    );
    staged.push({
      title: stagedAttachmentTitle(ref.name, `Reference ${index + 1}`),
      uploadedFileId: uploaded.path,
    });
    onStaged([...staged]);
  }
  return staged;
}

function pendingWorkspaceTurnId(): string {
  return `turn-${globalThis.crypto.randomUUID().toLowerCase()}`;
}

function Screen({ route, onOpenSettings }: { route: Route; onOpenSettings: (section?: string) => void }) {
  const api = useApi();
  const { toast } = useToast();
  switch (route.name) {
    case "project":
      if (route.id === "new") {
        return <WorkspaceScreen key={route.id} projectId={route.id} onOpenSettings={onOpenSettings} />;
      }
      return (
        <ProjectStudioScreen
          key={route.id}
          projectId={route.id}
          artifactId={null}
          artifactRevisionId={null}
          resourceId={null}
          resourceRevisionId={null}
          legacyFallback={WorkspaceScreen}
          onOpenSettings={onOpenSettings}
        />
      );
    case "project-canvas":
    case "project-artifact":
    case "project-artifact-revision":
    case "project-artifact-candidate":
    case "project-resource":
    case "project-resource-revision":
      // key by projectId: switching projects must give a FRESH instance (full state reset), not reuse
      // one component whose refs (activeConv, abortRef, running/queue) leak from the previous project.
      return (
        <ProjectStudioScreen
          key={route.id}
          projectId={route.id}
          artifactId={route.name === "project-artifact" || route.name === "project-artifact-revision"
            || route.name === "project-artifact-candidate" ? route.artifactId : null}
          artifactRevisionId={route.name === "project-artifact-revision" ? route.revisionId : null}
          artifactCandidate={route.name === "project-artifact-candidate"
            ? { planId: route.planId, taskId: route.taskId, attempt: route.attempt }
            : null}
          resourceId={route.name === "project-resource" || route.name === "project-resource-revision"
            ? route.resourceId
            : null}
          resourceRevisionId={route.name === "project-resource-revision" ? route.revisionId : null}
          legacyFallback={WorkspaceScreen}
          onOpenSettings={onOpenSettings}
        />
      );
    case "moodboards":
      return <MoodboardsScreen onOpenBoard={(id) => navigate(`/moodboards/${id}`)} />;
    case "moodboard":
      return <MoodboardScreen key={route.id} boardId={route.id} onBack={() => navigate("/moodboards")} onOpenSettings={onOpenSettings} />;
    case "design-systems":
      return <DesignSystemsScreen />;
    case "design-system":
      return <DesignSystemDetailScreen id={route.id} />;
    case "design-system-new":
      return <DesignSystemNewScreen />;
    case "effects":
      return <EffectsScreen />;
    case "effect-new":
      return <EffectsScreen startNew />;
    case "effect":
      return <EffectScreen effectId={route.id} onBack={() => navigate("/effects")} />;
    case "settings":
      return null;
    case "home":
    default:
      return (
        <HomeScreen
          onNewProject={async (brief, skillId, designSystemId, mode, sharingan, agentSelection, attachments) => {
            let createdProjectId: string | null = null;
            let recoverableStandardProjectId: string | null = null;
            try {
              const initialTurnId = mode === "standard" ? pendingWorkspaceTurnId() : undefined;
              const project = await api.createProject({
                name: briefToName(brief),
                skillId,
                designSystemId: sharingan
                  ? null
                  : persistedDesignSystemId(designSystemId ?? ""),
                mode,
                sharingan: !!sharingan,
                sourceUrl: sharingan?.sourceUrl,
                ...(sharingan && initialTurnId ? { initialTurnId } : {}),
              });
              createdProjectId = project.id;
              if (mode === "standard") {
                const attachmentCount = (attachments?.images.length ?? 0) + (attachments?.refs.length ?? 0);
                const pendingTurn = {
                  projectId: project.id,
                  turnId: initialTurnId!,
                  brief,
                  ...(agentSelection?.agentCommand ? { agentCommand: agentSelection.agentCommand } : {}),
                  ...(agentSelection?.model ? { model: agentSelection.model } : {}),
                  attachmentCount,
                  attachmentsStaged: attachmentCount === 0,
                  attachments: [] as PendingDesignWorkspaceAttachment[],
                };
                if (!setPendingDesignWorkspaceTurn(pendingTurn)) {
                  throw new Error("Initial project context could not be saved for recovery");
                }
                recoverableStandardProjectId = project.id;
                await stageDesignWorkspaceAttachments(
                  api,
                  project.id,
                  attachments,
                  (currentAttachments) => {
                    if (!setPendingDesignWorkspaceTurn({
                      ...pendingTurn,
                      attachmentsStaged: currentAttachments.length === attachmentCount,
                      attachments: currentAttachments,
                    })) {
                      throw new Error("Initial project attachments could not be saved for recovery");
                    }
                  },
                );
                setPendingImages([]);
                setPendingRefs([]);
              } else {
                setPendingImages(attachments?.images ?? []);
                setPendingRefs(attachments?.refs ?? []);
                setPendingBrief(brief);
                if (agentSelection?.agentCommand) {
                  setPendingAgent(agentSelection.agentCommand, agentSelection.model);
                }
              }
              void api
                .generateProjectTitle(project.id, brief)
                .then((updated) => window.dispatchEvent(new CustomEvent("dezin:project-title", { detail: updated })))
                .catch(() => {});
              navigate(`/projects/${project.id}`);
            } catch {
              if (createdProjectId !== null && recoverableStandardProjectId === createdProjectId) {
                setPendingImages([]);
                setPendingRefs([]);
                navigate(`/projects/${createdProjectId}`);
                toast("Project created. Add the missing attachments to continue.", { variant: "error" });
                return;
              }
              if (createdProjectId !== null) {
                try {
                  await api.deleteProject(createdProjectId);
                  discardPendingDesignWorkspaceTurn(createdProjectId);
                } catch {
                  // Keep the project-scoped handoff if cleanup fails so the
                  // incomplete project remains diagnosable and recoverable.
                }
              }
              toast("Couldn't create the project.", { variant: "error" });
            }
          }}
          onOpenProject={(id) => navigate(`/projects/${id}`)}
        />
      );
  }
}

function routeLifetimeKey(route: Route): string {
  if (route.name === "project" || route.name === "project-canvas" || route.name === "project-artifact"
    || route.name === "project-artifact-revision" || route.name === "project-artifact-candidate"
    || route.name === "project-resource"
    || route.name === "project-resource-revision") {
    return `project:${route.id}`;
  }
  return routeToPath(route);
}

class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Route failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid h-full min-h-0 w-full place-items-center p-6 text-center">
        <div>
          <p className="text-sm font-medium">Couldn't open this screen.</p>
          <Button className="mt-3" variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}

function RouteLoading({ label }: { label: string }) {
  return (
    <div className="grid h-full min-h-0 w-full place-items-center">
      <Loading label={label} />
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem("dezin.onboarded") === "1";
    } catch {
      return true;
    }
  });
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const backgroundRouteRef = useRef<Route | null>(route.name === "settings" ? null : route);
  if (route.name !== "settings") backgroundRouteRef.current = route;
  const backgroundRoute = route.name === "settings" ? backgroundRouteRef.current : route;
  const settingsReturnPathRef = useRef(route.name === "settings" ? "/" : routeToPath(route));
  const settingsOpenedInAppRef = useRef(false);
  const openSettings = useCallback((section?: string) => {
    if (route.name !== "settings") {
      settingsReturnPathRef.current = routeToPath(route);
      settingsOpenedInAppRef.current = true;
    }
    setSettingsSection(section);
    navigate("/settings");
  }, [route]);
  const closeSettings = useCallback(() => {
    setSettingsSection(undefined);
    if (settingsOpenedInAppRef.current) {
      settingsOpenedInAppRef.current = false;
      window.history.back();
      return;
    }
    replace(settingsReturnPathRef.current || "/");
  }, []);
  const onToggleDark = () =>
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem("dezin.theme", next ? "dark" : "light");
      } catch {
        /* ignore */
      }
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (route.name === "settings") closeSettings();
        else openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings, openSettings, route.name]);

  useEffect(() => {
    if (route.name !== "settings") settingsOpenedInAppRef.current = false;
  }, [route.name]);

  if (!onboarded) {
    return (
      <RouteErrorBoundary>
        <Suspense fallback={<RouteLoading label="Loading Dezin..." />}>
          <OnboardingScreen
            onDone={() => {
              try {
                localStorage.setItem("dezin.onboarded", "1");
              } catch {
                /* ignore */
              }
              setOnboarded(true);
            }}
          />
        </Suspense>
      </RouteErrorBoundary>
    );
  }

  return (
    <Shell dark={dark} onToggleDark={onToggleDark} onOpenSettings={openSettings} routeOverride={backgroundRoute ?? undefined}>
      <RouteErrorBoundary key={backgroundRoute ? routeLifetimeKey(backgroundRoute) : "direct-settings"}>
        <Suspense fallback={<RouteLoading label="Loading screen..." />}>
          {backgroundRoute ? <Screen route={backgroundRoute} onOpenSettings={openSettings} /> : null}
        </Suspense>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          dark={dark}
          onToggleTheme={onToggleDark}
          onOpenSettings={() => openSettings()}
        />
        <Dialog open={route.name === "settings"} onClose={closeSettings} label="Settings" className="sm:max-w-5xl" showClose>
          {route.name === "settings" ? (
            <Suspense fallback={<RouteLoading label="Loading Settings..." />}>
              <SettingsScreen dark={dark} onToggleDark={onToggleDark} initialSection={settingsSection} />
            </Suspense>
          ) : null}
        </Dialog>
      </RouteErrorBoundary>
    </Shell>
  );
}
