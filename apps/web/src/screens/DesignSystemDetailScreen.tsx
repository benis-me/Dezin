import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Check, Wand2, Palette, Type as TypeIcon, Ruler, Component, BookOpen } from "lucide-react";
import { Badge, Button, Loading, ResizeHandle } from "../components/ui/index.ts";
import { Markdown } from "../components/Markdown.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { navigate } from "../router.tsx";
import { setPendingComposer } from "../lib/pending-composer.ts";
import { groupTokens, scopedTokens, tokenScope, type Token } from "../lib/ds-tokens.ts";
import type { DesignSystemDetail } from "../lib/api.ts";

const NAV = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "colors", label: "Colors", icon: Palette },
  { id: "type", label: "Type", icon: TypeIcon },
  { id: "scale", label: "Spacing & Radii", icon: Ruler },
  { id: "components", label: "Components", icon: Component },
];

function stripFrontHeading(md: string): string {
  return md.replace(/^#\s+\S.*\n+(>\s.*\n+)?/, "").trim();
}

function Swatch({ token }: { token: Token }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="h-16 w-full" style={{ background: token.value }} />
      <div className="border-t border-border px-2.5 py-2">
        <div className="truncate font-mono text-[11px] text-foreground">--{token.name}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">{token.value}</div>
      </div>
    </div>
  );
}

function Section({ id, label, icon: Icon, children }: { id: string; label: string; icon: typeof Palette; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="label-mono mb-4 flex items-center gap-2">
        <Icon size={13} strokeWidth={2} />
        {label}
      </div>
      {children}
    </section>
  );
}

