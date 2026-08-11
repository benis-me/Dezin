import { Check, ChevronDown, Circle, CircleAlert, CircleDashed, ExternalLink, Globe2, ImageIcon, ListChecks, LoaderCircle, Search } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { AgentCollapsible } from "./AgentCollapsible.tsx";

export interface AgentReasoningItem {
  id: string;
  text: string;
}

const INITIAL_REASONING_WINDOW = 24;

export function AgentActivityHeaderContent({
  icon,
  label,
  meta,
  state = "idle",
  animated = false,
}: {
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  state?: "idle" | "active" | "complete" | "failed";
  animated?: boolean;
}) {
  return (
    <>
      <span className="agent-activity-card__marker" data-state={state} aria-hidden>{icon}</span>
      <span className="agent-activity-card__summary">
        <span className={animated ? "agent-activity-card__label agent-thinking-state" : "agent-activity-card__label"}>{label}</span>
        {meta === null || meta === undefined ? null : <span className="agent-activity-card__meta">{meta}</span>}
      </span>
      <ChevronDown className="agent-activity-card__chevron" aria-hidden />
    </>
  );
}

export function AgentThinkingState({ label = "Thinking" }: { label?: string }) {
  return <span className="agent-thinking-state" data-agent-component="thinking-state">{label}</span>;
}

export function AgentReasoning({
  items,
  active,
}: {
  items: readonly AgentReasoningItem[];
  active: boolean;
  durationMs: number;
}) {
  const [open, setOpen] = useState(active);
  const [visibleItemCount, setVisibleItemCount] = useState(INITIAL_REASONING_WINDOW);
  const detailsId = useId();
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  if (items.length === 0) return active ? <AgentThinkingState /> : null;
  const boundedVisibleItemCount = Math.min(
    items.length,
    Math.max(INITIAL_REASONING_WINDOW, visibleItemCount),
  );
  const hiddenItemCount = Math.max(0, items.length - boundedVisibleItemCount);
  const revealItemCount = Math.min(hiddenItemCount, boundedVisibleItemCount);
  const visibleItems = items.slice(-boundedVisibleItemCount);
  return (
    <section className="agent-activity-card agent-reasoning" data-agent-component="thinking-reasoning" data-activity-kind="thinking" data-active={active || undefined} data-collapsed={!open || undefined}>
      <button type="button" className="agent-activity-card__header agent-reasoning__header" aria-label="Thinking" aria-controls={detailsId} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <AgentActivityHeaderContent
          icon={active ? <span className="agent-activity-card__pulse" /> : <Check />}
          label="Thinking"
          meta={active ? "Live" : "Completed"}
          state={active ? "active" : "complete"}
          animated={active}
        />
      </button>
      <AgentCollapsible
        id={detailsId}
        className="agent-reasoning__collapsible"
        open={open}
      >
        <div className="agent-reasoning__viewport">
          {hiddenItemCount > 0 ? (
            <button
              type="button"
              className="agent-reasoning__history-button"
              onClick={() => setVisibleItemCount((current) => {
                const boundedCurrent = Math.min(
                  items.length,
                  Math.max(INITIAL_REASONING_WINDOW, current),
                );
                return Math.min(items.length, boundedCurrent * 2);
              })}
            >
              Show earlier Thinking (+{revealItemCount} · {hiddenItemCount} remaining)
            </button>
          ) : null}
          {visibleItems.map((item) => <p key={item.id}>{item.text}</p>)}
        </div>
      </AgentCollapsible>
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
  completionTone = "auto",
}: {
  items: readonly AgentProgressItem[];
  title?: string;
  defaultOpen?: boolean;
  completionTone?: "auto" | "neutral";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  if (items.length === 0) return null;
  const complete = items.filter((item) => item.state === "done").length;
  const active = items.some((item) => item.state === "active");
  const allComplete = complete === items.length;
  const showCompleteTone = allComplete && completionTone === "auto";
  return (
    <section className="agent-activity-card agent-progress" data-agent-component="to-do-list" data-activity-kind="actions" data-active={active || undefined} data-collapsed={!open || undefined} data-complete={showCompleteTone || undefined}>
      <button type="button" className="agent-activity-card__header agent-progress__header" aria-controls={detailsId} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <AgentActivityHeaderContent
          icon={allComplete ? <Check /> : <ListChecks />}
          label={title}
          meta={allComplete && completionTone === "neutral" ? `${complete} steps completed` : `${complete}/${items.length}`}
          state={showCompleteTone ? "complete" : "idle"}
        />
      </button>
      <AgentCollapsible
        id={detailsId}
        className="agent-progress__collapsible"
        open={open}
      >
        <ol className="agent-progress__items">
          {items.map((item) => (
            <li key={item.id} data-state={item.state}>
              <span className="agent-progress__state" aria-hidden>
                {item.state === "done"
                  ? <Check />
                  : item.state === "active"
                    ? <LoaderCircle />
                    : item.state === "failed"
                      ? <CircleAlert />
                      : <Circle />}
              </span>
              <span><span className="agent-visually-hidden">{item.state === "done" ? "Complete:" : item.state === "active" ? "Active:" : item.state === "failed" ? "Failed:" : "Pending:"}</span>{item.text}</span>
            </li>
          ))}
        </ol>
      </AgentCollapsible>
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
  const detailsId = useId();
  const normalizedResults = useMemo(() => results.length > 0 ? results : [{
    id: "search",
    title: active ? "Looking for relevant sources" : "Search complete",
    state: active ? "loading" as const : "done" as const,
  }], [active, results]);
  return (
    <section className="agent-activity-card agent-web-search" data-agent-component="web-search" data-activity-kind="search" data-active={active || undefined} data-collapsed={!open || undefined}>
      <button
        type="button"
        className="agent-activity-card__header agent-web-search__header"
        aria-label={`${active ? "Searching" : "Search"}: ${query}`}
        aria-controls={detailsId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <AgentActivityHeaderContent
          icon={<Search />}
          label={active ? "Searching" : "Search"}
          meta={<>“{query}”</>}
          state={active ? "active" : "complete"}
          animated={active}
        />
      </button>
      <AgentCollapsible
        id={detailsId}
        className="agent-web-search__collapsible"
        open={open}
      >
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
      </AgentCollapsible>
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
  resolution,
  active = true,
}: {
  prompt: string;
  resolution?: string;
  active?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const detailsId = useId();
  const statusLabel = resolution ?? (active ? "Generating" : "Completed");
  return (
    <figure className="agent-activity-card agent-image-generation-state" data-agent-component="image-generation" data-activity-kind="image-generation" data-active={active || undefined} data-collapsed={!open || undefined}>
      <button
        type="button"
        className="agent-activity-card__header agent-image-generation-state__header"
        aria-label={`Image generation: ${statusLabel}`}
        aria-controls={detailsId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <AgentActivityHeaderContent
          icon={<ImageIcon />}
          label="Image generation"
          meta={statusLabel}
          state={active ? "active" : "complete"}
          animated={active}
        />
      </button>
      <AgentCollapsible id={detailsId} className="agent-image-generation-state__collapsible" open={open}>
        <div className="agent-image-generation-state__body">
          <div className="agent-image-generation-state__canvas" role="img" aria-label={active ? "Generating image" : "Completed image generation activity"}>
            <span className="agent-image-generation-state__dots" aria-hidden />
            <span className="agent-image-generation-state__glow" aria-hidden />
          </div>
          <figcaption>“{prompt}”</figcaption>
        </div>
      </AgentCollapsible>
    </figure>
  );
}
