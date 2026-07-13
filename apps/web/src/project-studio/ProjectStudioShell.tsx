import type { ReactNode } from "react";

export function ProjectStudioShell({
  agent,
  main,
  inspector,
}: {
  agent: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
}) {
  return (
    <div
      data-testid="project-studio-shell"
      className="grid h-full min-h-0 w-full min-w-0 grid-cols-1 grid-rows-[minmax(156px,36%)_minmax(0,1fr)] overflow-hidden bg-background text-foreground sm:grid-cols-[240px_minmax(0,1fr)] sm:grid-rows-1 xl:grid-cols-[272px_minmax(0,1fr)_248px]"
    >
      <aside aria-label="Workspace Agent" className="min-h-0 min-w-0 overflow-hidden border-b border-border bg-sidebar/50 sm:border-b-0 sm:border-r">
        {agent}
      </aside>
      <section aria-label="Studio surface" className="min-h-0 min-w-0 overflow-hidden bg-background">{main}</section>
      <aside aria-label="Inspector" className="hidden min-h-0 min-w-0 overflow-hidden border-l border-border bg-sidebar/35 xl:block">
        {inspector}
      </aside>
    </div>
  );
}
