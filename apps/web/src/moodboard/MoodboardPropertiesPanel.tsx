import type { ReactNode } from "react";
import { WandSparkles } from "lucide-react";
import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { Button, Input, Textarea } from "../components/ui/index.ts";
import { fileName, generatorPrompt, nodeText, nodeTitle, numberFromEvent, promptText } from "./canvas-utils.ts";

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
  return (
    <aside className="app-no-drag absolute right-3 top-3 z-20 hidden max-h-[calc(100%-5rem)] w-64 select-none overflow-auto rounded-md border border-border bg-popover/95 text-popover-foreground shadow-pop backdrop-blur-xl lg:block">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium">Properties</span>
        <span className="label-mono">{node.type}</span>
      </div>
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
            <Input value={fileName(node) || "Generated image"} readOnly className="h-8 text-xs" />
            <Textarea value={promptText(node)} readOnly className="min-h-20 resize-none text-xs text-muted-foreground" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Video node metadata will appear here once video generation is enabled.</p>
        )}
      </PropertySection>
      <PropertySection title="Appearance">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Swatch label="Fill" value={node.type === "note" ? "#fff8c7" : node.type === "section" ? "transparent" : "#efefed"} />
          <Swatch label="Stroke" value={node.type === "section" ? "#cfcfca" : "#e7e7e2"} />
        </div>
      </PropertySection>
    </aside>
  );
}

function PropertySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-3">
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

function Swatch({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-2 p-2">
      <div className="flex items-center gap-1.5">
        <span className="size-3 shrink-0 rounded border border-border" style={{ background: value }} />
        <span className="truncate text-muted-foreground">{label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-foreground">{value}</p>
    </div>
  );
}
