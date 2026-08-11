import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";

import "./dezin-agent-primitives.css";

export type AgentLoadingVariant = "drive" | "dots" | "orbit";

const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3] as const;
const LOADING_PATTERNS: Record<AgentLoadingVariant, { delays: (number | null)[]; duration: number }> = {
  drive: { delays: CHEVRON_DELAYS, duration: 650 },
  dots: { delays: CHEVRON_DELAYS, duration: 650 },
  orbit: {
    delays: Array.from({ length: 9 }, (_, index) => {
      const order = ORBIT_ORDER.indexOf(index as (typeof ORBIT_ORDER)[number]);
      return order < 0 ? null : order * 110;
    }),
    duration: 950,
  },
};

export interface DezinAgentLoadingStateProps {
  label?: string;
  elapsed?: ReactNode;
  variant?: AgentLoadingVariant;
}

export function DezinAgentLoadingState({
  label = "Working",
  elapsed,
  variant = "drive",
}: DezinAgentLoadingStateProps) {
  const pattern = LOADING_PATTERNS[variant];
  return (
    <div
      className="dezin-agent dezin-agent-loading"
      data-dezin-agent-primitive="loading"
      data-variant={variant}
      role="status"
      aria-label={label}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="dezin-agent-loading__grid" data-loading-grid aria-hidden="true">
        {pattern.delays.map((delay, index) => (
          <span
            key={index}
            data-loading-pixel
            style={{
              "--pixel-delay": delay === null ? undefined : `${delay}ms`,
              "--pixel-duration": `${pattern.duration}ms`,
              "--pixel-animation": delay === null ? "none" : "dezin-agent-pixel",
            } as CSSProperties}
          />
        ))}
      </span>
      <span className="dezin-agent-loading__label">{label}</span>
      {elapsed === null || elapsed === undefined ? null : <span className="dezin-agent-loading__elapsed">{elapsed}</span>}
    </div>
  );
}

export interface DezinAgentThinkingItem {
  id: string;
  text: ReactNode;
  meta?: ReactNode;
  state?: "done" | "active" | "pending";
}

export interface DezinAgentThinkingProps {
  items: readonly DezinAgentThinkingItem[];
  active?: boolean;
  durationLabel?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function DezinAgentThinking({
  items,
  active = false,
  durationLabel,
  defaultOpen = active,
  open: controlledOpen,
  onOpenChange,
}: DezinAgentThinkingProps) {
  const regionId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const label = durationLabel ? `Thought for ${durationLabel}` : active ? "Thinking" : "Thought process";
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section className="dezin-agent dezin-agent-thinking" data-dezin-agent-primitive="thinking" data-active={active || undefined} data-open={open}>
      <button type="button" className="dezin-agent-thinking__trigger" aria-label={label} aria-controls={regionId} aria-expanded={open} onClick={() => setOpen(!open)}>
        <SparkleIcon />
        <span>{label}</span>
        <ChevronIcon />
      </button>
      <DisclosureRegion id={regionId} open={open} className="dezin-agent-thinking__region">
        <ol className="dezin-agent-thinking__steps">
          {items.map((item, index) => {
            const state = item.state ?? "done";
            return (
              <li key={item.id} data-state={state} style={{ "--item-index": index } as CSSProperties}>
                <span className="dezin-agent-thinking__step-icon" aria-hidden="true">
                  {state === "done" ? <CheckIcon /> : state === "active" ? <span className="dezin-agent-thinking__spinner" /> : <span className="dezin-agent-thinking__pending-dot" />}
                </span>
                <span className="dezin-agent-thinking__step-copy">{item.text}</span>
                {item.meta === null || item.meta === undefined ? null : <small>{item.meta}</small>}
              </li>
            );
          })}
        </ol>
      </DisclosureRegion>
    </section>
  );
}

export interface DezinAgentStreamingTextProps {
  children: ReactNode;
  streaming?: boolean;
  ariaLabel?: string;
}

export function DezinAgentStreamingText({ children, streaming = false, ariaLabel = "Agent response" }: DezinAgentStreamingTextProps) {
  return (
    <div
      className="dezin-agent dezin-agent-streaming"
      data-dezin-agent-primitive="streaming"
      data-streaming={streaming || undefined}
      role={streaming ? "status" : "article"}
      aria-label={ariaLabel}
      aria-live={streaming ? "polite" : undefined}
      aria-atomic={streaming ? "false" : undefined}
      aria-busy={streaming}
    >
      {children}
      {streaming ? <span className="dezin-agent-streaming__cursor" aria-hidden="true" /> : null}
    </div>
  );
}

