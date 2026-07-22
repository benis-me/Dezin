import { useEffect, useRef, useState, type ReactNode } from "react";

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
  const showInspectorRef = useRef<HTMLButtonElement>(null);
  const hideInspectorRef = useRef<HTMLButtonElement>(null);
  const wasNarrowReachableRef = useRef(false);

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

  return (
    <div
      data-testid="project-studio-shell"
      data-inspector-layout={inspectorOpen ? "open" : "closed"}
      className={`relative grid h-full min-h-0 w-full min-w-0 grid-cols-1 grid-rows-[minmax(156px,36%)_minmax(0,1fr)] overflow-hidden bg-background text-foreground sm:grid-cols-[240px_minmax(0,1fr)] sm:grid-rows-1 ${inspectorOpen
        ? "xl:grid-cols-[272px_minmax(640px,1fr)_minmax(224px,18vw)]"
        : "xl:grid-cols-[272px_minmax(0,1fr)]"}`}
    >
      <aside
        aria-label={agentLabel}
        inert={presentation ? true : undefined}
        className="min-h-0 min-w-0 overflow-hidden border-b border-border bg-sidebar/50 sm:border-b-0 sm:border-r"
      >
        {agent}
      </aside>
      <section aria-label="Studio surface" className="min-h-0 min-w-0 overflow-hidden bg-background">{main}</section>
      {inspectorOpen && !narrowReachable ? (
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
          data-narrow-reachable={narrowReachable || undefined}
          className={narrowReachable
            ? "absolute inset-x-2 bottom-2 z-30 max-h-[min(70%,640px)] min-h-0 min-w-0 overflow-auto border border-border bg-sidebar shadow-lg sm:left-auto sm:right-2 sm:w-[320px] xl:static xl:block xl:max-h-none xl:w-auto xl:overflow-hidden xl:border-y-0 xl:border-r-0 xl:shadow-none"
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
}
