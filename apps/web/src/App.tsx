import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Shell } from "./components/Shell.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Button, Dialog, Loading } from "./components/ui/index.ts";
import { useToast } from "./components/Toast.tsx";
import { useRoute, navigate, replace, routeToPath, type Route } from "./router.tsx";
import { useApi } from "./lib/api-context.tsx";
import type { ApiClient, DesignCanvasAssetImportItem, Project, Settings } from "./lib/api.ts";
import type { DesignProjectBootstrapInput } from "./design-canvas/types.ts";
import { type DesignProjectAttachments } from "./lib/design-attachments.ts";
import { createDesignCanvasApi } from "./lib/design-canvas-api.ts";
import { revealDesignExport } from "./lib/design-export.ts";
import { native } from "./lib/native.ts";
import { useAgents } from "./lib/agents-context.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";

const DesignCanvasScreen = lazy(() =>
  import("./design-canvas/index.ts").then((module) => ({ default: module.DesignCanvasScreen })),
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

function DesignProjectScreen({
  projectId,
  api,
  onOpenSettings,
}: {
  projectId: string;
  api: ApiClient;
  onOpenSettings: (section?: string) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [agentDefaults, setAgentDefaults] = useState<Pick<Settings, "agentCommand" | "model"> | null>(null);
  const agentDefaultsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestAgentDefaultsRef = useRef<Pick<Settings, "agentCommand" | "model"> | null>(null);
  const canvasApi = useMemo(() => createDesignCanvasApi(api), [api]);
  const { agents, rescan: rescanAgents } = useAgents();

  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.getProject(projectId), api.getSettings()]).then(([projectResult, settingsResult]) => {
      if (!active) return;
      if (projectResult.status === "fulfilled") setProject(projectResult.value);
      if (settingsResult.status === "fulfilled" && latestAgentDefaultsRef.current === null) {
        const defaults = {
          agentCommand: settingsResult.value.agentCommand,
          model: settingsResult.value.model,
        };
        latestAgentDefaultsRef.current = defaults;
        setAgentDefaults(defaults);
      }
    });
    return () => {
      active = false;
    };
  }, [api, projectId]);

  const revealExport = useCallback((exportId: string) => revealDesignExport({
    projectPath: project?.projectPath,
    exportId,
    openPath: native?.openPath,
    writeClipboard: typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? (value) => navigator.clipboard.writeText(value)
      : undefined,
  }), [project?.projectPath]);

  const renameProject = useCallback(async (name: string) => {
    const updated = await api.patchProject(projectId, { name });
    setProject(updated);
    window.dispatchEvent(new CustomEvent("dezin:project-title", { detail: updated }));
  }, [api, projectId]);

  const persistAgentDefaults = useCallback((selection: { agentCommand: string; model: string }) => {
    latestAgentDefaultsRef.current = selection;
    setAgentDefaults(selection);
    const save = agentDefaultsSaveQueueRef.current.catch(() => undefined).then(async () => {
      const updated = await api.updateSettings({
        agentCommand: selection.agentCommand,
        model: selection.model,
      });
      if (latestAgentDefaultsRef.current?.agentCommand === selection.agentCommand
        && latestAgentDefaultsRef.current.model === selection.model) {
        setAgentDefaults({ agentCommand: updated.agentCommand, model: updated.model });
      }
    });
    agentDefaultsSaveQueueRef.current = save;
    return save;
  }, [api]);

  return (
    <DesignCanvasScreen
      key={projectId}
      projectId={projectId}
      projectName={project?.name ?? "Untitled"}
      api={canvasApi}
      agents={agents}
      initialAgentCommand={agentDefaults?.agentCommand}
      initialModel={agentDefaults?.model}
      onAgentDefaultsChange={persistAgentDefaults}
      onRescanAgents={rescanAgents}
      onBackHome={() => navigate("/")}
      onRenameProject={renameProject}
      onOpenSettings={onOpenSettings}
      projectPath={project?.projectPath}
      onRevealExport={revealExport}
    />
  );
}

