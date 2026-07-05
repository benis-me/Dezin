/**
 * The Research phase's UI surfaces, extracted so they can be unit-tested in isolation:
 *  - ResearchCard   — the live/summary card shown inline in the agent transcript.
 *  - DirectionCard   — the direction gate: pick one candidate direction to build.
 *  - ResearchPanel  — the Research tab: the full .research/ deliverables.
 *
 * Selection state (which direction the user picked at the gate) is threaded through
 * `chosenSlug`, persisted server-side (.research/chosen) so it survives reload.
 */

import { useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown, ChevronRight, Download, FileCode2, Globe, MousePointerClick, Search, Sparkles } from "lucide-react";
import { Markdown } from "../components/Markdown.tsx";
import { cn } from "../lib/utils.ts";
import type { ResearchDetail } from "../lib/api.ts";

export interface ResearchActivityItem {
  kind: string;
  text: string;
}

/** Live + final state of the pre-design Research phase (its dedicated transcript card). */
export interface ResearchCardData {
  status: "running" | "done";
  activities: ResearchActivityItem[];
  report?: boolean;
  sources?: number;
  assets?: number;
  directions?: Array<{ slug: string; title: string; summary?: string }>;
  error?: string;
}

/** A direction's summary prose — its markdown minus the heading/markup, clamped. */
export function directionSummary(markdown: string): string {
  const body = markdown
    .replace(/^#\s+.*$/m, "")
    .replace(/[#*`>]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return body.length > 260 ? `${body.slice(0, 260).trimEnd()}…` : body;
}

/** Small icon for one research step kind. */
function ResearchActivityIcon({ kind }: { kind: string }) {
  const p = { size: 12, strokeWidth: 1.9 } as const;
  if (kind === "search") return <Search {...p} />;
  if (kind === "fetch") return <Globe {...p} />;
  if (kind === "download") return <Download {...p} />;
  if (kind === "write") return <FileCode2 {...p} />;
  return <Sparkles {...p} />; // note / reasoning
}

/** A radio-style indicator for a selectable direction option. */
function OptionRadio({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
        selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 bg-transparent",
      )}
    >
      {selected ? <Check size={11} strokeWidth={3} /> : null}
    </span>
  );
}

/** A magnifier that scans in a small loop while research runs, then settles once it's done ("find"). */
function AnimatedSearchIcon({ running }: { running: boolean }) {
  return (
    <span data-testid="research-search-icon" data-running={running ? "true" : "false"} aria-hidden className="shrink-0 text-muted-foreground">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <motion.g
          animate={running ? { x: [0, 2.4, -1.6, 0], y: [0, -1.6, 2.4, 0] } : { x: 0, y: 0 }}
          transition={running ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3, ease: "easeOut" }}
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="15.5" y1="15.5" x2="20" y2="20" />
        </motion.g>
      </svg>
    </span>
  );
}

/**
 * The pre-design Research phase's dedicated card — live steps, then a results summary.
 * When `onOpen` is provided (research deliverables exist) the whole card opens the Research tab.
 */
