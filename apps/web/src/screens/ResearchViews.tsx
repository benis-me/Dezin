/**
 * The Research phase's UI surfaces, extracted so they can be unit-tested in isolation:
 *  - ResearchCard   — the live/summary card shown inline in the agent transcript.
 *  - DirectionCard   — the direction gate: pick one candidate direction to build.
 *  - ResearchPanel  — the Research tab: the full .research/ deliverables.
 *
 * Selection state (which direction the user picked at the gate) is threaded through
 * `chosenSlug`, persisted server-side (.research/chosen) so it survives reload.
 */

import { lazy, Suspense, useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown, ChevronRight, Download, FileCode2, Globe, Search, Sparkles } from "lucide-react";
import { Markdown } from "../components/Markdown.tsx";
import { cn } from "../lib/utils.ts";
import type { ResearchDetail } from "../lib/api.ts";

// Lazy: pulls in MoodboardCanvas (leafer-react canvas runtime), which must not load eagerly on
// ResearchViews' import path (WorkspaceScreen imports this module statically for every project).
const VisualResearchBoard = lazy(() =>
  import("./VisualResearchBoard.tsx").then((module) => ({ default: module.VisualResearchBoard })),
);

export interface ResearchActivityItem {
  kind: string;
  text: string;
  /** Which research track this step belongs to. Absent on older events (treated as "product"). */
  track?: "product" | "visual";
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
  /** The parallel visual-research track's counts. Absent/zero on older events — render defensively. */
  visual?: { produced: boolean; assets: number; sources: number };
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

/** One lane of research activity steps (used standalone, or as one of two lanes when tracks are present). */
function ResearchActivityList({ activities, label }: { activities: ResearchActivityItem[]; label?: string }) {
  return (
    <div>
      {label ? <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{label}</div> : null}
      <ul className="space-y-1">
        {activities.map((a, index) => (
          <li key={index} className="flex items-center gap-2 text-muted-foreground">
            <span className="text-muted-foreground/70">
              <ResearchActivityIcon kind={a.kind} />
            </span>
            <span className="truncate">{a.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The pre-design Research phase's dedicated card — live steps, then a results summary.
 * When `onOpen` is provided (research deliverables exist) the whole card opens the Research tab.
 */
export function ResearchCard({
  research,
  chosenSlug,
  onOpen,
  onPick,
}: {
  research: ResearchCardData;
  chosenSlug?: string;
  onOpen?: () => void;
  /** When provided and no direction is chosen yet, the directions become selectable inline and a
   *  Submit button commits the pick (nothing runs until Submit). */
  onPick?: (slug: string) => void;
}) {
  const { status, activities, report, sources = 0, assets = 0, directions = [], error, visual } = research;
  const showVisual = !!visual && (visual.produced || visual.assets > 0 || visual.sources > 0);
  const running = status === "running";
  const recent = activities.slice(-14);
  const hasTracks = activities.some((a) => !!a.track);
  const [selected, setSelected] = useState<string | null>(null);
  // Optimistic lock: the moment Submit is clicked, lock the picker (don't wait for the server's
  // chosenSlug to round-trip) so the options + Submit button can no longer be changed.
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const committedSlug = chosenSlug ?? pendingSlug ?? undefined;
  // Direction gate open: pick one direction INLINE, then Submit. Once a choice is committed
  // (Submit clicked, or chosenSlug arrives), the card locks to a read-only display of the chosen one.
  const pickable = !running && !!onPick && !committedSlug && directions.length > 0;
  const interactive = !running && !pickable && !!onOpen; // whole-card click opens the tab — but never while picking
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
        hasTracks ? (
          <div className="max-h-44 overflow-auto border-t border-border px-3 py-2 text-[11px]">
            <div className="grid grid-cols-2 gap-3">
              <ResearchActivityList activities={recent.filter((a) => (a.track ?? "product") === "product")} label="Product" />
              <ResearchActivityList activities={recent.filter((a) => a.track === "visual")} label="Visual" />
            </div>
          </div>
        ) : (
          <div className="max-h-44 overflow-auto border-t border-border px-3 py-2 text-[11px]">
            <ResearchActivityList activities={recent} />
          </div>
        )
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
          {showVisual ? (
            <div data-testid="research-card-visual" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className={visual!.produced ? "font-medium text-foreground" : "text-muted-foreground"}>
                {visual!.produced ? "Visual" : "No visual research"}
              </span>
              <span className="text-muted-foreground">{visual!.sources} sources</span>
              <span className="text-muted-foreground">{visual!.assets} assets</span>
            </div>
          ) : null}
          {directions.length ? (
            <div className="mt-2 grid gap-1.5">
              {directions.map((d) => {
                const isChosen = !!committedSlug && d.slug === committedSlug;
                const isSelected = pickable && selected === d.slug;
                const active = isChosen || isSelected;
                const dimmed = !!committedSlug && !isChosen; // once a direction is committed, the others recede
                // No outer shadow ring on the selected direction — just a border + tint.
                const optionClass = cn(
                  "flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors",
                  active ? "border-primary/60 bg-primary/5" : "border-border bg-background",
                  pickable && !active && "cursor-pointer hover:border-muted-foreground/40 hover:bg-surface-2",
                  dimmed && "opacity-55",
                );
                const inner = (
                  <>
                    <OptionRadio selected={active} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-xs font-medium text-foreground">{d.title}</span>
                        {isChosen ? (
                          <span className="inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">
                            Chosen
                          </span>
                        ) : null}
                      </span>
                      {d.summary ? <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{d.summary}</span> : null}
                    </span>
                  </>
                );
                return pickable ? (
                  <button key={d.slug} type="button" data-testid="research-card-direction" data-selected={active ? "true" : "false"} aria-pressed={isSelected} onClick={() => setSelected(d.slug)} className={optionClass}>
                    {inner}
                  </button>
                ) : (
                  <div key={d.slug} data-testid="research-card-direction" data-selected={active ? "true" : "false"} className={optionClass}>
                    {inner}
                  </div>
                );
              })}
            </div>
          ) : null}
          {pickable ? (
            <button
              type="button"
              data-testid="research-submit-direction"
              disabled={!selected}
              onClick={() => {
                if (selected) {
                  setPendingSlug(selected); // lock the picker immediately (optimistic)
                  onPick!(selected);
                }
              }}
              className="mt-2 w-full rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Submit
            </button>
          ) : null}
          {error ? <p className="mt-1 text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The Research tab — renders the .research/ deliverables: directions, report, assets, sources. */
export function ResearchPanel({
  research,
  assetUrl,
  visualAssetUrl,
}: {
  research: ResearchDetail | null;
  assetUrl: (assetPath: string) => string;
  /** URL builder for VISUAL-track assets (separate from the product track's assetUrl). */
  visualAssetUrl?: (assetPath: string) => string;
}) {
  const [subTab, setSubTab] = useState<"product" | "visual">("product");
  if (!research?.exists) {
    return <div className="flex h-full items-center justify-center bg-surface p-6 text-center text-sm text-muted-foreground">No research for this project yet.</div>;
  }
  const directions = research.directions ?? [];
  const sources = research.sources ?? [];
  const assets = research.assets ?? [];
  const chosenSlug = research.chosenSlug;
  // Rewrite markdown image paths (assets/foo.png) to served URLs so the report renders图文并茂.
  const reportMd = (research.report ?? "").replace(/(!\[[^\]]*\]\()(?:\.\/)?(assets\/[^)\s]+)(\))/g, (_m, pre, path, post) => `${pre}${assetUrl(path)}${post}`);
  const visual = research.visual;
  const hasVisual = !!visual?.exists;
  const visualSources = visual?.sources ?? [];
  const visualAssets = visual?.assets ?? [];
  const visualReportMd = visualAssetUrl
    ? (visual?.report ?? "").replace(/(!\[[^\]]*\]\()(?:\.\/)?(assets\/[^)\s]+)(\))/g, (_m, pre, path, post) => `${pre}${visualAssetUrl(path)}${post}`)
    : (visual?.report ?? "");
  return (
    <div className="h-full overflow-auto bg-surface">
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        {hasVisual ? (
          <div role="tablist" aria-label="Research track" className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            <button
              type="button"
              role="tab"
              aria-selected={subTab === "product"}
              onClick={() => setSubTab("product")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                subTab === "product" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Product
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subTab === "visual"}
              onClick={() => setSubTab("visual")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                subTab === "visual" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Visual
            </button>
          </div>
        ) : null}
        {subTab === "visual" && hasVisual ? (
          <>
            {/* Moodboard at the TOP of the Visual tab: it's the headline, and being immediately
                visible + properly sized on tab-open lets the canvas fit-to-content and pan/zoom
                (a below-the-fold mount inits at 0 size → empty, non-interactive canvas). */}
            <div data-testid="visual-moodboard-mount">
              {visual?.boardId ? (
                <Suspense fallback={null}>
                  <VisualResearchBoard boardId={visual.boardId} />
                </Suspense>
              ) : null}
            </div>
            {visualReportMd ? (
              <section className="rounded-lg border border-border bg-card p-4">
                <Markdown className="space-y-2 text-sm text-foreground [&_img]:my-2 [&_img]:rounded-md [&_img]:border [&_img]:border-border">{visualReportMd}</Markdown>
              </section>
            ) : null}
            {visualAssets.length ? (
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Collected imagery · {visualAssets.length}</h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {visualAssets.map((a) => (
                    <a key={a} href={visualAssetUrl?.(a)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border bg-card transition hover:border-muted-foreground/40">
                      <img src={visualAssetUrl?.(a)} alt={a} loading="lazy" className="aspect-video w-full object-cover" />
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
            {visualSources.length ? (
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sources · {visualSources.length}</h3>
                <ul className="space-y-1.5">
                  {visualSources.map((s, index) => (
                    <li key={s.id ?? index} className="flex items-baseline gap-2 text-[13px]">
                      {s.platform ? <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{s.platform}</span> : null}
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">
                          {s.title || s.url}
                        </a>
                      ) : (
                        <span className="truncate text-foreground">{s.title || "source"}</span>
                      )}
                      {s.designer ? <span className="shrink-0 text-muted-foreground">{s.designer}</span> : null}
                      <span
                        className={cn(
                          "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          s.reached === false ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
                        )}
                      >
                        {s.reached === false ? "blocked" : "reached"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
        {subTab === "product" && directions.length ? (
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
                    className={cn("group rounded-lg border bg-card", selected ? "border-primary/50" : "border-border")}
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
        {subTab === "product" && reportMd ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <Markdown className="space-y-2 text-sm text-foreground [&_img]:my-2 [&_img]:rounded-md [&_img]:border [&_img]:border-border">{reportMd}</Markdown>
          </section>
        ) : null}
        {subTab === "product" && assets.length ? (
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
        {subTab === "product" && sources.length ? (
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
