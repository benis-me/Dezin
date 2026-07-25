import { useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
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
const PROJECT_STUDIO_AGENT_PANEL = "workspace-agent";
const PROJECT_STUDIO_CONTENT_PANEL = "studio-content";

export function ProjectStudioShell({
  agent,
  main,
  inspector,
  inspectorOpen = false,
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
  inspectorLabel?: string;
  inspectorToggleLabel?: string;
  narrowInspectorContentOwnsClose?: boolean;
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
      className={`h-full min-h-0 min-w-0 overflow-hidden bg-sidebar ${mobile ? "border-b border-border" : ""}`}
    >
      {agent}
    </aside>
  );

  const studioContent = (
    <div
      data-testid="project-studio-content"
      className={`relative grid h-full min-h-0 min-w-0 grid-cols-1 overflow-hidden ${inspectorOpen && !presentation
        ? "xl:grid-cols-[minmax(640px,1fr)_minmax(288px,20vw)]"
        : ""}`}
    >
      <section aria-label="Studio surface" className="min-h-0 min-w-0 overflow-hidden bg-background">{main}</section>
      {inspectorOpen && !presentation && !narrowReachable && !narrowInspectorContentOwnsClose ? (
        <IconButton
          ref={showInspectorRef}
          type="button"
          className="absolute right-0 top-1/2 z-30 -translate-y-1/2 rounded-r-none border-r-0 bg-background xl:hidden"
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
      {inspectorOpen ? (
        <aside
          id="project-studio-inspector"
          aria-label={inspectorLabel}
          inert={presentation ? true : undefined}
          hidden={presentation}
          data-narrow-reachable={narrowReachable || undefined}
          className={narrowReachable
            ? "absolute inset-y-0 right-0 z-30 min-h-0 w-[min(360px,100%)] min-w-0 overflow-hidden border-l border-border bg-background xl:static xl:block xl:w-auto"
            : "hidden min-h-0 min-w-0 overflow-hidden border-l border-border bg-background xl:block"}
        >
          {narrowReachable && !narrowInspectorContentOwnsClose ? (
            <IconButton
              ref={hideInspectorRef}
              type="button"
              className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-l-none border-l-0 bg-background xl:hidden"
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
