export type EffectOrigin = "built-in" | "custom";
export type EffectParamKind = "number" | "color" | "select" | "boolean" | "image";
export type EffectParamValue = string | number | boolean;

export interface EffectParamOption {
  label: string;
  value: string;
}

export interface EffectParamDefinition {
  id: string;
  label: string;
  type: EffectParamKind;
  defaultValue: EffectParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: EffectParamOption[];
  description?: string;
}

export interface EffectPreset {
  id: string;
  name: string;
  values: Record<string, EffectParamValue>;
}

export interface EffectCard {
  id: string;
  name: string;
  origin: EffectOrigin;
  category: string;
  summary: string;
  previewUrl?: string;
}

export interface EffectDefinition extends EffectCard {
  parameters: EffectParamDefinition[];
  presets: EffectPreset[];
  code: string;
  createdAt?: number;
  updatedAt?: number;
}

const PAPER_EFFECT_ORDER = [
  "paper-texture",
  "fluted-glass",
  "water",
  "image-dithering",
  "halftone-dots",
  "halftone-cmyk",
  "heatmap",
  "liquid-metal",
  "gem-smoke",
  "mesh-gradient",
  "static-mesh-gradient",
  "static-radial-gradient",
  "dithering",
  "grain-gradient",
  "dot-grid",
  "neuro-noise",
  "simplex-noise",
  "god-rays",
  "smoke-ring",
  "metaballs",
] as const;

type PaperEffectId = (typeof PAPER_EFFECT_ORDER)[number];

type PaperPresetSpec = {
  name: string;
  values: Record<string, unknown>;
};

const DEFAULT_DEMO_IMAGE = "/effects/demo-landscape.jpg";

const DEMO_IMAGE_OPTIONS: EffectParamOption[] = [
  { label: "Landscape", value: DEFAULT_DEMO_IMAGE },
  { label: "Architecture", value: "/effects/demo-architecture.jpg" },
];

const IMAGE_EFFECT_IDS = new Set<PaperEffectId>([
  "paper-texture",
  "fluted-glass",
  "water",
  "image-dithering",
  "halftone-dots",
  "halftone-cmyk",
  "heatmap",
  "liquid-metal",
  "gem-smoke",
]);

