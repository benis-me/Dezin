import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Eye, EyeOff, Lock, LockOpen, WandSparkles } from "lucide-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { Button, Input, Textarea } from "../components/ui/index.ts";
import {
  assetUrl,
  dataName,
  fileName,
  generatorPrompt,
  generatorStatus,
  isNodeLocked,
  isNodeVisible,
  layerLabel,
  nodeFill,
  nodeStroke,
  nodeText,
  nodeTitle,
  numberFromEvent,
  promptText,
} from "./canvas-utils.ts";

const PANEL_WIDTH_KEY = "dezin:moodboard:properties-width";
const DEFAULT_PANEL_WIDTH = 280;
const MIN_PANEL_WIDTH = 248;
const MAX_PANEL_WIDTH = 440;

export function MoodboardPropertiesPanel({
  node,
  onPatch,
  onPatchData,
  onGenerate,
}: {
  node: MoodboardNode;
  onPatch: (patch: Partial<SaveMoodboardNodeInput>) => void;
  onPatchData: (patch: Record<string, unknown>) => void;
  onGenerate: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(() => {
    const storedValue = localStorage.getItem(PANEL_WIDTH_KEY);
    if (storedValue == null) return DEFAULT_PANEL_WIDTH;
    const stored = Number(storedValue);
    return Number.isFinite(stored) ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, stored)) : DEFAULT_PANEL_WIDTH;
  });

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(width));
  }, [width]);

  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;

      const onMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        setWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + delta)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width],
  );

  return (
    <motion.aside
      data-moodboard-floating-occluder
      className="app-no-drag absolute right-3 top-3 z-20 max-h-[calc(100%-5rem)] select-none overflow-auto rounded-md border border-border bg-card/95 text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl"
      style={{ width }}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 8 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 8 }}
      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
    >
      <div
        role="separator"
        aria-label="Resize properties panel"
        aria-orientation="vertical"
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize"
        onMouseDown={startResize}
      />
      <div className="flex h-10 items-center justify-between gap-3 border-b border-border/70 px-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{layerLabel(node)}</p>
          <p className="label-mono text-muted-foreground">{formatNodeType(node.type)}</p>
        </div>
        <span className="label-mono shrink-0 text-muted-foreground">#{Math.round(node.zIndex ?? 0)}</span>
      </div>
      <PropertySection title="Object">
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Name</span>
            <Input
              aria-label="Layer name"
              value={dataName(node)}
              placeholder={layerLabel(node)}
              onChange={(event) => onPatchData({ name: event.target.value })}
              className="h-8 text-xs"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <StateButton active={isNodeVisible(node)} label={isNodeVisible(node) ? "Visible" : "Hidden"} onClick={() => onPatchData({ visible: !isNodeVisible(node) })}>
              {isNodeVisible(node) ? <Eye size={13} strokeWidth={1.75} /> : <EyeOff size={13} strokeWidth={1.75} />}
            </StateButton>
            <StateButton active={isNodeLocked(node)} label={isNodeLocked(node) ? "Locked" : "Unlocked"} onClick={() => onPatchData({ locked: !isNodeLocked(node) })}>
              {isNodeLocked(node) ? <Lock size={13} strokeWidth={1.75} /> : <LockOpen size={13} strokeWidth={1.75} />}
            </StateButton>
          </div>
        </div>
      </PropertySection>
      <PropertySection title="Position">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={node.x} onChange={(value) => onPatch({ x: value })} />
          <NumberField label="Y" value={node.y} onChange={(value) => onPatch({ y: value })} />
          <NumberField label="W" value={node.width} onChange={(value) => onPatch({ width: Math.max(40, value) })} />
          <NumberField label="H" value={node.height} onChange={(value) => onPatch({ height: Math.max(40, value) })} />
          <NumberField label="R" value={node.rotation ?? 0} onChange={(value) => onPatch({ rotation: value })} />
          <NumberField label="Z" value={node.zIndex ?? 0} onChange={(value) => onPatch({ zIndex: value })} />
        </div>
      </PropertySection>
      <PropertySection title="Layout">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <ReadonlyValue label="Size" value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
          <ReadonlyValue label="Ratio" value={formatRatio(node.width, node.height)} />
          <ReadonlyValue label="Rotation" value={`${Math.round(node.rotation ?? 0)} deg`} />
          <ReadonlyValue label="Layer" value={String(Math.round(node.zIndex ?? 0))} />
        </div>
      </PropertySection>
      <PropertySection title="Content">
        {node.type === "note" ? (
          <Textarea value={nodeText(node)} onChange={(event) => onPatchData({ content: event.target.value })} className="min-h-28 resize-none text-xs" />
        ) : node.type === "section" ? (
          <Input value={nodeTitle(node)} onChange={(event) => onPatchData({ title: event.target.value })} className="h-8 text-xs" />
        ) : node.type === "image-generator" ? (
          <div className="space-y-2">
            <Textarea
              value={generatorPrompt(node)}
              onChange={(event) => onPatchData({ generatorPrompt: event.target.value, generatorStatus: event.target.value ? "ready" : "" })}
              className="min-h-24 resize-none text-xs"
            />
            <Button size="sm" variant="outline" className="h-7 w-full gap-2 text-xs" onClick={onGenerate} disabled={!generatorPrompt(node).trim()}>
              <WandSparkles size={13} strokeWidth={1.75} />
              Generate
            </Button>
          </div>
        ) : node.type === "image" ? (
          <div className="space-y-2">
            {assetUrl(node) ? (
              <img src={assetUrl(node)} alt={fileName(node) || "Moodboard image"} className="max-h-36 w-full rounded-md border border-border object-contain" />
            ) : null}
            <Input value={fileName(node) || "Generated image"} readOnly className="h-8 text-xs" />
            {promptText(node) ? <Textarea value={promptText(node)} readOnly className="min-h-20 resize-none text-xs text-muted-foreground" /> : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Video node metadata will appear here once video generation is enabled.</p>
        )}
      </PropertySection>
      <PropertySection title="Appearance">
        <div className="space-y-2 text-xs">
          <ColorValue label="Fill" value={nodeFill(node)} onChange={(value) => onPatchData({ fill: value })} />
          <ColorValue label="Stroke" value={nodeStroke(node)} onChange={(value) => onPatchData({ stroke: value })} />
          {node.type === "image-generator" ? <ReadonlyValue label="Status" value={generatorStatus(node) || "ready"} /> : null}
          <ReadonlyValue label="Updated" value={formatDate(node.updatedAt)} />
        </div>
      </PropertySection>
    </motion.aside>
  );
}

function formatNodeType(type: MoodboardNode["type"]): string {
  if (type === "image-generator") return "Image generator";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatRatio(width: number, height: number): string {
  if (!width || !height) return "Free";
  const ratio = width / height;
  if (!Number.isFinite(ratio)) return "Free";
  return `${ratio.toFixed(2)}:1`;
}

function formatDate(value: number): string {
  if (!value) return "Unknown";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PropertySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-3 last:border-b-0">
      <h3 className="mb-2 text-xs font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-xs text-muted-foreground">
      <span className="w-3 shrink-0">{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        onChange={(event) => onChange(numberFromEvent(event.target.value, value))}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
      />
    </label>
  );
}

function ColorValue({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <span className="size-4 shrink-0 rounded border border-border" style={{ background: value }} />
      <input value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none" />
    </label>
  );
}

function ReadonlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-[11px]">{value}</span>
    </div>
  );
}

function StateButton({ active, label, children, onClick }: { active: boolean; label: string; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs text-foreground transition-colors hover:bg-accent/60"
      aria-pressed={active}
    >
      {children}
      <span className="truncate">{label}</span>
    </button>
  );
}