export interface AgentActionSpec {
  id: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "primary" | "secondary" | "danger";
  icon?: ReactNode;
}

export interface AgentApprovalOption {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface DezinAgentApprovalProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  tone?: "neutral" | "warning" | "danger";
  options?: readonly AgentApprovalOption[];
  selectionMode?: "single" | "multiple";
  selectedIds?: readonly string[];
  defaultSelectedIds?: readonly string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  actions?: readonly AgentActionSpec[];
  onDismiss?: () => void;
}

export function DezinAgentApproval({
  title,
  description,
  children,
  tone = "neutral",
  options = [],
  selectionMode = "single",
  selectedIds: controlledSelectedIds,
  defaultSelectedIds = [],
  onSelectionChange,
  actions = [],
  onDismiss,
}: DezinAgentApprovalProps) {
  const titleId = useId();
  const [localSelectedIds, setLocalSelectedIds] = useState<string[]>([...defaultSelectedIds]);
  const selectedIds = controlledSelectedIds ?? localSelectedIds;
  const select = (id: string) => {
    const next = selectionMode === "single"
      ? [id]
      : selectedIds.includes(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id];
    if (controlledSelectedIds === undefined) setLocalSelectedIds(next);
    onSelectionChange?.(next);
  };

  return (
    <section className="dezin-agent dezin-agent-approval" data-dezin-agent-primitive="approval" data-tone={tone} role="group" aria-labelledby={titleId}>
      <div className="dezin-agent-approval__body">
        <div className="dezin-agent-approval__heading">
          <div>
            <h3 id={titleId}>{title}</h3>
            {description === null || description === undefined ? null : <div className="dezin-agent-approval__description">{description}</div>}
          </div>
          {onDismiss ? (
            <button type="button" className="dezin-agent-icon-button" aria-label="Dismiss approval" onClick={onDismiss}><CloseIcon /></button>
          ) : null}
        </div>
        {children === null || children === undefined ? null : <div className="dezin-agent-approval__content">{children}</div>}
        {options.length === 0 ? null : (
          <div className="dezin-agent-approval__options" role={selectionMode === "single" ? "radiogroup" : "group"} aria-label={title}>
            {options.map((option) => {
              const checked = selectedIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role={selectionMode === "single" ? "radio" : "checkbox"}
                  aria-checked={checked}
                  aria-pressed={checked}
                  disabled={option.disabled}
                  onClick={() => select(option.id)}
                >
                  <span className="dezin-agent-approval__choice" data-shape={selectionMode === "single" ? "radio" : "check"} data-selected={checked || undefined} aria-hidden="true">
                    {selectionMode === "single" ? <i /> : <CheckIcon />}
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    {option.description === null || option.description === undefined ? null : <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="dezin-agent-approval__footer"><AgentActions actions={actions} className="dezin-agent-approval__actions" /></div>
    </section>
  );
}

export type AgentToolChipState = "done" | "active" | "pending" | "failed";
export type AgentToolChipKind = "thinking" | "write" | "command" | "read" | "search" | "tool";

export interface AgentToolChipItem {
  id: string;
  label: ReactNode;
  detail?: ReactNode;
  state?: AgentToolChipState;
  kind?: AgentToolChipKind;
  children?: ReactNode;
}

export interface AgentFileChange { id: string; path: string; additions?: number; deletions?: number }

export interface DezinAgentToolGroupProps {
  items: readonly AgentToolChipItem[];
  title?: string;
  messageCount?: number;
  changes?: readonly AgentFileChange[];
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function DezinAgentToolGroup({
  items,
  title,
  messageCount,
  changes = [],
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
}: DezinAgentToolGroupProps) {
  const regionId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const open = controlledOpen ?? localOpen;
  const summary = title ?? `${items.length} tool ${items.length === 1 ? "call" : "calls"}${messageCount === undefined ? "" : `, ${messageCount} ${messageCount === 1 ? "message" : "messages"}`}`;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const toggleRow = (id: string) => setOpenRows((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="dezin-agent dezin-agent-tool-chips" data-dezin-agent-primitive="tools" data-open={open}>
      <button type="button" className="dezin-agent-tool-chips__trigger" aria-label={summary} aria-controls={regionId} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon />
        <span>{summary}</span>
      </button>
      <DisclosureRegion id={regionId} open={open} className="dezin-agent-tool-chips__region">
        <div className="dezin-agent-tool-chips__clip">
          <ol className="dezin-agent-tool-chips__items">
            {items.map((item, index) => {
              const state = item.state ?? "pending";
              const detailsId = `${regionId}-${item.id}`;
              const expanded = item.children !== null && item.children !== undefined && openRows.has(item.id);
              const row = (
                <>
                  <span className="dezin-agent-tool-chips__icon" aria-hidden="true"><ToolIcon kind={item.kind ?? "tool"} state={state} /><ChevronIcon /></span>
                  <span className="dezin-agent-tool-chips__label">{item.label}</span>
                  {item.detail === null || item.detail === undefined ? null : <code>{item.detail}</code>}
                </>
              );
              return (
                <li key={item.id} data-state={state} data-kind={item.kind ?? "tool"} style={{ "--item-index": index } as CSSProperties}>
                  {item.children === null || item.children === undefined ? (
                    <div className="dezin-agent-tool-chips__item-summary">{row}</div>
                  ) : (
                    <button type="button" className="dezin-agent-tool-chips__item-summary" aria-label={typeof item.label === "string" ? item.label : undefined} aria-controls={detailsId} aria-expanded={expanded} onClick={() => toggleRow(item.id)}>{row}</button>
                  )}
                  {item.children === null || item.children === undefined ? null : (
                    <DisclosureRegion id={detailsId} open={expanded} className="dezin-agent-tool-chips__item-region"><div className="dezin-agent-tool-chips__item-content">{item.children}</div></DisclosureRegion>
                  )}
                </li>
              );
            })}
          </ol>
          {changes.length === 0 ? null : (
            <div className="dezin-agent-tool-chips__changes" aria-label="Changed files">
              {changes.map((change, index) => (
                <span key={change.id} data-file-change style={{ "--item-index": index } as CSSProperties}>
                  <code className="dezin-agent-tool-chips__change-path" title={change.path}>{change.path}</code>
                  {change.additions === undefined ? null : <small data-tone="add">+{change.additions}</small>}
                  {change.deletions === undefined ? null : <small data-tone="delete">−{change.deletions}</small>}
                </span>
              ))}
            </div>
          )}
        </div>
      </DisclosureRegion>
    </section>
  );
}

export type AgentTaskStatus = "queued" | "running" | "validating" | "ready" | "failed" | "cancelled" | "superseded";
export interface DezinAgentTaskRowProps {
  title: string;
  meta?: ReactNode;
  status: AgentTaskStatus;
  statusLabel?: ReactNode;
  children?: ReactNode;
  trailing?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}
const TASK_LABELS: Record<AgentTaskStatus, string> = { queued: "Queued", running: "Running", validating: "Validating", ready: "Completed", failed: "Failed", cancelled: "Cancelled", superseded: "Superseded" };

export function DezinAgentTaskRow({ title, meta, status, statusLabel = TASK_LABELS[status], children, trailing, defaultOpen = false, open: controlledOpen, onOpenChange }: DezinAgentTaskRowProps) {
  const regionId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const hasContent = children !== null && children !== undefined;
  const open = hasContent && (controlledOpen ?? localOpen);
  const setOpen = (next: boolean) => {
    if (!hasContent) return;
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const content = (
    <>
      <TaskStatusMark status={status} />
      <span className="dezin-agent-task-row__copy"><strong>{title}</strong>{meta === null || meta === undefined ? null : <small>{meta}</small>}</span>
      <span className="dezin-agent-task-row__status-label">{statusLabel}{status === "failed" ? <RetryIcon /> : null}</span>
      {hasContent ? <ChevronIcon /> : null}
    </>
  );
  return (
    <article className="dezin-agent dezin-agent-task-row" data-dezin-agent-primitive="task" data-status={status} data-open={open || undefined}>
      <header>
        {hasContent ? <button type="button" className="dezin-agent-task-row__trigger" aria-label={`${title} · ${status}`} aria-controls={regionId} aria-expanded={open} onClick={() => setOpen(!open)}>{content}</button> : <div className="dezin-agent-task-row__trigger">{content}</div>}
        {trailing === null || trailing === undefined ? null : <div className="dezin-agent-task-row__trailing">{trailing}</div>}
      </header>
      {hasContent ? <DisclosureRegion id={regionId} open={open} className="dezin-agent-task-row__region"><div className="dezin-agent-task-row__content">{children}</div></DisclosureRegion> : null}
    </article>
  );
}

export interface AgentRecommendationConfidence { level: "low" | "medium" | "high"; label: ReactNode }
export interface AgentRecommendationAlternative { id: string; title: ReactNode; description?: ReactNode; meta?: ReactNode; onSelect?: () => void }
export interface DezinAgentRecommendationProps {
  title: string;
  description?: ReactNode;
  confidence?: AgentRecommendationConfidence;
  actions?: readonly AgentActionSpec[];
  alternatives?: readonly AgentRecommendationAlternative[];
  defaultShowAlternatives?: boolean;
}

export function DezinAgentRecommendation({ title, description, confidence, actions = [], alternatives = [], defaultShowAlternatives = false }: DezinAgentRecommendationProps) {
  const titleId = useId();
  const alternativesId = useId();
  const [open, setOpen] = useState(defaultShowAlternatives);
  return (
    <section className="dezin-agent dezin-agent-recommendation" data-dezin-agent-primitive="recommendation" role="group" aria-labelledby={titleId}>
      <div className="dezin-agent-recommendation__body"><strong id={titleId}>{title}</strong>{description === null || description === undefined ? null : <div>{description}</div>}</div>
      {alternatives.length === 0 ? null : (
        <DisclosureRegion id={alternativesId} open={open} className="dezin-agent-recommendation__alternatives-region">
          <div className="dezin-agent-recommendation__alternatives"><small>Other options</small>{alternatives.map((option) => (
            <button key={option.id} type="button" disabled={!option.onSelect} onClick={() => { option.onSelect?.(); setOpen(false); }}>
              <span><strong>{option.title}</strong>{option.description === null || option.description === undefined ? null : <small>{option.description}</small>}</span>
              {option.meta === null || option.meta === undefined ? null : <em>{option.meta}</em>}
            </button>
          ))}</div>
        </DisclosureRegion>
      )}
      <footer className="dezin-agent-recommendation__footer">
        {confidence ? <ConfidenceMeter confidence={confidence} /> : <span />}
        <span className="dezin-agent-recommendation__buttons">
          {alternatives.length > 0 ? <button type="button" className="dezin-agent-recommendation__alternatives-trigger" aria-controls={alternativesId} aria-expanded={open} onClick={() => setOpen((value) => !value)}>Alternatives</button> : null}
          <AgentActions actions={actions} className="dezin-agent-recommendation__actions" />
        </span>
      </footer>
    </section>
  );
}

export interface AgentContextSource { label: string; href?: string; kind?: string }
export interface AgentContextCardItem { id: string; title: ReactNode; meta?: ReactNode; summary?: ReactNode; source?: AgentContextSource }
export interface DezinAgentContextProps { title?: string; count?: number; items: readonly AgentContextCardItem[] }

export function DezinAgentContext({ title = "Context", count, items }: DezinAgentContextProps) {
  const titleId = useId();
  const [sourcesShown, setSourcesShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSourcesShown(true), 700);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <section className="dezin-agent dezin-agent-context" data-dezin-agent-primitive="context" role="group" aria-labelledby={titleId} data-sources-shown={sourcesShown || undefined}>
      <header className="dezin-agent-context__header"><strong id={titleId}>{title}</strong><small>{count ?? items.length}</small></header>
      <div className="dezin-agent-context__items">{items.map((item, index) => (
        <article key={item.id} style={{ "--item-index": index } as CSSProperties}>
          <header><span><ListIcon /><strong>{item.title}</strong></span>{item.meta === null || item.meta === undefined ? null : <small>{item.meta}</small>}</header>
          {item.summary === null || item.summary === undefined ? null : <p>{item.summary}</p>}
          {item.source ? <ContextSource source={item.source} /> : null}
        </article>
      ))}</div>
    </section>
  );
}

export interface AgentInsightMetric { id: string; label: ReactNode; value: ReactNode; detail?: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "accent" }
export interface AgentInsightCardItem { id: string; title: ReactNode; description?: ReactNode; metrics?: readonly AgentInsightMetric[]; visual?: ReactNode; action?: AgentActionSpec }
export interface DezinAgentInsightsProps { title?: string; items: readonly AgentInsightCardItem[]; index?: number; defaultIndex?: number; onIndexChange?: (index: number) => void }

export function DezinAgentInsights({ title = "Insights", items, index: controlledIndex, defaultIndex = 0, onIndexChange }: DezinAgentInsightsProps) {
  const titleId = useId();
  const [localIndex, setLocalIndex] = useState(defaultIndex);
  const count = items.length;
  const index = count === 0 ? 0 : ((controlledIndex ?? localIndex) % count + count) % count;
  const item = items[index];
  const move = (direction: -1 | 1) => {
    if (count === 0) return;
    const next = (index + direction + count) % count;
    if (controlledIndex === undefined) setLocalIndex(next);
    onIndexChange?.(next);
  };
  return (
    <section className="dezin-agent dezin-agent-insights" data-dezin-agent-primitive="insights" role="group" aria-labelledby={titleId}>
      <header className="dezin-agent-insights__header"><span><strong id={titleId}>{title}</strong><small>{count}</small></span><nav aria-label="Insight pages"><button type="button" aria-label="Previous insight" disabled={count === 0} onClick={() => move(-1)}><ArrowIcon direction="left" /></button><button type="button" aria-label="Next insight" disabled={count === 0} onClick={() => move(1)}><ArrowIcon direction="right" /></button></nav></header>
      {item ? <article className="dezin-agent-insights__page" key={item.id} aria-live="polite">
        <p className="dezin-agent-insights__prose"><strong>{item.title}</strong>{item.description === null || item.description === undefined ? null : <> — {item.description}</>}</p>
        {item.metrics?.length || item.visual ? <div className="dezin-agent-insights__surface">
          {item.metrics?.length ? <ul className="dezin-agent-insights__metrics">{item.metrics.map((metric) => <li key={metric.id} data-tone={metric.tone ?? "neutral"}><span>{metric.label}</span><strong>{metric.value}</strong>{metric.detail === null || metric.detail === undefined ? null : <small>{metric.detail}</small>}</li>)}</ul> : null}
          {item.visual === null || item.visual === undefined ? null : <div className="dezin-agent-insights__visual">{item.visual}</div>}
        </div> : null}
        {item.action ? <AgentActions actions={[item.action]} className="dezin-agent-insights__actions" /> : null}
      </article> : null}
    </section>
  );
}

function AgentActions({ actions, className }: { actions: readonly AgentActionSpec[]; className: string }) {
  if (actions.length === 0) return null;
  return <span className={`dezin-agent-actions ${className}`}>{actions.map((action) => <button key={action.id} type="button" data-tone={action.tone ?? "secondary"} disabled={action.disabled || action.busy} aria-busy={action.busy || undefined} onClick={action.onClick}>{action.busy ? <span className="dezin-agent-action-spinner" aria-hidden="true" /> : action.icon}<span>{action.label}</span></button>)}</span>;
}

function DisclosureRegion({ id, open, className, children }: { id: string; open: boolean; className?: string; children: ReactNode }) {
  return <div id={id} className={`dezin-agent-disclosure${className ? ` ${className}` : ""}`} data-open={open} aria-hidden={!open} inert={!open}><div className="dezin-agent-disclosure__content">{children}</div></div>;
}

function ToolIcon({ kind, state }: { kind: AgentToolChipKind; state: AgentToolChipState }) {
  if (state === "failed") return <CloseIcon />;
  if (kind === "thinking") return <SparkleIcon />;
  if (kind === "write") return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>;
  if (kind === "read") return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
  if (kind === "search") return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
  return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-5-6-5M12 19h8" /></svg>;
}

function TaskStatusMark({ status }: { status: AgentTaskStatus }) {
  if (status === "ready") return <span className="dezin-agent-task-row__badge" data-tone="green"><CheckIcon /></span>;
  if (status === "failed") return <span className="dezin-agent-task-row__badge" data-tone="red"><CloseIcon /></span>;
  if (status === "cancelled" || status === "superseded") return <span className="dezin-agent-task-row__badge" data-tone="muted"><CloseIcon /></span>;
  const active = status === "running" || status === "validating";
  return <span className="dezin-agent-task-row__ring" data-active={active || undefined} aria-hidden="true"><svg width="24" height="24"><circle cx="12" cy="12" r="11" /><circle className="dezin-agent-task-row__ring-progress" cx="12" cy="12" r="11" /></svg></span>;
}

function ConfidenceMeter({ confidence }: { confidence: AgentRecommendationConfidence }) {
  const signal = confidence.level === "high" ? 3 : confidence.level === "medium" ? 2 : 1;
  return <span className="dezin-agent-recommendation__confidence" data-level={confidence.level}><span aria-hidden="true">{[0, 1, 2].map((bar) => <i key={bar} data-active={bar < signal || undefined} />)}</span><span>{confidence.label}</span></span>;
}

function ContextSource({ source }: { source: AgentContextSource }) {
  const content = <><span>{source.kind ?? "REF"}</span><strong>{source.label}</strong>{source.href ? <ExternalArrowIcon /> : null}</>;
  return source.href ? <a href={source.href} target="_blank" rel="noreferrer">{content}</a> : <span className="dezin-agent-context__source">{content}</span>;
}

function SparkleIcon() { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>; }
function ChevronIcon() { return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>; }
function CheckIcon() { return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>; }
function CloseIcon() { return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>; }
function RetryIcon() { return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>; }
function ListIcon() { return <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>; }
function ExternalArrowIcon() { return <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M7 7h10v10" /></svg>; }
function ArrowIcon({ direction }: { direction: "left" | "right" }) { return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={direction === "left" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"} /></svg>; }