export function DesignSystemDetailScreen({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const api = useApi();
  const { toast } = useToast();
  const [detail, setDetail] = useState<DesignSystemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState("overview");
  const scrollRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [navSplit, setNavSplit] = useState(0.18);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    api
      .getDesignSystem(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "failed to load"));
    return () => {
      alive = false;
    };
  }, [api, id]);

  const scope = useMemo(() => (detail ? tokenScope(detail.id) : ""), [detail]);
  const groups = useMemo(() => (detail ? groupTokens(detail.tokensCss) : null), [detail]);

  // Scroll-spy: highlight the nav item for the section in view.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { root, rootMargin: "-10% 0px -70% 0px", threshold: 0 },
    );
    NAV.forEach((n) => {
      const el = root.querySelector(`#${n.id}`);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [detail]);

  const setDefault = async (): Promise<void> => {
    if (!detail) return;
    try {
      await api.updateSettings({ defaultDesignSystemId: detail.id });
      toast(`Set ${detail.name} as the default style.`);
    } catch {
      toast("Couldn't update the default.", { variant: "error" });
    }
  };

  const generateWith = (): void => {
    if (!detail) return;
    setPendingComposer({ designSystemId: detail.id });
    navigate("/");
  };

  const goTo = (sid: string): void => {
    scrollRef.current?.querySelector(`#${sid}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (error) return <div className="grid h-full place-items-center text-sm text-destructive">Couldn't load: {error}</div>;
  if (!detail || !groups) return <Loading label="Loading design system…" />;

  const colorOrder = ["bg", "surface", "surface-2", "fg", "fg-2", "muted", "border", "border-strong", "accent", "accent-fg", "success", "warn", "danger"];
  const sortedColors = [...groups.colors].sort((a, b) => {
    const ai = colorOrder.indexOf(a.name);
    const bi = colorOrder.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <style dangerouslySetInnerHTML={{ __html: scopedTokens(detail.tokensCss, scope) }} />
      {/* Top bar */}
      <div
        className={`flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4 ${
          embedded ? "pr-12" : "app-drag"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {embedded ? null : (
            <button
              type="button"
              aria-label="Back to design systems"
              onClick={() => navigate("/design-systems")}
              className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
          )}
          <h1 className="truncate text-sm font-semibold tracking-tight">{detail.name}</h1>
          <Badge variant="outline">{detail.category}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void setDefault()}>
            <Check size={14} strokeWidth={2} />
            Set default
          </Button>
          <Button size="sm" onClick={generateWith}>
            <Wand2 size={14} strokeWidth={2} />
            Generate with this
          </Button>
        </div>
      </div>

      <div ref={splitRef} className="flex min-h-0 flex-1">
        {/* Left nav */}
        <nav
          aria-label="Spec sections"
          style={{ width: `${navSplit * 100}%` }}
          className="hidden min-w-[170px] shrink-0 flex-col gap-0.5 p-3 sm:flex"
        >
          {NAV.map((n) => {
            const Icon = n.icon;
            const on = active === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => goTo(n.id)}
                aria-current={on ? "true" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  on ? "bg-surface-2 font-medium text-foreground" : "text-muted-foreground hover:bg-surface-2/60 hover:text-foreground"
                }`}
              >
                <Icon size={15} strokeWidth={1.75} className={on ? "text-brand" : ""} />
                {n.label}
              </button>
            );
          })}
        </nav>

        <ResizeHandle containerRef={splitRef} onResize={setNavSplit} min={0.12} max={0.32} />

        {/* Right content */}
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
          <div className="max-w-7xl space-y-12 px-8 py-8">
            <Section id="overview" label="Overview" icon={BookOpen}>
              <p className="max-w-prose text-[15px] leading-relaxed text-foreground-2">{detail.summary}</p>
              {/* Brand lockup on light + dark */}
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {(["light", "dark"] as const).map((m) => (
                  <div key={m} className="overflow-hidden rounded-xl border border-border">
                    <div
                      className={`${scope} grid h-28 place-items-center`}
                      style={{ background: m === "dark" ? "var(--fg)" : "var(--bg)", color: m === "dark" ? "var(--bg)" : "var(--fg)" }}
                    >
                      <span className="text-2xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
                        {detail.name}
                      </span>
                    </div>
                    <div className="label-mono border-t border-border px-3 py-1.5">On {m}</div>
                  </div>
                ))}
              </div>
              {stripFrontHeading(detail.designMd) ? (
                <div className="mt-6 border-t border-border pt-6">
                  <Markdown>{stripFrontHeading(detail.designMd)}</Markdown>
                </div>
              ) : null}
            </Section>

            <Section id="colors" label="Colors" icon={Palette}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                {sortedColors.map((t) => (
                  <Swatch key={t.name} token={t} />
                ))}
              </div>
            </Section>

            <Section id="type" label="Type" icon={TypeIcon}>
              <div className={`${scope} space-y-5 rounded-xl border border-border p-6`} style={{ background: "var(--bg)", color: "var(--fg)" }}>
                <div>
                  <div className="label-mono mb-1.5 !text-current opacity-50">Display · {groups.fonts.display}</div>
                  <div className="text-4xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
                    The spec is the source of truth.
                  </div>
                </div>
                <div>
                  <div className="label-mono mb-1.5 !text-current opacity-50">Body · {groups.fonts.body}</div>
                  <p className="max-w-prose text-[15px] leading-relaxed" style={{ fontFamily: "var(--font-body)", color: "var(--fg-2, var(--fg))" }}>
                    A design system is a contract: tokens, type, and components a team agrees to. The quick brown fox jumps over the lazy dog — 0123456789.
                  </p>
                </div>
                <div>
                  <div className="label-mono mb-1.5 !text-current opacity-50">Mono · {groups.fonts.mono}</div>
                  <code className="text-sm" style={{ fontFamily: "var(--font-mono)" }}>
                    const accent = var(--accent);
                  </code>
                </div>
              </div>
            </Section>

            <Section id="scale" label="Spacing & Radii" icon={Ruler}>
              <div className="grid gap-8 sm:grid-cols-2">
                <div>
                  <div className="label-mono mb-3">Spacing</div>
                  <div className="space-y-2">
                    {groups.spacing.map((t) => (
                      <div key={t.name} className="flex items-center gap-3">
                        <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">--{t.name}</span>
                        <span className="h-3 rounded-sm bg-brand/70" style={{ width: t.value }} />
                        <span className="font-mono text-[11px] text-foreground-2">{t.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="label-mono mb-3">Radii</div>
                  <div className="flex flex-wrap gap-4">
                    {groups.radii.map((t) => (
                      <div key={t.name} className="text-center">
                        <span className="block size-14 border border-border-strong bg-surface-2" style={{ borderRadius: t.value }} />
                        <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground">{t.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            <Section id="components" label="Components" icon={Component}>
              <div className={`${scope} space-y-5 rounded-xl border border-border p-6`} style={{ background: "var(--bg)", color: "var(--fg)" }}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button className="h-9 px-4 text-sm font-medium" style={{ background: "var(--accent)", color: "var(--accent-fg, #fff)", borderRadius: "var(--radius, 8px)" }}>
                    Primary
                  </button>
                  <button className="h-9 px-4 text-sm font-medium" style={{ background: "var(--surface-2, var(--surface))", color: "var(--fg)", borderRadius: "var(--radius, 8px)" }}>
                    Secondary
                  </button>
                  <button className="h-9 px-4 text-sm font-medium" style={{ border: "1px solid var(--border)", color: "var(--fg)", borderRadius: "var(--radius, 8px)" }}>
                    Outline
                  </button>
                  <span className="px-2.5 py-1 text-xs font-medium" style={{ background: "var(--accent)", color: "var(--accent-fg, #fff)", borderRadius: "999px" }}>
                    Badge
                  </span>
                  <span className="px-2.5 py-1 text-xs" style={{ border: "1px solid var(--border)", color: "var(--muted, var(--fg))", borderRadius: "999px" }}>
                    Tag pill
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    readOnly
                    placeholder="you@company.com"
                    className="h-9 px-3 text-sm outline-none"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--fg)", borderRadius: "var(--radius, 8px)" }}
                  />
                  <div className="px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius, 8px)" }}>
                    <div className="text-sm font-semibold">Project tile</div>
                    <div className="text-xs" style={{ color: "var(--muted, var(--fg))" }}>
                      A card built from the system's surface + border.
                    </div>
                  </div>
                </div>
                <div className="flex items-end gap-1.5 px-1" style={{ height: 64 }}>
                  {[40, 65, 30, 80, 55, 70, 48].map((h, i) => (
                    <span key={i} className="flex-1 rounded-sm" style={{ height: `${h}%`, minHeight: 6, background: "var(--accent)", opacity: 0.35 + i * 0.09 }} />
                  ))}
                </div>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
