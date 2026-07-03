import { useMemo, useState } from "react";
import { Plus, Save, Trash2, Upload } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { EffectDetail, EffectParamDefinition, EffectParamValue, EffectPreset } from "../lib/api.ts";
import { Button, Input, Picker, Switch, Textarea } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { defaultValues, type EffectValues } from "./effect-renderer.ts";

function valueToNumber(value: EffectParamValue | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniquePresetId(name: string, existing: EffectPreset[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
  let id = base;
  let i = 2;
  while (existing.some((preset) => preset.id === id)) {
    id = `${base}-${i}`;
    i += 1;
  }
  return id;
}

function parameterJson(parameters: EffectParamDefinition[]): string {
  return JSON.stringify(parameters, null, 2);
}

function colorInputValue(value: string): string {
  const hex = value.trim();
  return /^#[0-9a-f]{6}/i.test(hex) ? hex.slice(0, 7) : "#000000";
}

function imageParamIds(parameters: EffectParamDefinition[]): string[] {
  return parameters.filter((param) => param.type === "image").map((param) => param.id);
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0;
  const text = String(step);
  if (text.includes("e-")) return Math.min(4, Number(text.split("e-")[1] ?? 2));
  return Math.min(4, text.split(".")[1]?.length ?? 2);
}

function formatNumber(value: number, step: number): string {
  const decimals = decimalsForStep(step);
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

function sliderProgress(value: number, min: number, max: number): string {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return "0%";
  const percent = Math.min(100, Math.max(0, ((value - min) / span) * 100));
  return `${percent}%`;
}

export function EffectParameterPanel({
  effect,
  values,
  onValuesChange,
  onEffectChange,
}: {
  effect: EffectDetail;
  values: EffectValues;
  onValuesChange: (values: EffectValues) => void;
  onEffectChange?: (effect: EffectDetail) => void;
}) {
  const [selectedPreset, setSelectedPreset] = useState(effect.presets[0]?.id ?? "default");
  const [parameterText, setParameterText] = useState(() => parameterJson(effect.parameters));
  const [parameterError, setParameterError] = useState<string | null>(null);
  const isCustom = effect.origin === "custom";
  const effectiveValues = useMemo(() => ({ ...defaultValues(effect), ...values }), [effect, values]);

  const updatePresetList = (presets: EffectPreset[]): void => {
    onEffectChange?.({ ...effect, presets });
  };

  const applyPreset = (presetId: string): void => {
    setSelectedPreset(presetId);
    const preset = effect.presets.find((item) => item.id === presetId);
    if (preset) {
      const nextValues = { ...defaultValues(effect), ...preset.values };
      for (const id of imageParamIds(effect.parameters)) {
        nextValues[id] = effectiveValues[id] ?? nextValues[id];
      }
      onValuesChange(nextValues);
    }
  };

  const addPreset = (): void => {
    const name = window.prompt("Preset name", "New preset")?.trim();
    if (!name) return;
    const nextPreset: EffectPreset = { id: uniquePresetId(name, effect.presets), name, values: { ...effectiveValues } };
    updatePresetList([...effect.presets, nextPreset]);
    setSelectedPreset(nextPreset.id);
  };

  const savePreset = (): void => {
    updatePresetList(effect.presets.map((preset) => (preset.id === selectedPreset ? { ...preset, values: { ...effectiveValues } } : preset)));
  };

  const deletePreset = (): void => {
    if (selectedPreset === "default") return;
    const next = effect.presets.filter((preset) => preset.id !== selectedPreset);
    updatePresetList(next);
    applyPreset(next[0]?.id ?? "default");
  };

  const updateParam = (id: string, value: EffectParamValue): void => {
    onValuesChange({ ...effectiveValues, [id]: value });
  };

  const updateParametersFromJson = (text: string): void => {
    setParameterText(text);
    try {
      const parsed = JSON.parse(text) as EffectParamDefinition[];
      if (!Array.isArray(parsed) || parsed.some((param) => !param || typeof param.id !== "string" || typeof param.label !== "string")) {
        throw new Error("Expected an array of parameter definitions.");
      }
      setParameterError(null);
      onEffectChange?.({ ...effect, parameters: parsed });
    } catch (error) {
      setParameterError(error instanceof Error ? error.message : "Invalid parameter JSON.");
    }
  };

  return (
    <section aria-label="Effect parameters" className="flex h-full min-h-0 flex-col bg-card">
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Parameters</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2.5">
        <ParameterRow name="preset">
          <div className="flex min-w-0 items-center gap-1">
            <Picker
              ariaLabel="Presets"
              value={selectedPreset}
              onChange={applyPreset}
              size="sm"
              className="h-8 min-w-0 flex-1"
              options={effect.presets.map((preset) => ({ label: preset.name, value: preset.id }))}
            />
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Add preset" onClick={addPreset}>
              <Plus size={13} strokeWidth={1.8} />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Save preset" onClick={savePreset}>
              <Save size={13} strokeWidth={1.8} />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Delete preset" onClick={deletePreset} disabled={selectedPreset === "default"}>
              <Trash2 size={13} strokeWidth={1.8} />
            </Button>
          </div>
        </ParameterRow>

        <div className="mt-2 space-y-0.5">
          {effect.parameters.map((param) => (
            <ParameterControl key={param.id} param={param} value={effectiveValues[param.id] ?? param.defaultValue} onChange={(value) => updateParam(param.id, value)} />
          ))}
        </div>

        {isCustom ? (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <div className="space-y-1.5">
              <label htmlFor="effect-code" className="label-mono">
                Code
              </label>
              <Textarea
                id="effect-code"
                value={effect.code}
                onChange={(event) => onEffectChange?.({ ...effect, code: event.target.value })}
                className="min-h-[190px] font-mono text-[12px] leading-relaxed"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="effect-parameters-json" className="label-mono">
                Parameter schema
              </label>
              <Textarea
                id="effect-parameters-json"
                value={parameterText}
                onChange={(event) => updateParametersFromJson(event.target.value)}
                className="min-h-[160px] font-mono text-[12px] leading-relaxed"
                spellCheck={false}
              />
              {parameterError ? <p className="text-xs text-destructive">{parameterError}</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ParameterRow({ name, children, title }: { name: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid min-h-8 grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 py-0.5">
      <div title={title ?? name} className="min-w-0 truncate font-mono text-xs leading-none text-foreground">
        {name}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ParameterControl({
  param,
  value,
  onChange,
}: {
  param: EffectParamDefinition;
  value: EffectParamValue;
  onChange: (value: EffectParamValue) => void;
}) {
  if (param.type === "boolean") {
    return (
      <ParameterRow name={param.id} title={param.label}>
        <div className="flex h-8 items-center justify-end">
          <Switch aria-label={param.label} checked={value === true} onCheckedChange={onChange} />
        </div>
      </ParameterRow>
    );
  }

  if (param.type === "image") {
    const image = typeof value === "string" ? value : String(param.defaultValue);
    const optionValues = new Set((param.options ?? []).map((option) => option.value));
    const selectedValue = optionValues.has(image) ? image : "__uploaded__";
    const pickerOptions = [
      ...(param.options ?? []),
      ...(!optionValues.has(image) && image ? [{ label: "Uploaded", value: "__uploaded__" }] : []),
    ];
    const inputId = `effect-image-${param.id}`;
    const readFile = (file: File): void => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") onChange(reader.result);
      };
      reader.readAsDataURL(file);
    };

    return (
      <ParameterRow name={param.id} title={param.label}>
        <div className="flex min-w-0 items-center gap-2">
          {image ? (
            <span
              aria-hidden
              className="h-8 w-10 shrink-0 rounded-md border border-border bg-surface-2 bg-cover bg-center"
              style={{ backgroundImage: `url(${image})` }}
            />
          ) : null}
          <Picker
            ariaLabel={param.label}
            value={selectedValue}
            onChange={(next) => {
              if (next !== "__uploaded__") onChange(next);
            }}
            size="sm"
            className="h-8 min-w-0 flex-1"
            options={pickerOptions}
          />
          <Button asChild variant="outline" size="icon-sm" className="h-8 w-8 rounded-md">
            <label htmlFor={inputId} aria-label={`Upload ${param.label}`} title={`Upload ${param.label}`} className="cursor-pointer">
              <Upload size={14} strokeWidth={1.8} />
            </label>
          </Button>
          <input
            id={inputId}
            aria-label={`Upload ${param.label}`}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) readFile(file);
              event.currentTarget.value = "";
            }}
          />
        </div>
      </ParameterRow>
    );
  }

  if (param.type === "color") {
    const color = typeof value === "string" ? value : String(param.defaultValue);
    return (
      <ParameterRow name={param.id} title={param.label}>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <label
            title={`${param.label} color`}
            data-testid={`effect-color-swatch-${param.id}`}
            className="group relative grid size-7 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md border border-input bg-surface-2 transition-[border-color,box-shadow] hover:border-border-strong has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/30"
          >
            <span
              aria-hidden
              className="absolute inset-[3px] rounded-sm shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--foreground)_14%,transparent)]"
              style={{ backgroundColor: colorInputValue(color) }}
            />
            <input
              aria-label={`${param.label} color picker`}
              type="color"
              value={colorInputValue(color)}
              onChange={(event) => onChange(event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
          <Input
            aria-label={param.label}
            value={color}
            onChange={(event) => onChange(event.target.value)}
            className="h-7 w-[5.35rem] rounded-md bg-surface-2 px-1.5 font-mono text-xs tabular-nums"
            spellCheck={false}
          />
        </div>
      </ParameterRow>
    );
  }

  if (param.type === "select") {
    return (
      <ParameterRow name={param.id} title={param.label}>
        <Picker
          ariaLabel={param.label}
          value={String(value)}
          onChange={onChange}
          size="sm"
          className="h-8 w-full"
          options={(param.options ?? []).map((option) => ({ label: option.label, value: option.value }))}
        />
      </ParameterRow>
    );
  }

  const min = typeof param.min === "number" ? param.min : 0;
  const max = typeof param.max === "number" ? param.max : 1;
  const step = typeof param.step === "number" ? param.step : 0.01;
  const num = valueToNumber(value, valueToNumber(param.defaultValue, min));
  const displayed = formatNumber(num, step);
  const progressStyle = { "--effect-param-progress": sliderProgress(num, min, max) } as CSSProperties;
  return (
    <ParameterRow name={param.id} title={param.label}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_3.45rem] items-center gap-1.5">
        <input
          aria-label={param.label}
          type="range"
          min={min}
          max={max}
          step={step}
          value={num}
          onChange={(event) => onChange(Number(event.target.value))}
          style={progressStyle}
          className={cn("effect-param-slider h-7 min-w-0", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30")}
        />
        <Input
          aria-label={`${param.label} value`}
          type="number"
          min={min}
          max={max}
          step={step}
          value={displayed}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          className="effect-param-number h-7 rounded-md bg-surface-2 px-1.5 text-right font-mono text-xs tabular-nums"
        />
      </div>
    </ParameterRow>
  );
}
