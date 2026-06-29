import { type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { LayoutGrid, Moon, Shapes, Settings, Sun, type LucideIcon } from "lucide-react";
import { useRoute, navigate, type Route } from "../router.tsx";
import { cn } from "../lib/utils.ts";
import { native } from "../lib/native.ts";
import { readPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";
import { IconButton } from "./ui/index.ts";

interface NavLink {
  label: string;
  path: string;
  icon: LucideIcon;
  match: (r: Route) => boolean;
}

const NAV: NavLink[] = [
  { label: "Home", path: "/", icon: LayoutGrid, match: (r) => r.name === "home" },
  { label: "Design systems", path: "/design-systems", icon: Shapes, match: (r) => r.name === "design-systems" },
];

const SHELL_SIDEBAR_WIDTH_KEY = "dezin.shell.sidebar.width";
const SHELL_SIDEBAR_PANEL = "sidebar";
const SHELL_CONTENT_PANEL = "content";

/**
 * App shell — a tool layout: a slim left sidebar (nav + controls) beside the main
 * content. Inside a project the sidebar is hidden so the workspace is full-bleed.
 */
export function Shell({
  children,
  dark,
  onToggleDark,
  onOpenSettings,
}: {
  children: ReactNode;
  dark: boolean;
  onToggleDark: () => void;
  onOpenSettings: (section?: string) => void;
}) {
  const route = useRoute();
  const inProject = route.name === "project";
  const sidebarPercent = readPanelPercent(SHELL_SIDEBAR_WIDTH_KEY, 18, 12, 28);

  return (
    <div className="h-screen bg-background text-foreground">
      {!inProject ? (
        <Group
          id="dezin-shell-layout"
          className="h-full"
          defaultLayout={twoPanelLayout(SHELL_SIDEBAR_PANEL, sidebarPercent, SHELL_CONTENT_PANEL)}
          onLayoutChanged={(layout) => savePanelFraction(SHELL_SIDEBAR_WIDTH_KEY, layout, SHELL_SIDEBAR_PANEL)}
          resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
        >
          <Panel id={SHELL_SIDEBAR_PANEL} minSize="176px" maxSize="320px" groupResizeBehavior="preserve-pixel-size">
            <aside className="app-drag titlebar-pad-top flex h-full min-w-0 flex-col bg-sidebar">
              <div className="flex items-center justify-between gap-2 px-3.5 py-3.5">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="app-no-drag rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className="font-brand text-[19px] text-foreground transition-opacity hover:opacity-70">Dezin</span>
                </button>
                <IconButton
                  aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
                  title={dark ? "Light mode" : "Dark mode"}
                  onClick={onToggleDark}
                  className="app-no-drag"
                >
                  {dark ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
                </IconButton>
              </div>

              <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5 px-2.5">
                {NAV.map((link) => {
                  const active = link.match(route);
                  const Icon = link.icon;
                  return (
                    <button
                      key={link.path}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => navigate(link.path)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                        active
                          ? "bg-background text-foreground ring-1 ring-border"
                          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                      )}
                    >
                      <Icon size={16} strokeWidth={1.75} className={active ? "text-primary" : ""} />
                      {link.label}
                    </button>
                  );
                })}
              </nav>

              <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2.5">
                <button
                  type="button"
                  onClick={() => onOpenSettings()}
                  aria-label="Settings"
                  className="app-no-drag flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                >
                  <Settings size={16} strokeWidth={1.75} />
                  Settings
                </button>
              </div>
            </aside>
          </Panel>
          <Separator aria-label="Resize app sidebar" className={RESIZE_SEPARATOR_CLASS} />
          <Panel id={SHELL_CONTENT_PANEL} minSize="520px">
            <main className="relative h-full overflow-hidden">
              {/* Draggable title strip over the content top (screens without their own top bar). */}
              {native?.isElectron && (route.name === "home" || route.name === "design-systems") ? (
                <div className="app-drag absolute inset-x-0 top-0 z-30 h-8" aria-hidden />
              ) : null}
              {children}
            </main>
          </Panel>
        </Group>
      ) : (
        <main className="relative flex h-full overflow-hidden">{children}</main>
      )}
    </div>
  );
}
