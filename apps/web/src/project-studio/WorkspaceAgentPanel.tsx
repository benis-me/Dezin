import type { WorkspaceDesignNodeLocator } from "../lib/api.ts";

export interface WorkspaceAgentContextItem {
  id: string;
  label: string;
  kind: string;
  projectId?: string;
  artifactId?: string;
  revisionId?: string;
  targetKey?: string;
  assemblyHash?: string;
  frameId?: string;
  locator?: WorkspaceDesignNodeLocator;
}

export function WorkspaceAgentPanel({
  draft,
  onDraftChange,
  contextLabel,
  contextItems = [],
  title = "Workspace Agent",
  draftLabel = "Workspace Agent draft",
  placeholder = "Plan a page, component, or workspace change…",
  scopeLabel = "Workspace",
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  contextLabel: string;
  contextItems?: WorkspaceAgentContextItem[];
  title?: string;
  draftLabel?: string;
  placeholder?: string;
  scopeLabel?: string;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="workspace-agent-title">
      <header className="app-drag titlebar-pad-left flex h-11 shrink-0 items-center border-b border-border px-3.5">
        <div className="min-w-0">
          <h2 id="workspace-agent-title" className="truncate text-xs font-medium tracking-[-0.01em] text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{contextLabel}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1" />
      {contextItems.length > 0 ? (
        <section aria-label="Selected Agent Context" className="shrink-0 border-t border-border px-2.5 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>Selected Context</span>
            <span>{contextItems.length}</span>
          </div>
          <ul className="space-y-1">
            {contextItems.map((item) => (
              <li
                key={item.id}
                data-context-project-id={item.projectId}
                data-context-artifact-id={item.artifactId}
                data-context-revision-id={item.revisionId}
                data-context-target-key={item.targetKey}
                data-context-assembly-hash={item.assemblyHash}
                data-context-frame-id={item.frameId}
                data-context-design-node-id={item.locator?.designNodeId}
                className="min-w-0 border border-border bg-surface-2 px-2 py-1.5"
              >
                <p className="truncate text-[10px] font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.06em] text-muted-foreground">{item.kind}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="shrink-0 border-t border-border p-2.5">
        <label htmlFor="workspace-agent-draft" className="sr-only">
          {draftLabel}
        </label>
        <div className="rounded-xl border border-input bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15">
          <textarea
            id="workspace-agent-draft"
            aria-label={draftLabel}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={placeholder}
            rows={4}
            spellCheck
            className="block max-h-40 min-h-24 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex items-center justify-between border-t border-border/70 px-3 py-2">
            <span className="text-[10px] text-muted-foreground">Project context</span>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{scopeLabel}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