const PAPER_PRESETS: Record<PaperEffectId, PaperPresetSpec[]> = {
  "paper-texture": [
    { name: "Default", values: { fit: "cover", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#9fadbc", colorBack: "#ffffff", contrast: 0.3, roughness: 0.4, fiber: 0.3, fiberSize: 0.2, crumples: 0.3, crumpleSize: 0.35, folds: 0.65, foldCount: 5, fade: 0, drops: 0.2, seed: 5.8 } },
    { name: "Cardboard", values: { fit: "cover", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#c7b89e", colorBack: "#999180", contrast: 0.4, roughness: 0, fiber: 0.35, fiberSize: 0.14, crumples: 0.7, crumpleSize: 0.1, folds: 0, foldCount: 1, fade: 0, drops: 0.1, seed: 1.6 } },
    { name: "Abstract", values: { fit: "cover", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#00eeff", colorBack: "#ff0a81", contrast: 0.85, roughness: 0, fiber: 0.1, fiberSize: 0.2, crumples: 0, crumpleSize: 0.3, folds: 1, foldCount: 3, fade: 0, drops: 0.2, seed: 2.2 } },
    { name: "Details", values: { fit: "cover", scale: 3, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#00000000", colorBack: "#00000000", contrast: 0, roughness: 1, fiber: 0.27, fiberSize: 0.22, crumples: 1, crumpleSize: 0.5, folds: 1, foldCount: 15, fade: 0, drops: 0, seed: 6 } },
  ],
  "fluted-glass": [
    { name: "Default", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#00000000", colorShadow: "#000000", colorHighlight: "#ffffff", shadows: 0.25, size: 0.5, angle: 0, distortionShape: "prism", highlights: 0.1, shape: "lines", distortion: 0.5, shift: 0, blur: 0, edges: 0.25, stretch: 0, margin: 0, marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, grainMixer: 0, grainOverlay: 0 } },
    { name: "Abstract", values: { fit: "cover", scale: 4, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#00000000", colorShadow: "#000000", colorHighlight: "#ffffff", shadows: 0, size: 0.7, angle: 30, distortionShape: "flat", highlights: 0, shape: "linesIrregular", distortion: 1, shift: 0, blur: 1, edges: 0.5, stretch: 1, margin: 0, marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, grainMixer: 0.1, grainOverlay: 0.1 } },
    { name: "Waves", values: { fit: "cover", scale: 1.2, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#00000000", colorShadow: "#000000", colorHighlight: "#ffffff", shadows: 0, size: 0.9, angle: 0, distortionShape: "contour", highlights: 0, shape: "wave", distortion: 0.5, shift: 0, blur: 0.1, edges: 0.5, stretch: 1, margin: 0, marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, grainMixer: 0, grainOverlay: 0.05 } },
    { name: "Folds", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#00000000", colorShadow: "#000000", colorHighlight: "#ffffff", shadows: 0.4, size: 0.4, angle: 0, distortionShape: "cascade", highlights: 0, shape: "lines", distortion: 0.75, shift: 0, blur: 0.25, edges: 0.5, stretch: 0, margin: 0.1, marginLeft: 0.1, marginRight: 0.1, marginTop: 0.1, marginBottom: 0.1, grainMixer: 0, grainOverlay: 0 } },
  ],
  water: [
    { name: "Default", values: { fit: "contain", scale: 0.8, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#909090", colorHighlight: "#ffffff", highlights: 0.07, layering: 0.5, edges: 0.8, waves: 0.3, caustic: 0.1, size: 1 } },
    { name: "Slow-mo", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.1, frame: 0, colorBack: "#909090", colorHighlight: "#ffffff", highlights: 0.4, layering: 0, edges: 0, waves: 0, caustic: 0.2, size: 0.7 } },
    { name: "Abstract", values: { fit: "cover", scale: 3, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#909090", colorHighlight: "#ffffff", highlights: 0, layering: 0, edges: 1, waves: 1, caustic: 0.4, size: 0.15 } },
    { name: "Streaming", values: { fit: "contain", scale: 0.4, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 2, frame: 0, colorBack: "#909090", colorHighlight: "#ffffff", highlights: 0, layering: 0, edges: 0, waves: 0.5, caustic: 0, size: 0.5 } },
  ],
  "image-dithering": [
    { name: "Default", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#94ffaf", colorBack: "#000c38", colorHighlight: "#eaff94", type: "8x8", size: 2, colorSteps: 2, originalColors: false, inverted: false } },
    { name: "Noise", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#a2997c", colorBack: "#000000", colorHighlight: "#ededed", type: "random", size: 1, colorSteps: 1, originalColors: false, inverted: false } },
    { name: "Retro", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#eeeeee", colorBack: "#5452ff", colorHighlight: "#eeeeee", type: "2x2", size: 3, colorSteps: 1, originalColors: true, inverted: false } },
    { name: "Natural", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorFront: "#ffffff", colorBack: "#000000", colorHighlight: "#ffffff", type: "8x8", size: 2, colorSteps: 5, originalColors: true, inverted: false } },
  ],
  "halftone-dots": [
    { name: "Default", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#f2f1e8", colorFront: "#2b2b2b", size: 0.5, radius: 1.25, contrast: 0.4, originalColors: false, inverted: false, grainMixer: 0.2, grainOverlay: 0.2, grainSize: 0.5, grid: "hex", type: "gooey" } },
    { name: "LED screen", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#000000", colorFront: "#29ff7b", size: 0.5, radius: 1.5, contrast: 0.3, originalColors: false, inverted: false, grainMixer: 0, grainOverlay: 0, grainSize: 0.5, grid: "square", type: "soft" } },
    { name: "Mosaic", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#000000", colorFront: "#b2aeae", size: 0.6, radius: 2, contrast: 0.01, originalColors: true, inverted: false, grainMixer: 0, grainOverlay: 0, grainSize: 0.5, grid: "hex", type: "classic" } },
    { name: "Round and square", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#141414", colorFront: "#ff8000", size: 0.8, radius: 1, contrast: 1, originalColors: false, inverted: true, grainMixer: 0.05, grainOverlay: 0.3, grainSize: 0.5, grid: "square", type: "holes" } },
  ],
  "halftone-cmyk": [
    { name: "Default", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#fbfaf5", colorC: "#00b4ff", colorM: "#fc519f", colorY: "#ffd800", colorK: "#231f20", size: 0.2, contrast: 1, softness: 1, grainSize: 0.5, grainMixer: 0, grainOverlay: 0, gridNoise: 0.2, floodC: 0.15, floodM: 0, floodY: 0, floodK: 0, gainC: 0.3, gainM: 0, gainY: 0.2, gainK: 0, type: "ink" } },
    { name: "Drops", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#eeefd7", colorC: "#00b2ff", colorM: "#fc4f4f", colorY: "#ffd900", colorK: "#231f20", size: 0.88, contrast: 1.15, softness: 0, grainSize: 0.01, grainMixer: 0.05, grainOverlay: 0.25, gridNoise: 0.5, floodC: 0.15, floodM: 0, floodY: 0, floodK: 0, gainC: 1, gainM: 0.44, gainY: -1, gainK: 0, type: "ink" } },
    { name: "Newspaper", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#f2f1e8", colorC: "#7a7a75", colorM: "#7a7a75", colorY: "#7a7a75", colorK: "#231f20", size: 0.01, contrast: 2, softness: 0.2, grainSize: 0, grainMixer: 0, grainOverlay: 0.2, gridNoise: 0.6, floodC: 0, floodM: 0, floodY: 0, floodK: 0.1, gainC: -0.17, gainM: -0.45, gainY: -0.45, gainK: 0, type: "dots" } },
    { name: "Vintage", values: { fit: "cover", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#fffaf0", colorC: "#59afc5", colorM: "#d8697c", colorY: "#fad85c", colorK: "#2d2824", size: 0.2, contrast: 1.25, softness: 0.4, grainSize: 0.5, grainMixer: 0.15, grainOverlay: 0.1, gridNoise: 0.45, floodC: 0.15, floodM: 0, floodY: 0, floodK: 0, gainC: 0.3, gainM: 0, gainY: 0.2, gainK: 0, type: "sharp" } },
  ],
  heatmap: [
    { name: "Default", values: { fit: "contain", scale: 0.75, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, contour: 0.5, angle: 0, noise: 0, innerGlow: 0.5, outerGlow: 0.5, colorBack: "#000000", colors: ["#11206a", "#1f3ba2", "#2f63e7", "#6bd7ff", "#ffe679", "#ff991e", "#ff4c00"] } },
    { name: "Sepia", values: { fit: "contain", scale: 0.75, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.5, frame: 0, contour: 0.5, angle: 0, noise: 0.75, innerGlow: 0.5, outerGlow: 0.5, colorBack: "#000000", colors: ["#997F45", "#ffffff"] } },
  ],
  "liquid-metal": [
    { name: "Default", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#AAAAAC", colorTint: "#ffffff", distortion: 0.07, repetition: 2, shiftRed: 0.3, shiftBlue: 0.3, contour: 0.4, softness: 0.1, angle: 70, shape: "diamond" } },
    { name: "Noir", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colorTint: "#606060", softness: 0.45, repetition: 1.5, shiftRed: 0, shiftBlue: 0, distortion: 0, contour: 0, angle: 90, shape: "diamond" } },
    { name: "Backdrop", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#AAAAAC", colorTint: "#ffffff", softness: 0.05, repetition: 1.5, shiftRed: 0.3, shiftBlue: 0.3, distortion: 0.1, contour: 0.4, shape: "none", angle: 90 } },
    { name: "Stripes", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colorTint: "#2c5d72", softness: 0.8, repetition: 6, shiftRed: 1, shiftBlue: -1, distortion: 0.4, contour: 0.4, shape: "circle", angle: 0 } },
  ],
  "gem-smoke": [
    { name: "Default", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#f0efea", colorInner: "#fafaf5", colors: ["#333333", "#e7e6df"], outerGlow: 0.55, innerGlow: 1, innerDistortion: 0.8, outerDistortion: 0.6, offset: 0, angle: 0, size: 0.8, shape: "diamond" } },
    { name: "Fire", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colorInner: "#000000", colors: ["#fe5b16", "#f7ff61", "#ffffff"], outerGlow: 1, innerGlow: 0.65, innerDistortion: 0.6, outerDistortion: 0.8, offset: 0, angle: 0, size: 0.8, shape: "diamond" } },
    { name: "Fluorescent", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colorInner: "#000000", colors: ["#2fb64c", "#cdff61", "#ffffff"], outerGlow: 0, innerGlow: 1, innerDistortion: 1, outerDistortion: 0.8, offset: 0, angle: 0, size: 0.8, shape: "diamond" } },
    { name: "Infrared", values: { fit: "contain", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.5, frame: 0, colorBack: "#cd28dc", colorInner: "#00000000", colors: ["#ff9900", "#fff67a", "#dcff52", "#00ffbb", "#0077ff"], outerGlow: 1, innerGlow: 1, innerDistortion: 1, outerDistortion: 1, offset: 0.2, angle: 0, size: 1, shape: "diamond" } },
  ],
  "mesh-gradient": [
    { name: "Default", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colors: ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"], distortion: 0.8, swirl: 0.1, grainMixer: 0, grainOverlay: 0 } },
    { name: "Ink", values: { fit: "contain", scale: 1, rotation: 90, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colors: ["#ffffff", "#000000"], distortion: 1, swirl: 0.2, grainMixer: 0, grainOverlay: 0 } },
    { name: "Purple", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.6, frame: 0, colors: ["#aaa7d7", "#3c2b8e"], distortion: 1, swirl: 1, grainMixer: 0, grainOverlay: 0 } },
    { name: "Beach", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.1, frame: 0, colors: ["#bcecf6", "#00aaff", "#00f7ff", "#ffd447"], distortion: 0.8, swirl: 0.35, grainMixer: 0, grainOverlay: 0 } },
  ],
  "static-mesh-gradient": [
    { name: "Default", values: { fit: "contain", scale: 1, rotation: 270, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colors: ["#ffad0a", "#6200ff", "#e2a3ff", "#ff99fd"], positions: 2, waveX: 1, waveXShift: 0.6, waveY: 1, waveYShift: 0.21, mixing: 0.93, grainMixer: 0, grainOverlay: 0 } },
    { name: "Sea", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colors: ["#013b65", "#03738c", "#a3d3ff", "#f2faef"], positions: 0, waveX: 0.53, waveXShift: 0, waveY: 0.95, waveYShift: 0.64, mixing: 0.5, grainMixer: 0, grainOverlay: 0 } },
    { name: "1960s", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colors: ["#000000", "#082400", "#b1aa91", "#8e8c15"], positions: 42, waveX: 0.45, waveXShift: 0, waveY: 1, waveYShift: 0, mixing: 0, grainMixer: 0.37, grainOverlay: 0.78 } },
    { name: "Sunset", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colors: ["#264653", "#9c2b2b", "#f4a261", "#ffffff"], positions: 0, waveX: 0.6, waveXShift: 0.7, waveY: 0.7, waveYShift: 0.7, mixing: 0.5, grainMixer: 0, grainOverlay: 0 } },
  ],
  "static-radial-gradient": [
    { name: "Default", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#000000", colors: ["#00bbff", "#00ffe1", "#ffffff"], radius: 0.8, focalDistance: 0.99, focalAngle: 0, falloff: 0.24, mixing: 0.5, distortion: 0, distortionShift: 0, distortionFreq: 12, grainMixer: 0, grainOverlay: 0 } },
    { name: "Lo-Fi", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#2e1f27", colors: ["#d72638", "#3f88c5", "#f49d37"], radius: 1, focalDistance: 0, focalAngle: 0, falloff: 0.9, mixing: 0.7, distortion: 0, distortionShift: 0, distortionFreq: 12, grainMixer: 1, grainOverlay: 0.5 } },
    { name: "Cross Section", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#3d348b", colors: ["#7678ed", "#f7b801", "#f18701", "#37a066"], radius: 1, focalDistance: 0, focalAngle: 0, falloff: 0, mixing: 0, distortion: 1, distortionShift: 0, distortionFreq: 12, grainMixer: 0, grainOverlay: 0 } },
    { name: "Radial", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0, frame: 0, colorBack: "#264653", colors: ["#9c2b2b", "#f4a261", "#ffffff"], radius: 1, focalDistance: 0, focalAngle: 0, falloff: 0, mixing: 1, distortion: 0, distortionShift: 0, distortionFreq: 12, grainMixer: 0, grainOverlay: 0 } },
  ],
  dithering: [
    { name: "Default", values: { fit: "none", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colorFront: "#00b2ff", shape: "sphere", type: "4x4", size: 2 } },
    { name: "Warp", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#301c2a", colorFront: "#56ae6c", shape: "warp", type: "4x4", size: 2.5 } },
    { name: "Sine Wave", values: { fit: "none", scale: 1.2, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#730d54", colorFront: "#00becc", shape: "wave", type: "4x4", size: 11 } },
    { name: "Ripple", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#603520", colorFront: "#c67953", shape: "ripple", type: "2x2", size: 3 } },
    { name: "Bugs", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colorFront: "#008000", shape: "dots", type: "random", size: 9 } },
    { name: "Swirl", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#00000000", colorFront: "#47a8e1", shape: "swirl", type: "8x8", size: 2 } },
  ],
  "grain-gradient": [
    { name: "Default", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colors: ["#7300ff", "#eba8ff", "#00bfff", "#2a00ff"], softness: 0.5, intensity: 0.5, noise: 0.25, shape: "corners" } },
    { name: "Wave", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000a0f", colors: ["#c4730b", "#bdad5f", "#d8ccc7"], softness: 0.7, intensity: 0.15, noise: 0.5, shape: "wave" } },
    { name: "Dots", values: { fit: "none", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#0a0000", colors: ["#6f0000", "#0080ff", "#f2ebc9", "#33cc33"], softness: 1, intensity: 1, noise: 0.7, shape: "dots" } },
    { name: "Truchet", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#0a0000", colors: ["#6f2200", "#eabb7c", "#39b523"], softness: 0, intensity: 0.2, noise: 1, shape: "truchet" } },
    { name: "Ripple", values: { fit: "contain", scale: 0.5, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#140a00", colors: ["#6f2d00", "#88ddae", "#2c0b1d"], softness: 0.5, intensity: 0.5, noise: 0.5, shape: "ripple" } },
    { name: "Blob", values: { fit: "contain", scale: 1.3, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#0f0e18", colors: ["#3e6172", "#a49b74", "#568c50"], softness: 0, intensity: 0.15, noise: 0.5, shape: "blob" } },
  ],
  "dot-grid": [
    { name: "Default", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, colorBack: "#000000", colorFill: "#ffffff", colorStroke: "#ffaa00", size: 2, gapX: 32, gapY: 32, strokeWidth: 0, sizeRange: 0, opacityRange: 0, shape: "circle" } },
    { name: "Triangles", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, colorBack: "#ffffff", colorFill: "#ffffff", colorStroke: "#808080", size: 5, gapX: 32, gapY: 32, strokeWidth: 1, sizeRange: 0, opacityRange: 0, shape: "triangle" } },
    { name: "Tree line", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, colorBack: "#f4fce7", colorFill: "#052e19", colorStroke: "#000000", size: 8, gapX: 20, gapY: 90, strokeWidth: 0, sizeRange: 1, opacityRange: 0.6, shape: "circle" } },
    { name: "Wallpaper", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, colorBack: "#204030", colorFill: "#000000", colorStroke: "#bd955b", size: 9, gapX: 32, gapY: 32, strokeWidth: 1, sizeRange: 0, opacityRange: 0, shape: "diamond" } },
  ],
  "neuro-noise": [
    { name: "Default", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorFront: "#ffffff", colorMid: "#47a6ff", colorBack: "#000000", brightness: 0.05, contrast: 0.3 } },
    { name: "Sensation", values: { fit: "none", scale: 3, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorFront: "#00c8ff", colorMid: "#fbff00", colorBack: "#8b42ff", brightness: 0.19, contrast: 0.12 } },
    { name: "Bloodstream", values: { fit: "none", scale: 0.7, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorFront: "#ff0000", colorMid: "#ff0000", colorBack: "#ffffff", brightness: 0.24, contrast: 0.17 } },
    { name: "Ghost", values: { fit: "none", scale: 0.55, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorFront: "#ffffff", colorMid: "#000000", colorBack: "#ffffff", brightness: 0, contrast: 1 } },
  ],
  "simplex-noise": [
    { name: "Default", values: { fit: "none", scale: 0.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.5, frame: 0, colors: ["#4449CF", "#FFD1E0", "#F94446", "#FFD36B", "#FFFFFF"], stepsPerColor: 2, softness: 0 } },
    { name: "Spots", values: { fit: "none", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.6, frame: 0, colors: ["#ff7b00", "#f9ffeb", "#320d82"], stepsPerColor: 1, softness: 0 } },
    { name: "First contact", values: { fit: "none", scale: 0.2, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 2, frame: 0, colors: ["#e8cce6", "#120d22", "#442c44", "#e6baba", "#fff5f5"], stepsPerColor: 2, softness: 0 } },
    { name: "Bubblegum", values: { fit: "none", scale: 1.6, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 2, frame: 0, colors: ["#ffffff", "#ff9e9e", "#5f57ff", "#00f7ff"], stepsPerColor: 1, softness: 1 } },
  ],
  "god-rays": [
    { name: "Default", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: -0.55, originX: 0.5, originY: 0.5, colorBack: "#000000", colorBloom: "#0000ff", colors: ["#a600ff6e", "#6200fff0", "#ffffff", "#33fff5"], density: 0.3, spotty: 0.3, midIntensity: 0.4, midSize: 0.2, intensity: 0.8, bloom: 0.4, speed: 0.75, frame: 0 } },
    { name: "Warp", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, colorBack: "#000000", colorBloom: "#222288", colors: ["#ff47d4", "#ff8c00", "#ffffff"], density: 0.45, spotty: 0.15, midIntensity: 0.4, midSize: 0.33, intensity: 0.79, bloom: 0.4, speed: 2, frame: 0 } },
    { name: "Linear", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0.2, offsetY: -0.8, originX: 0.5, originY: 0.5, colorBack: "#000000", colorBloom: "#eeeeee", colors: ["#ffffff1f", "#ffffff3d", "#ffffff29"], density: 0.41, spotty: 0.25, midSize: 0.1, midIntensity: 0.75, intensity: 0.79, bloom: 1, speed: 0.5, frame: 0 } },
    { name: "Ether", values: { fit: "contain", scale: 1, rotation: 0, offsetX: -0.6, offsetY: 0, originX: 0.5, originY: 0.5, colorBack: "#090f1d", colorBloom: "#ffffff", colors: ["#148effa6", "#c4dffebe", "#232a47"], density: 0.03, spotty: 0.77, midSize: 0.1, midIntensity: 0.6, intensity: 0.6, bloom: 0.6, speed: 1, frame: 0 } },
  ],
  "smoke-ring": [
    { name: "Default", values: { fit: "contain", scale: 0.8, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.5, frame: 0, colorBack: "#000000", colors: ["#ffffff"], noiseScale: 3, noiseIterations: 8, radius: 0.25, thickness: 0.65, innerShape: 0.7 } },
    { name: "Line", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, frame: 0, colorBack: "#000000", colors: ["#4540a4", "#1fe8ff"], noiseScale: 1.1, noiseIterations: 2, radius: 0.38, thickness: 0.01, innerShape: 0.88, speed: 4 } },
    { name: "Solar", values: { fit: "contain", scale: 2, rotation: 0, offsetX: 0, offsetY: 1, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colors: ["#ffffff", "#ffca0a", "#fc6203", "#fc620366"], noiseScale: 2, noiseIterations: 3, radius: 0.4, thickness: 0.8, innerShape: 4 } },
    { name: "Cloud", values: { fit: "contain", scale: 2.5, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, frame: 0, colorBack: "#81ADEC", colors: ["#ffffff"], noiseScale: 3, noiseIterations: 10, radius: 0.5, thickness: 0.65, innerShape: 0.85, speed: 0.5 } },
  ],
  metaballs: [
    { name: "Default", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colorBack: "#000000", colors: ["#6e33cc", "#ff5500", "#ffc105", "#ffc800", "#f585ff"], count: 10, size: 0.83 } },
    { name: "Ink Drops", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 2, frame: 0, colorBack: "#ffffff00", colors: ["#000000"], count: 18, size: 0.1 } },
    { name: "Solar", values: { fit: "contain", scale: 1, rotation: 0, offsetX: 0, offsetY: 0, originX: 0.5, originY: 0.5, speed: 1, frame: 0, colors: ["#ffc800", "#ff5500", "#ffc105"], colorBack: "#102f84", count: 7, size: 0.75 } },
    { name: "Background", values: { fit: "contain", scale: 4, rotation: 0, offsetX: -0.3, offsetY: 0, originX: 0.5, originY: 0.5, speed: 0.5, frame: 0, colors: ["#ae00ff", "#00ff95", "#ffc105"], colorBack: "#2a273f", count: 13, size: 0.81 } },
  ],
};

const EFFECT_SUMMARIES: Record<PaperEffectId, string> = {
  "paper-texture": "Paper Shader texture with fibers, folds, crumples, speckles, and optional image filtering.",
  "fluted-glass": "Paper Shader fluted glass filter with ribbed image refraction and configurable grid distortion.",
  water: "Paper Shader animated water distortion that can run over images or as a standalone texture.",
  "image-dithering": "Paper Shader image dithering filter with Bayer/random modes and palette controls.",
  "halftone-dots": "Paper Shader halftone-dot image filter with grid, dot style, grain, and color controls.",
  "halftone-cmyk": "Paper Shader CMYK halftone print filter with channel colors and ink controls.",
  heatmap: "Paper Shader heatmap image processor with contour glow and multi-color thermal ramps.",
  "liquid-metal": "Paper Shader liquid metal material for images, logos, and abstract shapes.",
  "gem-smoke": "Paper Shader gem-smoke logo/image treatment with glowing inner and outer distortion.",
  "mesh-gradient": "Paper Shader animated mesh gradient with color spots, swirl, distortion, and grain.",
  "static-mesh-gradient": "Paper Shader static mesh gradient with controllable waves, color mixing, and grain.",
  "static-radial-gradient": "Paper Shader radial gradient with focal controls, distortion, and grain.",
  dithering: "Paper Shader procedural dithering patterns with animated shapes and Bayer/random modes.",
  "grain-gradient": "Paper Shader grainy gradient fields with abstract shapes, softness, intensity, and noise.",
  "dot-grid": "Paper Shader static dot grid supporting circle, diamond, square, and triangle cells.",
  "neuro-noise": "Paper Shader glowing neural noise with front, mid, and background color controls.",
  "simplex-noise": "Paper Shader multi-color simplex noise gradient with stepped or soft transitions.",
  "god-rays": "Paper Shader volumetric god rays with bloom, density, central glow, and animated drift.",
  "smoke-ring": "Paper Shader smoky radial ring built from layered noise and multi-color ramps.",
  metaballs: "Paper Shader gooey metaballs with up to 20 animated blobs and multi-color mixing.",
};

const SKIPPED_PAPER_PARAMS = new Set(["frame", "worldWidth", "worldHeight"]);

const SELECT_OPTIONS: Record<string, EffectParamOption[]> = {
  fit: options(["none", "contain", "cover"]),
  "fluted-glass.shape": options(["lines", "linesIrregular", "wave", "zigzag", "pattern"]),
  "fluted-glass.distortionShape": options(["prism", "lens", "contour", "cascade", "flat"]),
  "image-dithering.type": options(["random", "2x2", "4x4", "8x8"]),
  "halftone-dots.type": options(["classic", "gooey", "holes", "soft"]),
  "halftone-dots.grid": options(["square", "hex"]),
  "halftone-cmyk.type": options(["dots", "ink", "sharp"]),
  "liquid-metal.shape": options(["none", "circle", "daisy", "diamond", "metaballs"]),
  "gem-smoke.shape": options(["none", "circle", "daisy", "diamond", "metaballs"]),
  "dithering.shape": options(["simplex", "warp", "dots", "wave", "ripple", "swirl", "sphere"]),
  "dithering.type": options(["random", "2x2", "4x4", "8x8"]),
  "grain-gradient.shape": options(["wave", "dots", "truchet", "corners", "ripple", "blob", "sphere"]),
  "dot-grid.shape": options(["circle", "diamond", "square", "triangle"]),
};

const NUMBER_CONFIG: Record<string, { min: number; max: number; step: number }> = {
  scale: { min: 0.01, max: 4, step: 0.01 },
  rotation: { min: 0, max: 360, step: 1 },
  offsetX: { min: -1, max: 1, step: 0.01 },
  offsetY: { min: -1, max: 1, step: 0.01 },
  originX: { min: 0, max: 1, step: 0.01 },
  originY: { min: 0, max: 1, step: 0.01 },
  speed: { min: -4, max: 4, step: 0.01 },
  angle: { min: 0, max: 360, step: 1 },
  focalAngle: { min: 0, max: 360, step: 1 },
  foldCount: { min: 1, max: 15, step: 1 },
  seed: { min: 0, max: 1000, step: 0.1 },
  count: { min: 1, max: 20, step: 1 },
  colorSteps: { min: 1, max: 7, step: 1 },
  stepsPerColor: { min: 1, max: 10, step: 1 },
  noiseIterations: { min: 1, max: 10, step: 1 },
  gapX: { min: 2, max: 500, step: 1 },
  gapY: { min: 2, max: 500, step: 1 },
  strokeWidth: { min: 0, max: 50, step: 1 },
  "dot-grid.size": { min: 1, max: 100, step: 1 },
  "image-dithering.size": { min: 0.5, max: 20, step: 0.5 },
  "dithering.size": { min: 0.5, max: 20, step: 0.5 },
  "water.size": { min: 0.01, max: 7, step: 0.01 },
  "smoke-ring.innerShape": { min: 0, max: 4, step: 0.01 },
  repetition: { min: 0.1, max: 8, step: 0.01 },
  shiftRed: { min: -1, max: 1, step: 0.01 },
  shiftBlue: { min: -1, max: 1, step: 0.01 },
  gainC: { min: -1, max: 1, step: 0.01 },
  gainM: { min: -1, max: 1, step: 0.01 },
  gainY: { min: -1, max: 1, step: 0.01 },
  gainK: { min: -1, max: 1, step: 0.01 },
  contrast: { min: 0, max: 2, step: 0.01 },
  radius: { min: 0, max: 2, step: 0.01 },
  noiseScale: { min: 0.01, max: 5, step: 0.01 },
  positions: { min: 0, max: 100, step: 1 },
  distortionFreq: { min: 1, max: 32, step: 1 },
};

function options(values: string[]): EffectParamOption[] {
  return values.map((value) => ({ label: title(value), value }));
}

function title(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
}

function numberParam(id: string, label: string, defaultValue: number, min = 0, max = 1, step = 0.01, description?: string): EffectParamDefinition {
  return { id, label, type: "number", defaultValue, min, max, step, description };
}

function colorParam(id: string, label: string, defaultValue: string, description?: string): EffectParamDefinition {
  return { id, label, type: "color", defaultValue, description };
}

function selectParam(id: string, label: string, defaultValue: string, options: EffectParamOption[], description?: string): EffectParamDefinition {
  return { id, label, type: "select", defaultValue, options, description };
}

function booleanParam(id: string, label: string, defaultValue = false, description?: string): EffectParamDefinition {
  return { id, label, type: "boolean", defaultValue, description };
}

function imageParam(id: string, label: string, defaultValue: string, description?: string): EffectParamDefinition {
  return { id, label, type: "image", defaultValue, options: DEMO_IMAGE_OPTIONS, description };
}

function values(params: EffectParamDefinition[], patch: Record<string, EffectParamValue> = {}): Record<string, EffectParamValue> {
  return Object.fromEntries(params.map((param) => [param.id, patch[param.id] ?? param.defaultValue]));
}

function flattenPaperValues(input: Record<string, unknown>): Record<string, EffectParamValue> {
  const output: Record<string, EffectParamValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SKIPPED_PAPER_PARAMS.has(key)) continue;
    if (Array.isArray(value) && key === "colors") {
      value.forEach((color, index) => {
        if (typeof color === "string") output[`colors.${index}`] = color;
      });
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

function numberConfig(effectId: PaperEffectId | "custom", id: string): { min: number; max: number; step: number } {
  return NUMBER_CONFIG[`${effectId}.${id}`] ?? NUMBER_CONFIG[id] ?? { min: 0, max: 1, step: 0.01 };
}

function paramLabel(id: string): string {
  if (id.startsWith("colors.")) return `Color ${Number(id.split(".")[1] ?? 0) + 1}`;
  return title(id.replace(/^color/, "color "));
}

function selectOptionsFor(effectId: PaperEffectId, id: string): EffectParamOption[] | null {
  return SELECT_OPTIONS[`${effectId}.${id}`] ?? SELECT_OPTIONS[id] ?? null;
}

function paramsFromPaperPresets(effectId: PaperEffectId, presetSpecs: PaperPresetSpec[]): EffectParamDefinition[] {
  const flattened = presetSpecs.map((preset) => flattenPaperValues(preset.values));
  const keys = new Set<string>();
  for (const preset of flattened) {
    for (const key of Object.keys(preset)) keys.add(key);
  }
  const orderedKeys = Object.keys(flattened[0] ?? {});
  for (const key of [...keys].sort()) {
    if (!orderedKeys.includes(key)) orderedKeys.push(key);
  }

  const params: EffectParamDefinition[] = [];
  if (IMAGE_EFFECT_IDS.has(effectId)) {
    params.push(imageParam("image", "Image", DEFAULT_DEMO_IMAGE, "Built-in demo image or an uploaded image."));
  }

  for (const key of orderedKeys) {
    const defaultValue = flattened.find((preset) => preset[key] !== undefined)?.[key];
    if (defaultValue === undefined) continue;
    const label = paramLabel(key);
    const selectOptions = selectOptionsFor(effectId, key);
    if (selectOptions && typeof defaultValue === "string") {
      params.push(selectParam(key, label, defaultValue, selectOptions));
    } else if (typeof defaultValue === "boolean") {
      params.push(booleanParam(key, label, defaultValue));
    } else if (typeof defaultValue === "number") {
      const config = numberConfig(effectId, key);
      params.push(numberParam(key, label, defaultValue, config.min, config.max, config.step));
    } else if (typeof defaultValue === "string" && (defaultValue.startsWith("#") || key.startsWith("color") || key.startsWith("colors."))) {
      params.push(colorParam(key, label, defaultValue));
    }
  }

  return params;
}

function paperCode(effectId: PaperEffectId): string {
  return `@paper-design/shaders-react:${effectId}`;
}

function paperPreviewUrl(effectId: PaperEffectId): string {
  return `/effects/previews/${effectId}.jpg`;
}

function paperEffect(effectId: PaperEffectId): EffectDefinition {
  const presetSpecs = PAPER_PRESETS[effectId];
  const parameters = paramsFromPaperPresets(effectId, presetSpecs);
  return {
    id: effectId,
    name: effectId.replace(/-/g, " "),
    origin: "built-in",
    category: "@Paper",
    summary: EFFECT_SUMMARIES[effectId],
    previewUrl: paperPreviewUrl(effectId),
    parameters,
    presets: presetSpecs.map((preset, index) => ({
      id: index === 0 ? "default" : slug(preset.name),
      name: preset.name,
      values: values(parameters, flattenPaperValues(preset.values)),
    })),
    code: paperCode(effectId),
  };
}

export const BUILT_IN_EFFECTS: EffectDefinition[] = PAPER_EFFECT_ORDER.map((effectId) => paperEffect(effectId));

const BUILT_IN_BY_ID = new Map(BUILT_IN_EFFECTS.map((effect) => [effect.id, effect]));

export function listBuiltInEffectCards(): EffectCard[] {
  return BUILT_IN_EFFECTS.map(({ id, name, origin, category, summary, previewUrl }) => ({ id, name, origin, category, summary, previewUrl }));
}

export function getBuiltInEffect(id: string): EffectDefinition | null {
  return BUILT_IN_BY_ID.get(id) ?? null;
}

export function defaultEffectValues(effect: Pick<EffectDefinition, "parameters">): Record<string, EffectParamValue> {
  return values(effect.parameters);
}

export function createCustomEffectScaffold(name: string): Pick<EffectDefinition, "name" | "category" | "summary" | "parameters" | "presets" | "code"> {
  const params: EffectParamDefinition[] = [
    colorParam("colorBack", "Background", "#101114"),
    colorParam("colorFront", "Foreground", "#f8fafc"),
    numberParam("intensity", "Intensity", 0.65),
    numberParam("scale", "Scale", 0.8, 0.05, 4, 0.01),
    numberParam("speed", "Speed", 0.18, -4, 4, 0.01),
  ];
  return {
    name,
    category: "Custom",
    summary: "Editable local effect. The Agent can revise GLSL code or parameters while the preview stays live.",
    parameters: params,
    presets: [{ id: "default", name: "Default", values: values(params) }],
    code: [
      "#version 300 es",
      "precision highp float;",
      "",
      "uniform vec2 u_resolution;",
      "uniform float u_time;",
      "uniform vec4 u_colorBack;",
      "uniform vec4 u_colorFront;",
      "uniform float u_intensity;",
      "uniform float u_scale;",
      "",
      "out vec4 fragColor;",
      "",
      "float ring(vec2 p, float r, float w) {",
      "  return smoothstep(w, 0.0, abs(length(p) - r));",
      "}",
      "",
      "void main() {",
      "  vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);",
      "  float t = u_time * 0.7;",
      "  vec2 p = uv * max(u_scale, 0.01);",
      "  float field = ring(p + vec2(sin(t) * 0.22, cos(t * 0.7) * 0.18), 0.38, 0.09);",
      "  field += ring(p - vec2(cos(t * 0.8) * 0.18, sin(t * 1.1) * 0.2), 0.24, 0.11);",
      "  field += 0.18 * sin((p.x + p.y) * 8.0 + t * 2.0);",
      "  float mixValue = clamp(field * u_intensity, 0.0, 1.0);",
      "  fragColor = mix(u_colorBack, u_colorFront, mixValue);",
      "}",
    ].join("\n"),
  };
}

function componentName(effectId: string): string {
  return title(effectId).replace(/\s+/g, "");
}

export function buildEffectAgentContext(effect: EffectDefinition): string {
  const params = effect.parameters
    .map((param) => {
      const range = typeof param.min === "number" || typeof param.max === "number" ? ` (${param.min ?? "-inf"} to ${param.max ?? "inf"})` : "";
      const options = param.options?.length ? ` options: ${param.options.map((option) => option.value).join(", ")}` : "";
      return `- ${param.id}: ${param.type}${range}, default ${String(param.defaultValue)}${options}`;
    })
    .join("\n");
  const presets = effect.presets.map((preset) => `- ${preset.name}: ${JSON.stringify(preset.values)}`).join("\n");
  const isPaper = effect.code.startsWith("@paper-design/shaders-react:");
  const engine = isPaper
    ? [
        `Built-in renderer: @paper-design/shaders-react ${componentName(effect.id)} component.`,
        "Use this as a reusable @Paper effect reference. Do not paste the whole Effects library into a Design run; search/read only the relevant effect.",
        "For Design artifacts, prefer referencing the effect's parameter model or recreating the same visual language with local code when importing the package is not appropriate.",
      ]
    : [
        "Custom renderer: WebGL2 fragment shader when code starts with #version 300 es; legacy Canvas 2D renderEffect(ctx, params, time) is still supported.",
        "When editing GLSL, return complete fragment shader code. Use bounded loops, deterministic math, explicit uniforms, and avoid unsupported extensions.",
        "Dezin maps parameter ids to GLSL uniforms named u_<id>; color params become vec4, number params float, boolean params bool, and image params sampler2D.",
      ];

  return [
    `# Effect: ${effect.name}`,
    `ID: ${effect.id}`,
    `Origin: ${effect.origin}`,
    `Tag: ${effect.category}`,
    effect.summary,
    "",
    ...engine,
    "",
    "Shader generation guidance:",
    "- For custom Effects, generate WebGL2 fragment shader code unless the user explicitly asks for Canvas 2D.",
    "- Decompose the visual into coordinate field, signal/noise layer, and color mapping before writing code.",
    "- Expose important visual decisions as parameters instead of hard-coding them.",
    "- Keep animation driven by u_time/speed and make still frames useful when speed is 0.",
    "- For image effects, keep a clear fallback color treatment when the image is missing or low contrast.",
    "",
    "Parameters:",
    params,
    "",
    "Presets:",
    presets,
    "",
    "Code reference:",
    "```",
    effect.code,
    "```",
  ].join("\n");
}

export function normalizeEffectQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}
