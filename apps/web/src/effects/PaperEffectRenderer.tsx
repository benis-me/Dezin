import type { ComponentType, CSSProperties } from "react";
import {
  Dithering,
  DotGrid,
  FlutedGlass,
  GemSmoke,
  GodRays,
  GrainGradient,
  HalftoneCmyk,
  HalftoneDots,
  Heatmap,
  ImageDithering,
  LiquidMetal,
  MeshGradient,
  Metaballs,
  NeuroNoise,
  PaperTexture,
  ShaderMount,
  SimplexNoise,
  SmokeRing,
  StaticMeshGradient,
  StaticRadialGradient,
  Water,
} from "@paper-design/shaders-react";
import type { EffectDetail, EffectParamDefinition, EffectParamValue } from "../lib/api.ts";
import type { EffectValues } from "./effect-renderer.ts";

type PaperComponent = ComponentType<Record<string, unknown>>;
type ShaderUniformValue = string | boolean | number | number[] | number[][] | HTMLImageElement | undefined;

function paper(component: unknown): PaperComponent {
  return component as PaperComponent;
}

const PAPER_COMPONENTS: Record<string, PaperComponent> = {
  "paper-texture": paper(PaperTexture),
  "fluted-glass": paper(FlutedGlass),
  water: paper(Water),
  "image-dithering": paper(ImageDithering),
  "halftone-dots": paper(HalftoneDots),
  "halftone-cmyk": paper(HalftoneCmyk),
  heatmap: paper(Heatmap),
  "liquid-metal": paper(LiquidMetal),
  "gem-smoke": paper(GemSmoke),
  "mesh-gradient": paper(MeshGradient),
  "static-mesh-gradient": paper(StaticMeshGradient),
  "static-radial-gradient": paper(StaticRadialGradient),
  dithering: paper(Dithering),
  "grain-gradient": paper(GrainGradient),
  "dot-grid": paper(DotGrid),
  "neuro-noise": paper(NeuroNoise),
  "simplex-noise": paper(SimplexNoise),
  "god-rays": paper(GodRays),
  "smoke-ring": paper(SmokeRing),
  metaballs: paper(Metaballs),
};

const shaderStyle: CSSProperties = {
  width: "100%",
  height: "100%",
};

function isJsdom(): boolean {
  return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
}

export function isPaperEffect(effect: Pick<EffectDetail, "origin" | "code" | "id">): boolean {
  return effect.origin === "built-in" && effect.code === `@paper-design/shaders-react:${effect.id}`;
}

export function isGlslEffect(effect: Pick<EffectDetail, "code">): boolean {
  return effect.code.trim().startsWith("#version 300 es");
}

function componentProps(values: EffectValues): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const colors: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    const colorIndex = /^colors\.(\d+)$/.exec(key);
    if (colorIndex) {
      colors[Number(colorIndex[1])] = String(value);
      continue;
    }
    props[key] = value;
  }

  const compactColors = colors.filter(Boolean);
  if (compactColors.length) props.colors = compactColors;
  return props;
}

function hexToRgba(value: string): [number, number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = hex.split("").map((part) => Number.parseInt(`${part}${part}`, 16) / 255);
    return [r ?? 0, g ?? 0, b ?? 0, 1];
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
    const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
    const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
    const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  return null;
}

function uniformName(id: string): string {
  return `u_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function uniformsFromValues(parameters: EffectParamDefinition[], values: EffectValues): Record<string, ShaderUniformValue> {
  const uniforms: Record<string, ShaderUniformValue> = {};
  for (const param of parameters) {
    const value = values[param.id] ?? param.defaultValue;
    if (param.type === "color" && typeof value === "string") {
      uniforms[uniformName(param.id)] = hexToRgba(value) ?? [0, 0, 0, 1];
    } else if (param.type === "image" && typeof value === "string") {
      uniforms[uniformName(param.id)] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      uniforms[uniformName(param.id)] = value;
    }
  }
  return uniforms;
}

function numberValue(value: EffectParamValue | undefined, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function PaperEffectRenderer({ effect, values }: { effect: EffectDetail; values: EffectValues }) {
  if (isJsdom()) {
    return <div data-testid="paper-effect-preview" className="h-full w-full bg-surface" />;
  }

  if (isPaperEffect(effect)) {
    const Component = PAPER_COMPONENTS[effect.id];
    if (!Component) return <div className="h-full w-full bg-surface" />;
    return <Component {...componentProps(values)} style={shaderStyle} maxPixelCount={1920 * 1920} />;
  }

  if (isGlslEffect(effect)) {
    return (
      <ShaderMount
        fragmentShader={effect.code}
        uniforms={uniformsFromValues(effect.parameters, values)}
        speed={numberValue(values.speed, 1)}
        style={shaderStyle}
        maxPixelCount={1920 * 1920}
      />
    );
  }

  return null;
}
