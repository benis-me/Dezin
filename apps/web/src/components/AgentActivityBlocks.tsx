import { Check, ChevronDown, CircleDashed, ExternalLink, Globe2, ListChecks, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface AgentReasoningItem {
  id: string;
  text: string;
}

function durationLabel(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function AgentThinkingState({ label = "Thinking" }: { label?: string }) {
  return <span className="agent-thinking-state" data-agent-component="thinking-state">{label}</span>;
}

export function AgentReasoning({
  items,
  active,
  durationMs,
}: {
  items: readonly AgentReasoningItem[];
  active: boolean;
  durationMs: number;
}) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  if (items.length === 0) return active ? <AgentThinkingState /> : null;
  const visibleItems = items.slice(-8);
  return (
    <section className="agent-reasoning" data-agent-component="thinking-reasoning" data-active={active || undefined} data-collapsed={!open || undefined}>
      <button type="button" className="agent-reasoning__header" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className={active ? "agent-thinking-state" : undefined}>{active ? "Thinking" : "Thought"}</span>
        {!active ? <span className="agent-reasoning__duration">for {durationLabel(durationMs)}</span> : null}
        <ChevronDown aria-hidden />
      </button>
      <div className="agent-reasoning__collapsible" data-collapsed={!open || undefined}>
        <div>
          <div className="agent-reasoning__viewport">
            {visibleItems.map((item) => <p key={item.id}>{item.text}</p>)}
          </div>
        </div>
      </div>
    </section>
  );
}

export interface AgentProgressItem {
  id: string;
  text: string;
  state: "done" | "active" | "pending" | "failed";
}

export function AgentProgressList({
  items,
  title = "Actions",
  defaultOpen = true,
}: {
  items: readonly AgentProgressItem[];
  title?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const complete = items.filter((item) => item.state === "done").length;
  const allComplete = complete === items.length;
  return (
    <section className="agent-progress" data-agent-component="to-do-list" data-collapsed={!open || undefined} data-complete={allComplete || undefined}>
      <button type="button" className="agent-progress__header" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="agent-progress__header-icon" data-complete={allComplete || undefined}>
          {allComplete ? <Check aria-hidden /> : <ListChecks aria-hidden />}
          <ChevronDown className="agent-progress__chevron" aria-hidden />
        </span>
        <span>{title}</span>
        <span className="agent-progress__count">{complete}/{items.length}</span>
      </button>
      <div className="agent-progress__collapsible" data-collapsed={!open || undefined}>
        <div>
          <ol className="agent-progress__items">
            {items.map((item) => (
              <li key={item.id} data-state={item.state}>
                <span className="agent-progress__state" aria-hidden>
                  {item.state === "done" ? <Check /> : item.state === "active" ? <ExternalLink /> : <CircleDashed />}
                </span>
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

export interface AgentSearchResult {
  id: string;
  title: string;
  href?: string;
  state?: "pending" | "loading" | "done";
}

export function AgentWebSearch({
  query,
  results,
  active,
}: {
  query: string;
  results: readonly AgentSearchResult[];
  active: boolean;
}) {
  const [open, setOpen] = useState(true);
  const normalizedResults = useMemo(() => results.length > 0 ? results : [{
    id: "search",
    title: active ? "Looking for relevant sources" : "Search complete",
    state: active ? "loading" as const : "done" as const,
  }], [active, results]);
  return (
    <section className="agent-web-search" data-agent-component="web-search" data-active={active || undefined} data-collapsed={!open || undefined}>
      <header className="agent-web-search__header">
        <Search aria-hidden />
        <span className={active ? "agent-web-search__label agent-thinking-state" : "agent-web-search__label"}>
          {active ? "Searching" : "Searched"} <span>“{query}”</span>
        </span>
        <button type="button" aria-label="Toggle search results" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <ChevronDown aria-hidden />
        </button>
      </header>
      <div className="agent-web-search__collapsible" data-collapsed={!open || undefined}>
        <div>
          <div className="agent-web-search__results">
            <span className="agent-web-search__rail" aria-hidden />
            <ul>
              {normalizedResults.map((result) => {
                const state = result.state ?? (active ? "loading" : "done");
                const host = result.href ? safeSearchHost(result.href) : null;
                const content = (
                  <>
                    <span className="agent-web-search__status" aria-hidden>
                      {state === "done" ? <Check /> : state === "loading" ? <Globe2 /> : <CircleDashed />}
                    </span>
                    <span className="agent-web-search__title">{result.title}</span>
                    {host ? <><span className="agent-web-search__separator" aria-hidden>·</span><span className="agent-web-search__host">{host}</span></> : null}
                    {result.href ? <ExternalLink className="agent-web-search__arrow" aria-hidden /> : null}
                  </>
                );
                return (
                  <li key={result.id} data-state={state}>
                    {result.href ? <a href={result.href} target="_blank" rel="noreferrer">{content}</a> : <span>{content}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function safeSearchHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

export function AgentImageGenerationState({
  prompt,
  resolution = "Generating",
}: {
  prompt: string;
  resolution?: string;
}) {
  return (
    <figure className="agent-image-generation-state" data-agent-component="image-generation">
      <div className="agent-image-generation-state__canvas" role="img" aria-label="Generating image">
        <span className="agent-image-generation-state__dots" aria-hidden />
        <span className="agent-image-generation-state__glow" aria-hidden />
        <span className="agent-image-generation-state__resolution">{resolution}</span>
      </div>
      <figcaption>
        <AgentThinkingState label="Generating image" />
        <span>“{prompt}”</span>
      </figcaption>
    </figure>
  );
}