function briefToName(brief: string): string {
  const t = brief.trim().replace(/\s+/g, " ");
  return t.length === 0 ? "Untitled" : t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function stagedAttachmentTitle(value: string, fallback: string): string {
  return value.trim().slice(0, 256) || fallback;
}

export function designCanvasAttachmentItems(
  attachments: DesignProjectAttachments | undefined,
): DesignCanvasAssetImportItem[] {
  const items: DesignCanvasAssetImportItem[] = [];
  for (const [index, image] of (attachments?.images ?? []).entries()) {
    const title = stagedAttachmentTitle(image.name, `Image ${index + 1}`);
    items.push({
      asset: {
        name: title,
        mimeType: image.mimeType ?? (image.base64.startsWith("iVBOR") ? "image/png" : "image/jpeg"),
        base64: image.base64,
      },
      binding: {
        type: "create-node",
        node: {
          id: `node-home-image-${index + 1}`,
          kind: "image",
          name: title,
          geometry: { x: 100 + index * 390, y: 100, width: 360, height: 260 },
        },
      },
    });
  }
  for (const [index, ref] of (attachments?.refs ?? []).entries()) {
    const itemIndex = (attachments?.images.length ?? 0) + index;
    const title = stagedAttachmentTitle(ref.name, `Reference ${index + 1}`);
    if (ref.projectReference !== undefined) {
      items.push({
        asset: {
          name: `${title}.html`,
          mimeType: "text/html",
          sourceVersion: {
            projectId: ref.projectReference.sourceProjectId,
            nodeId: ref.projectReference.sourceNodeId,
            versionId: ref.projectReference.sourceVersionId,
          },
        },
        binding: {
          type: "create-node",
          node: {
            id: `node-home-reference-${index + 1}`,
            kind: "document",
            name: title,
            geometry: { x: 100 + (itemIndex % 3) * 390, y: 100 + Math.floor(itemIndex / 3) * 320, width: 360, height: 260 },
          },
        },
      });
      continue;
    }
    items.push({
      asset: { name: `${title}.html`, mimeType: "text/html", base64: ref.base64 },
      binding: {
        type: "create-node",
        node: {
          id: `node-home-reference-${index + 1}`,
          kind: "document",
          name: title,
          geometry: { x: 100 + (itemIndex % 3) * 390, y: 100 + Math.floor(itemIndex / 3) * 320, width: 360, height: 260 },
        },
      },
    });
  }
  return items;
}

type HomeBootstrapRequest = Omit<DesignProjectBootstrapInput, "idempotencyKey">;

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure hashing is unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Bytes(base64: string): Promise<string> {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return sha256(bytes);
}

export async function homeBootstrapFingerprint(request: HomeBootstrapRequest): Promise<string> {
  const items: unknown[] = [];
  for (const item of request.items) {
    items.push({
      asset: "base64" in item.asset && item.asset.base64 !== undefined
        ? {
            name: item.asset.name,
            mimeType: item.asset.mimeType,
            sha256: await sha256Base64Bytes(item.asset.base64),
          }
        : {
            name: item.asset.name,
            mimeType: item.asset.mimeType,
            sourceVersion: item.asset.sourceVersion,
          },
      binding: item.binding,
    });
  }
  const descriptor = new TextEncoder().encode(JSON.stringify({
    schemaVersion: request.schemaVersion,
    name: request.name,
    prompt: request.prompt,
    items,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  }));
  return `sha256:${await sha256(descriptor)}`;
}

function Screen({ route, onOpenSettings }: { route: Route; onOpenSettings: (section?: string) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const homeBootstrapKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  switch (route.name) {
    case "project":
    case "project-canvas":
      return <DesignProjectScreen key={route.id} projectId={route.id} api={api} onOpenSettings={onOpenSettings} />;
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
          onNewProject={async (brief, sharingan, agentSelection, attachments) => {
            try {
              if (sharingan) {
                const project = await api.createProject({
                  name: briefToName(brief),
                  sharingan: true,
                  sourceUrl: sharingan.sourceUrl,
                });
                navigate(`/projects/${project.id}`);
                return;
              }
              const importItems = designCanvasAttachmentItems(attachments);
              const request = {
                schemaVersion: 1 as const,
                name: briefToName(brief),
                prompt: brief,
                items: importItems,
                ...(agentSelection?.agentCommand ? {
                  agent: {
                    agentCommand: agentSelection.agentCommand,
                    ...(agentSelection.model ? { model: agentSelection.model } : {}),
                  },
                } : {}),
              };
              const fingerprint = await homeBootstrapFingerprint(request);
              if (homeBootstrapKeyRef.current?.fingerprint !== fingerprint) {
                homeBootstrapKeyRef.current = {
                  fingerprint,
                  key: typeof globalThis.crypto?.randomUUID === "function"
                    ? `home-${globalThis.crypto.randomUUID()}`
                    : `home-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                };
              }
              const bootstrapKey = homeBootstrapKeyRef.current.key;
              const { project } = await api.bootstrapDesignProject({
                ...request,
                idempotencyKey: bootstrapKey,
              });
              if (homeBootstrapKeyRef.current?.key === bootstrapKey) homeBootstrapKeyRef.current = null;
              if (brief.trim()) {
                void api
                  .generateProjectTitle(project.id, brief)
                  .then((updated) => window.dispatchEvent(new CustomEvent("dezin:project-title", { detail: updated })))
                  .catch(() => {});
              }
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
  if (route.name === "project" || route.name === "project-canvas") {
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
