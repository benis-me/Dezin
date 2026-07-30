import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef, usePanelRef } from "react-resizable-panels";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton } from "../components/ui/index.ts";
import { useMediaQuery } from "../hooks/useMediaQuery.ts";
import {
  readPanelPercent,
  RESIZE_SEPARATOR_CLASS,
  savePanelFraction,
  twoPanelLayout,
} from "../lib/panel-layout.ts";

const PROJECT_STUDIO_AGENT_WIDTH_KEY = "dezin.project-studio.agent.width";
const PROJECT_STUDIO_INSPECTOR_WIDTH_KEY = "dezin.project-studio.inspector.width";
const PROJECT_STUDIO_AGENT_PANEL = "workspace-agent";
const PROJECT_STUDIO_CONTENT_PANEL = "studio-content";
const PROJECT_STUDIO_SURFACE_PANEL = "studio-surface-panel";
const PROJECT_STUDIO_INSPECTOR_PANEL = "studio-inspector";

export function ProjectStudioShell({
  agent,
  main,
  inspector,
  inspectorOpen = false,
  inspectorAvailable = inspectorOpen,
  inspectorLabel = "Inspector",
  inspectorToggleLabel = "inspector",
  narrowInspectorContentOwnsClose = false,
  agentLabel = "Workspace Agent",
  presentation = false,
}: {
  agent: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
  inspectorOpen?: boolean;
  inspectorAvailable?: boolean;
  inspectorLabel?: string;
  inspectorToggleLabel?: string;
  narrowInspectorContentOwnsClose?: boolean;
  agentLabel?: string;
  presentation?: boolean;
}) {
  const [narrowInspectorOpen, setNarrowInspectorOpen] = useState(inspectorOpen);
  const mobile = useMediaQuery("(max-width: 639px)");
  const wideDesktop = useMediaQuery("(min-width: 1280px)");
  const inspectorGroupRef = useGroupRef();
  const inspectorPanelRef = usePanelRef();
  const showInspectorRef = useRef<HTMLButtonElement>(null);
  const hideInspectorRef = useRef<HTMLButtonElement>(null);
  const wasNarrowReachableRef = useRef(false);
  const inspectorEverAvailableRef = useRef(inspectorAvailable);
  if (inspectorAvailable) inspectorEverAvailableRef.current = true;
  const agentPercent = readPanelPercent(PROJECT_STUDIO_AGENT_WIDTH_KEY, 20, 12, 34);
  const inspectorPercent = readPanelPercent(PROJECT_STUDIO_INSPECTOR_WIDTH_KEY, 22, 17, 34);
  const inspectorMounted = inspectorEverAvailableRef.current;
  const wideInspectorMounted = wideDesktop && inspectorMounted;
  const wideInspectorActive = wideDesktop && inspectorOpen && !presentation;
  const inspectorLayout = useMemo(
    () => (
      wideInspectorMounted && wideInspectorActive
        ? twoPanelLayout(
            PROJECT_STUDIO_SURFACE_PANEL,
            100 - inspectorPercent,
            PROJECT_STUDIO_INSPECTOR_PANEL,
          )
        : wideInspectorMounted
          ? {
              [PROJECT_STUDIO_SURFACE_PANEL]: 100,
              [PROJECT_STUDIO_INSPECTOR_PANEL]: 0,
            }
          : { [PROJECT_STUDIO_SURFACE_PANEL]: 100 }
    ),
    [inspectorPercent, wideInspectorActive, wideInspectorMounted],
  );

  useEffect(() => {
    setNarrowInspectorOpen(inspectorOpen);
  }, [inspectorOpen]);

  const narrowInspectorEligible = inspectorOpen && narrowInspectorOpen && !wideDesktop;
  const narrowReachable = narrowInspectorEligible && !presentation;

  useLayoutEffect(() => {
    inspectorGroupRef.current?.setLayout(inspectorLayout);
    if (!wideInspectorMounted) return;
    if (wideInspectorActive) inspectorPanelRef.current?.expand();
    else inspectorPanelRef.current?.collapse();
  }, [inspectorGroupRef, inspectorLayout, inspectorPanelRef, wideInspectorActive, wideInspectorMounted]);

  useEffect(() => {
    if (presentation) {
      wasNarrowReachableRef.current = narrowInspectorEligible;
      return;
    }
    if (narrowReachable && !wasNarrowReachableRef.current) {
      hideInspectorRef.current?.focus();
    } else if (!narrowReachable && wasNarrowReachableRef.current && inspectorOpen) {
      showInspectorRef.current?.focus();
    }
    wasNarrowReachableRef.current = narrowReachable;
  }, [inspectorOpen, narrowInspectorEligible, narrowReachable, presentation]);

  const agentPanel = (
    <aside
      aria-label={agentLabel}
      inert={presentation ? true : undefined}
      hidden={presentation}
      className={`h-full min-h-0 min-w-0 overflow-hidden bg-sidebar ${mobile ? "border-b border-border" : ""}`}
    >
      {agent}
    </aside>
  );

  const inspectorAside = (narrow: boolean, concealed = false) => (
    <aside
      id="project-studio-inspector"
      aria-label={inspectorLabel}
      inert={presentation || concealed ? true : undefined}
      hidden={presentation || concealed}
      data-narrow-reachable={narrow || undefined}
      className={narrow
        ? "absolute inset-y-0 right-0 z-30 h-full min-h-0 w-[min(320px,100%)] max-w-[320px] overflow-hidden border-l border-border bg-background"
        : "h-full min-h-0 min-w-0 overflow-hidden bg-background"}
    >
      {narrow && !narrowInspectorContentOwnsClose ? (
        <IconButton
          ref={hideInspectorRef}
          type="button"
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-l-none border-l-0 bg-background"
          aria-controls="project-studio-inspector"
          aria-expanded="true"
          aria-label={`Hide ${inspectorToggleLabel}`}
          title={`Hide ${inspectorToggleLabel}`}
          onClick={() => setNarrowInspectorOpen(false)}
        >
          <PanelRightClose aria-hidden className="size-3.5" />
        </IconButton>
      ) : null}
      {inspector}
    </aside>
  );

  const studioContent = (
    <div
      data-testid="project-studio-content"
      className="relative h-full min-h-0 min-w-0 overflow-hidden"
    >
      {inspectorOpen && !presentation && !wideDesktop && !narrowReachable && !narrowInspectorContentOwnsClose ? (
        <IconButton
          ref={showInspectorRef}
          type="button"
          className="absolute right-0 top-1/2 z-30 -translate-y-1/2 rounded-r-none border-r-0 bg-background"
          aria-controls="project-studio-inspector"
          aria-expanded="false"
          aria-label={`Show ${inspectorToggleLabel}`}
          title={`Show ${inspectorToggleLabel}`}
          inert={presentation ? true : undefined}
          onClick={() => setNarrowInspectorOpen(true)}
        >
          <PanelRightOpen aria-hidden className="size-3.5" />
        </IconButton>
      ) : null}
      <Group
        id="dezin-project-studio-inspector-layout"
        groupRef={inspectorGroupRef}
        className="h-full min-w-0"
        defaultLayout={inspectorLayout}
        onLayoutChanged={(layout, meta) => {
          if (wideInspectorActive && meta.isUserInteraction) {
            if ((layout[PROJECT_STUDIO_INSPECTOR_PANEL] ?? 0) <= 0) {
              inspectorPanelRef.current?.expand();
              return;
            }
            savePanelFraction(
              PROJECT_STUDIO_INSPECTOR_WIDTH_KEY,
              layout,
              PROJECT_STUDIO_INSPECTOR_PANEL,
            );
          }
        }}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        <Panel
          id={PROJECT_STUDIO_SURFACE_PANEL}
          minSize={wideDesktop ? "640px" : "0px"}
          style={{ overflow: "hidden" }}
        >
          <section aria-label="Studio surface" className="h-full min-h-0 min-w-0 overflow-hidden bg-background">
            {main}
          </section>
        </Panel>
        {wideDesktop && inspectorOpen && !presentation ? (
          <Separator
            id="studio-inspector-resize"
            aria-label="Resize Inspector"
            className={RESIZE_SEPARATOR_CLASS}
          />
        ) : null}
        {wideInspectorMounted ? (
          <Panel
            id={PROJECT_STUDIO_INSPECTOR_PANEL}
            minSize="272px"
            maxSize="360px"
            collapsible
            collapsedSize="0px"
            panelRef={inspectorPanelRef}
            groupResizeBehavior="preserve-pixel-size"
            aria-hidden={!wideInspectorActive}
            style={{ overflow: "hidden" }}
          >
            {inspectorAside(false, !wideInspectorActive)}
          </Panel>
        ) : null}
      </Group>
      {inspectorMounted && !wideDesktop ? inspectorAside(true, !narrowReachable) : null}
    </div>
  );

  return (
    <div
      data-testid="project-studio-shell"
      data-inspector-layout={inspectorOpen ? "open" : "closed"}
      data-studio-layout={mobile ? "mobile" : "desktop"}
      data-presentation={presentation || undefined}
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background text-foreground"
    >
      {mobile ? (
        <div className={`grid h-full min-h-0 grid-cols-1 ${presentation
          ? "grid-rows-1"
          : "grid-rows-[minmax(156px,36%)_minmax(0,1fr)]"}`}>
          {agentPanel}
          {studioContent}
        </div>
      ) : (
        <Group
          id="dezin-project-studio-layout"
          className="h-full min-w-0"
          defaultLayout={twoPanelLayout(
            PROJECT_STUDIO_AGENT_PANEL,
            agentPercent,
            PROJECT_STUDIO_CONTENT_PANEL,
          )}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) {
              savePanelFraction(PROJECT_STUDIO_AGENT_WIDTH_KEY, layout, PROJECT_STUDIO_AGENT_PANEL);
            }
          }}
          resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
        >
          <Panel
            id={PROJECT_STUDIO_AGENT_PANEL}
            minSize="236px"
            maxSize="380px"
            groupResizeBehavior="preserve-pixel-size"
            hidden={presentation}
            style={{ overflow: "hidden" }}
          >
            {agentPanel}
          </Panel>
          {presentation ? null : (
            <Separator
              aria-label="Resize Workspace Agent"
              className={RESIZE_SEPARATOR_CLASS}
            />
          )}
          <Panel id={PROJECT_STUDIO_CONTENT_PANEL} minSize="420px" style={{ overflow: "hidden" }}>
            {studioContent}
          </Panel>
        </Group>
      )}
    </div>
  );
}