export function ResearchCard({ research, chosenSlug, onOpen }: { research: ResearchCardData; chosenSlug?: string; onOpen?: () => void }) {
  const { status, activities, report, sources = 0, assets = 0, directions = [], error } = research;
  const running = status === "running";
  const recent = activities.slice(-14);
  const interactive = !running && !!onOpen;
  const activateKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (interactive && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onOpen?.();
    }
  };
  return (
    <section
      data-testid="research-card"
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        interactive && "cursor-pointer transition-colors hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      {...(interactive
        ? { role: "button", tabIndex: 0, "aria-label": "Open the Research tab", onClick: () => onOpen?.(), onKeyDown: activateKey }
        : {})}
    >
      {/* Single header row — the ONE divider lives under it (below), never doubled. */}
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <AnimatedSearchIcon running={running} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <span>Research</span>
              {/* Run status as plain text after the title, separated by "·" — no tag. */}
              <span data-testid="research-status" className="inline-flex items-center gap-1 font-medium text-muted-foreground">
                <span aria-hidden>·</span>
                {running ? "researching" : report ? "grounded" : "no report"}
              </span>
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{running ? "Studying competitors, audience & references" : "Discovery complete"}</div>
          </div>
        </div>
        {/* Far end: a right arrow signalling the card opens the Research tab. */}
        {interactive ? <ChevronRight data-testid="research-open-arrow" size={16} strokeWidth={2} className="shrink-0 self-center text-muted-foreground" /> : null}
      </div>

      {/* Body — a single bordered region (one divider), holding live steps or the results. */}
      {running && recent.length > 0 ? (
        <ul className="max-h-44 space-y-1 overflow-auto border-t border-border px-3 py-2 text-[11px]">
          {recent.map((a, index) => (
            <li key={index} className="flex items-center gap-2 text-muted-foreground">
              <span className="text-muted-foreground/70">
                <ResearchActivityIcon kind={a.kind} />
              </span>
              <span className="truncate">{a.text}</span>
            </li>
          ))}
        </ul>
      ) : running ? (
        <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Launching research…</div>
      ) : null}

      {status === "done" ? (
        <div className="border-t border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className={report ? "font-medium text-foreground" : "text-muted-foreground"}>{report ? "Report" : "No report"}</span>
            <span className="text-muted-foreground">{sources} sources</span>
            <span className="text-muted-foreground">{assets} assets</span>
            {directions.length ? <span className="text-muted-foreground">{directions.length} directions</span> : null}
          </div>
          {directions.length ? (
            <div className="mt-2 grid gap-1.5">
              {directions.map((d) => {
                const selected = !!chosenSlug && d.slug === chosenSlug;
                const dimmed = !!chosenSlug && !selected; // once a direction is chosen, the others recede
                return (
                  <div
                    key={d.slug}
                    data-testid="research-card-direction"
                    data-selected={selected ? "true" : "false"}
                    className={cn(
                      "flex items-start gap-2 rounded-md border p-2 text-left transition-colors",
                      selected ? "border-primary/60 bg-primary/5 ring-1 ring-primary/20" : "border-border bg-background",
                      dimmed && "opacity-55",
                    )}
                  >
                    <OptionRadio selected={selected} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-foreground">{d.title}</span>
                        {selected ? (
                          <span className="inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">
                            Chosen
                          </span>
                        ) : null}
                      </span>
                      {d.summary ? <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{d.summary}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {error ? <p className="mt-1 text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The direction gate — pick one candidate direction to build. Picking commits immediately
 * (it starts the build), so the picked option locks in and the others dim. On reload the
 * historical pick arrives via `chosenSlug`.
 */
export function DirectionCard({
  directions,
  chosenSlug,
  onPick,
}: {
  directions: Array<{ slug: string; title: string; markdown: string }>;
  chosenSlug?: string;
  onPick: (slug: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const selectedSlug = picked ?? chosenSlug ?? null;
  const resolved = selectedSlug !== null;
  const justPicked = picked !== null; // fresh pick this session vs a choice restored on reload
  const choose = (slug: string): void => {
    if (resolved) return; // one-shot: the pick already started the build
    setPicked(slug);
    onPick(slug);
  };
  return (
    <div className="rounded-lg border border-border bg-card/70 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-2 text-foreground">
          <MousePointerClick size={12} strokeWidth={2} />
        </span>
        <p className="text-sm font-medium text-foreground">{resolved ? (justPicked ? "Building your chosen direction" : "Chosen direction") : "Pick a direction to build"}</p>
      </div>
      <div className="mt-2.5 grid gap-2">
        {directions.map((d) => {
          const selected = d.slug === selectedSlug;
          return (
            <button
              key={d.slug}
              type="button"
              data-testid="direction-option"
              data-selected={selected ? "true" : "false"}
              aria-pressed={selected}
              disabled={resolved}
              onClick={() => choose(d.slug)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
                selected
                  ? "border-primary/60 bg-primary/5 ring-1 ring-primary/20"
                  : resolved
                    ? "border-border bg-background opacity-55"
                    : "cursor-pointer border-border bg-background hover:border-muted-foreground/40 hover:bg-surface-2",
              )}
            >
              <OptionRadio selected={selected} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{d.title}</span>
                  {selected ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">
                      {justPicked ? "Building" : "Chosen"}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{directionSummary(d.markdown)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The Research tab — renders the .research/ deliverables: directions, report, assets, sources. */
export function ResearchPanel({ research, assetUrl }: { research: ResearchDetail | null; assetUrl: (assetPath: string) => string }) {
  if (!research?.exists) {
    return <div className="flex h-full items-center justify-center bg-surface p-6 text-center text-sm text-muted-foreground">No research for this project yet.</div>;
  }
  const directions = research.directions ?? [];
  const sources = research.sources ?? [];
  const assets = research.assets ?? [];
  const chosenSlug = research.chosenSlug;
  // Rewrite markdown image paths (assets/foo.png) to served URLs so the report renders图文并茂.
  const reportMd = (research.report ?? "").replace(/(!\[[^\]]*\]\()(?:\.\/)?(assets\/[^)\s]+)(\))/g, (_m, pre, path, post) => `${pre}${assetUrl(path)}${post}`);
  return (
    <div className="h-full overflow-auto bg-surface">
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        {directions.length ? (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Candidate directions</h3>
            {/* One direction per row; expanded content scrolls inside a bounded height. */}
            <div className="space-y-2">
              {directions.map((d) => {
                const selected = !!chosenSlug && d.slug === chosenSlug;
                return (
                  <details
                    key={d.slug}
                    data-testid="panel-direction"
                    data-selected={selected ? "true" : "false"}
                    className={cn("group rounded-lg border bg-card", selected ? "border-primary/50 ring-1 ring-primary/20" : "border-border")}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 marker:content-['']">
                      <OptionRadio selected={selected} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{d.title}</span>
                      {selected ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          <Check size={10} strokeWidth={3} />
                          Selected
                        </span>
                      ) : null}
                      <ChevronDown size={15} strokeWidth={1.8} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="border-t border-border px-3 pb-3 pt-2">
                      <div className="max-h-64 overflow-auto pr-1">
                        <Markdown className="space-y-1.5 text-[13px] text-foreground">{d.markdown}</Markdown>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        ) : null}
        {reportMd ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <Markdown className="space-y-2 text-sm text-foreground [&_img]:my-2 [&_img]:rounded-md [&_img]:border [&_img]:border-border">{reportMd}</Markdown>
          </section>
        ) : null}
        {assets.length ? (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Collected references · {assets.length}</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {assets.map((a) => (
                <a key={a} href={assetUrl(a)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border bg-card transition hover:border-muted-foreground/40">
                  <img src={assetUrl(a)} alt={a} loading="lazy" className="aspect-video w-full object-cover" />
                </a>
              ))}
            </div>
          </section>
        ) : null}
        {sources.length ? (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sources · {sources.length}</h3>
            <ul className="space-y-1.5">
              {sources.map((s, index) => (
                <li key={s.id ?? index} className="flex items-baseline gap-2 text-[13px]">
                  {s.kind ? <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{s.kind}</span> : null}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">
                      {s.title || s.url}
                    </a>
                  ) : (
                    <span className="truncate text-foreground">{s.title || "source"}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
