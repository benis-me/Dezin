import { lazy, Suspense, useEffect, useState } from "react";
import { Shell } from "./components/Shell.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Dialog, Loading } from "./components/ui/index.ts";
import { useToast } from "./components/Toast.tsx";
import { useRoute, navigate, type Route } from "./router.tsx";
import { useApi } from "./lib/api-context.tsx";
import { setPendingBrief } from "./lib/pending-brief.ts";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.tsx";
import { DesignSystemsScreen } from "./screens/DesignSystemsScreen.tsx";
import { DesignSystemDetailScreen } from "./screens/DesignSystemDetailScreen.tsx";
import { DesignSystemNewScreen } from "./screens/DesignSystemNewScreen.tsx";
import { EffectsScreen } from "./screens/EffectsScreen.tsx";
import { EffectScreen } from "./screens/EffectScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { OnboardingScreen } from "./screens/OnboardingScreen.tsx";
import { MoodboardsScreen } from "./screens/MoodboardsScreen.tsx";

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
      // key by projectId: switching projects must give a FRESH instance (full state reset), not reuse
      // one component whose refs (activeConv, abortRef, running/queue) leak from the previous project.
      return <WorkspaceScreen key={route.id} projectId={route.id} onOpenSettings={onOpenSettings} />;
    case "moodboards":
      return <MoodboardsScreen onOpenBoard={(id) => navigate(`/moodboards/${id}`)} />;
    case "moodboard":
      return (
        <Suspense fallback={<RouteLoading label="Loading moodboard..." />}>
          <MoodboardScreen boardId={route.id} onBack={() => navigate("/moodboards")} onOpenSettings={onOpenSettings} />
        </Suspense>
      );
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
    case "home":
    default:
      return (
        <HomeScreen
          onNewProject={async (brief, skillId, designSystemId, mode, sharingan) => {
            try {
              const project = await api.createProject({
                name: briefToName(brief),
                skillId,
                designSystemId,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const openSettings = (section?: string) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };
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
        setSettingsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!onboarded) {
    return (
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
    );
  }

  return (
    <Shell dark={dark} onToggleDark={onToggleDark} onOpenSettings={openSettings}>
      <Screen route={route} onOpenSettings={openSettings} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        dark={dark}
        onToggleTheme={onToggleDark}
        onOpenSettings={() => openSettings()}
      />
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} label="Settings" className="sm:max-w-5xl" showClose>
        <SettingsScreen dark={dark} onToggleDark={onToggleDark} initialSection={settingsSection} />
      </Dialog>
    </Shell>
  );
}
