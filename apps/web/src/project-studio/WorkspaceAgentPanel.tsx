export function WorkspaceAgentPanel({
  draft,
  onDraftChange,
  contextLabel,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  contextLabel: string;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="workspace-agent-title">
      <header className="app-drag titlebar-pad-left flex h-11 shrink-0 items-center border-b border-border px-3.5">
        <div className="min-w-0">
          <h2 id="workspace-agent-title" className="truncate text-xs font-medium tracking-[-0.01em] text-foreground">
            Workspace Agent
          </h2>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{contextLabel}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1" />
      <div className="shrink-0 border-t border-border p-2.5">
        <label htmlFor="workspace-agent-draft" className="sr-only">
          Workspace Agent draft
        </label>
        <div className="rounded-xl border border-input bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15">
          <textarea
            id="workspace-agent-draft"
            aria-label="Workspace Agent draft"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Plan a page, component, or workspace change…"
            rows={4}
            spellCheck
            className="block max-h-40 min-h-24 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex items-center justify-between border-t border-border/70 px-3 py-2">
            <span className="text-[10px] text-muted-foreground">Project context</span>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Workspace</span>
          </div>
        </div>
      </div>
    </section>
  );
}
