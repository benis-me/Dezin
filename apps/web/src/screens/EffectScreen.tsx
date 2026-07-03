import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { EffectDetail } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { Button, Loading } from "../components/ui/index.ts";
import { EffectAgentPanel } from "../effects/EffectAgentPanel.tsx";
import { EffectParameterPanel } from "../effects/EffectParameterPanel.tsx";
import { EffectPreviewCanvas, type EffectPreviewHandle } from "../effects/EffectPreviewCanvas.tsx";
import { defaultValues, type EffectValues } from "../effects/effect-renderer.ts";
import { panelPercentFromPixels, readStoredPanelPercent, RESIZE_SEPARATOR_CLASS, savePanelFraction, twoPanelLayout } from "../lib/panel-layout.ts";

const EFFECT_AGENT_PANEL = "agent";
const EFFECT_PLAYGROUND_PANEL = "playground";
const EFFECT_PREVIEW_PANEL = "preview";
const EFFECT_PARAMETERS_PANEL = "parameters";
const EFFECT_AGENT_WIDTH_KEY = "dezin.effect.agent.width";
const EFFECT_PARAMETERS_WIDTH_KEY = "dezin.effect.parameters.width";

export function EffectScreen({ effectId, onBack }: { effectId: string; onBack: () => void }) {
  const api = useApi();
  const windowWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const agentPercent =
    readStoredPanelPercent(EFFECT_AGENT_WIDTH_KEY, 18, 42) ??
    panelPercentFromPixels(336, windowWidth, 24, 18, 42);
  const parametersPercent =
    readStoredPanelPercent(EFFECT_PARAMETERS_WIDTH_KEY, 20, 44) ??
    panelPercentFromPixels(320, Math.max(0, windowWidth - 336), 28, 20, 44);
  const [effect, setEffect] = useState<EffectDetail | null>(null);
  const [values, setValues] = useState<EffectValues>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<EffectPreviewHandle>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    setEffect(null);
    api
      .getEffect(effectId)
      .then((item) => {
        if (!alive) return;
        setEffect(item);
        setValues(defaultValues(item));
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "failed to load"));
    return () => {
      alive = false;
    };
  }, [api, effectId]);

  useEffect(() => {
    if (!effect || effect.origin !== "custom") return;
    const timer = window.setTimeout(() => {
      setSaving(true);
      api
        .updateEffect(effect.id, {
          name: effect.name,
          category: effect.category,
          summary: effect.summary,
          code: effect.code,
          parameters: effect.parameters,
          presets: effect.presets,
        })
        .catch(() => {})
        .finally(() => setSaving(false));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [api, effect]);

  const normalizedValues = useMemo(() => (effect ? { ...defaultValues(effect), ...values } : values), [effect, values]);

  if (error) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-sm text-center">
          <Sparkles className="mx-auto text-muted-foreground" size={24} strokeWidth={1.75} />
          <p className="mt-3 text-sm text-destructive">Couldn't load effect: {error}</p>
          <Button className="mt-4" variant="outline" onClick={onBack}>
            Back to effects
          </Button>
        </div>
      </div>
    );
  }

  if (!effect) {
    return (
      <div className="grid h-full place-items-center">
        <Loading label="Loading effect..." />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full bg-background">
      <Group
        id="dezin-effect-layout"
        className="min-h-0 flex-1"
        defaultLayout={twoPanelLayout(EFFECT_AGENT_PANEL, agentPercent, EFFECT_PLAYGROUND_PANEL)}
        onLayoutChanged={(layout) => savePanelFraction(EFFECT_AGENT_WIDTH_KEY, layout, EFFECT_AGENT_PANEL)}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
      >
        <Panel id={EFFECT_AGENT_PANEL} minSize="280px" maxSize="520px" defaultSize={agentPercent} groupResizeBehavior="preserve-pixel-size">
          <EffectAgentPanel effect={effect} values={normalizedValues} onValuesChange={setValues} onBack={onBack} />
        </Panel>
        <Separator aria-label="Resize effect agent panel" className={RESIZE_SEPARATOR_CLASS} />
        <Panel id={EFFECT_PLAYGROUND_PANEL} minSize="640px">
          <div className="flex h-full min-w-0 flex-col">
            <div className="app-drag flex h-10 shrink-0 items-center justify-end gap-3 border-b border-border bg-background px-4">
              {saving ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  Saving
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Export image"
                className="app-no-drag gap-2"
                onClick={() => previewRef.current?.exportPng(effect.name)}
              >
                <Download size={14} strokeWidth={1.8} />
                Export image
              </Button>
            </div>

            <Group
              id="dezin-effect-playground-layout"
              className="min-h-0 flex-1 bg-surface"
              defaultLayout={twoPanelLayout(EFFECT_PREVIEW_PANEL, 100 - parametersPercent, EFFECT_PARAMETERS_PANEL)}
              onLayoutChanged={(layout) => savePanelFraction(EFFECT_PARAMETERS_WIDTH_KEY, layout, EFFECT_PARAMETERS_PANEL)}
              resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
            >
              <Panel id={EFFECT_PREVIEW_PANEL} minSize="360px">
                <section aria-label="Effect preview" className="grid h-full min-h-0 place-items-center p-6">
                  <div className="aspect-square w-full max-w-[min(72vh,720px)]">
                    <EffectPreviewCanvas ref={previewRef} effect={effect} values={normalizedValues} />
                  </div>
                </section>
              </Panel>
              <Separator aria-label="Resize effect parameters panel" className={RESIZE_SEPARATOR_CLASS} />
              <Panel id={EFFECT_PARAMETERS_PANEL} minSize="280px" maxSize="460px" defaultSize={parametersPercent} groupResizeBehavior="preserve-pixel-size">
                <EffectParameterPanel
                  effect={effect}
                  values={normalizedValues}
                  onValuesChange={setValues}
                  onEffectChange={(next) => {
                    setEffect(next);
                    setValues((current) => ({ ...defaultValues(next), ...current }));
                  }}
                />
              </Panel>
            </Group>
          </div>
        </Panel>
      </Group>
    </div>
  );
}
