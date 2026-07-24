import { useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useMediaQuery } from "../hooks/useMediaQuery.ts";
import {
  readPanelPercent,
  RESIZE_SEPARATOR_CLASS,
  savePanelFraction,
  twoPanelLayout,
} from "../lib/panel-layout.ts";

const PROJECT_STUDIO_AGENT_WIDTH_KEY = "dezin.project-studio.agent.width";
const PROJECT_STUDIO_AGENT_PANEL = "workspace-agent";
const PROJECT_STUDIO_CONTENT_PANEL = "studio-content";

export function ProjectStudioShell({
  agent,
  main,
  inspector,
  inspectorOpen = false,
  inspectorLabel = "Inspector",
  inspectorToggleLabel = "inspector",
  agentLabel = "Workspace Agent",
  presentation = false,
}: {
  agent: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
  inspectorOpen?: boolean;
  inspectorLabel?: string;
  inspectorToggleLabel?: string;
  agentLabel?: string;
  presentation?: boolean;
}) {
  const [narrowInspectorOpen, setNarrowInspectorOpen] = useState(inspectorOpen);
  const mobile = useMediaQuery("(max-width: 639px)");
  const showInspectorRef = useRef<HTMLButtonElement>(null);
  const hideInspectorRef = useRef<HTMLButtonElement>(null);
  const wasNarrowReachableRef = useRef(false);
  const agentPercent = readPanelPercent(PROJECT_STUDIO_AGENT_WIDTH_KEY, 20, 12, 34);

  useEffect(() => {
    setNarrowInspectorOpen(inspectorOpen);
  }, [inspectorOpen]);

  const narrowReachable = inspectorOpen && narrowInspectorOpen;

  useEffect(() => {
    if (narrowReachable && !wasNarrowReachableRef.current) {
      hideInspectorRef.current?.focus();
    } else if (!narrowReachable && wasNarrowReachableRef.current && inspectorOpen) {
      showInspectorRef.current?.focus();
    }
    wasNarrowReachableRef.current = narrowReachable;
  }, [inspectorOpen, narrowReachable]);

  const agentPanel = (
    <aside
      aria-label={agentLabel}
      inert={presentation ? true : undefined}
      hidden={presentation}
      className={`h-full min-h-0 min-w-0 overflow-hidden bg-sidebar/50 ${mobile ? "border-b border-border" : ""}`}
    >
      {agent}
    </aside>
  );

  const studioContent = (
    <div
      data-testid="project-studio-content"
      className={`relative grid h-full min-h-0 min-w-0 grid-cols-1 overflow-hidden ${inspectorOpen && !presentation
        ? "xl:grid-cols-[minmax(640px,1fr)_minmax(224px,18vw)]"
        : ""}`}
    >
      <section aria-label="Studio surface" className="min-h-0 min-w-0 overflow-hidden bg-background">{main}</section>
      {inspectorOpen && !presentation && !narrowReachable ? (
        <button
          ref={showInspectorRef}
          type="button"
          className="absolute bottom-3 right-3 z-30 border border-border bg-sidebar px-2.5 py-1.5 text-[11px] font-medium text-foreground shadow-sm xl:hidden"
          aria-controls="project-studio-inspector"
          aria-expanded="false"
          aria-label={`Show ${inspectorToggleLabel}`}
          inert={presentation ? true : undefined}
          onClick={() => setNarrowInspectorOpen(true)}
        >
          Open {inspectorToggleLabel}
        </button>
      ) : null}
      {inspectorOpen ? (
        <aside
          id="project-studio-inspector"
          aria-label={inspectorLabel}
          inert={presentation ? true : undefined}
          hidden={presentation}
          data-narrow-reachable={narrowReachable || undefined}
          className={narrowReachable
            ? "absolute inset-x-2 bottom-2 z-30 max-h-[min(70%,640px)] min-h-0 min-w-0 overflow-hidden border border-border bg-sidebar shadow-lg sm:left-auto sm:right-2 sm:w-[320px] xl:static xl:block xl:max-h-none xl:w-auto xl:border-y-0 xl:border-r-0 xl:shadow-none"
            : "hidden min-h-0 min-w-0 overflow-hidden border-l border-border bg-sidebar/35 xl:block"}
        >
          {narrowReachable ? (
            <button
              ref={hideInspectorRef}
              type="button"
              className="absolute right-2 top-2 z-10 border border-border bg-sidebar px-1.5 py-1 text-[10px] text-muted-foreground shadow-sm xl:hidden"
              aria-controls="project-studio-inspector"
              aria-expanded="true"
              aria-label={`Hide ${inspectorToggleLabel}`}
              onClick={() => setNarrowInspectorOpen(false)}
            >
              Hide
            </button>
          ) : null}
          {inspector}
        </aside>
      ) : null}
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
          onLayoutChanged={(layout) => {
            savePanelFraction(PROJECT_STUDIO_AGENT_WIDTH_KEY, layout, PROJECT_STUDIO_AGENT_PANEL);
          }}
          resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
        >
          <Panel
            id={PROJECT_STUDIO_AGENT_PANEL}
            minSize="220px"
            maxSize="420px"
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
