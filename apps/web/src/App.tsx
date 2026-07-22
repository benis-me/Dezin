import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Shell } from "./components/Shell.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Button, Dialog, Loading } from "./components/ui/index.ts";
import { useToast } from "./components/Toast.tsx";
import { useRoute, navigate, replace, routeToPath, type Route } from "./router.tsx";
import { useApi } from "./lib/api-context.tsx";
import { setPendingBrief } from "./lib/pending-brief.ts";
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
    case "project-resource":
    case "project-resource-revision":
      // key by projectId: switching projects must give a FRESH instance (full state reset), not reuse
      // one component whose refs (activeConv, abortRef, running/queue) leak from the previous project.
      return (
        <ProjectStudioScreen
          key={route.id}
          projectId={route.id}
          artifactId={route.name === "project-artifact" || route.name === "project-artifact-revision"
            ? route.artifactId
            : null}
          artifactRevisionId={route.name === "project-artifact-revision" ? route.revisionId : null}
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
          onNewProject={async (brief, skillId, designSystemId, mode, sharingan) => {
            try {
              const project = await api.createProject({
                name: briefToName(brief),
                skillId,
                designSystemId: sharingan ? null : designSystemId,
                mode,
                sharingan: !!sharingan,
                sourceUrl: sharingan?.sourceUrl,
              });
              setPendingBrief(brief);
              void api
                .generateProjectTitle(project.id, brief)
                .then((updated) => window.dispatchEvent(new CustomEvent("dezin:project-title", { detail: updated })))
                .catch(() => {});
              navigate(`/projects/${project.id}`);
            } catch {
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
    || route.name === "project-artifact-revision" || route.name === "project-resource"
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
