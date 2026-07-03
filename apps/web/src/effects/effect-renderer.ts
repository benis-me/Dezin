import type { EffectDetail, EffectParamValue } from "../lib/api.ts";

export type EffectValues = Record<string, EffectParamValue>;

export function defaultValues(effect: Pick<EffectDetail, "parameters" | "presets">): EffectValues {
  const defaults = Object.fromEntries(effect.parameters.map((param) => [param.id, param.defaultValue]));
  return { ...defaults, ...(effect.presets.find((preset) => preset.id === "default")?.values ?? {}) };
}

export function renderEffectCanvas(canvas: HTMLCanvasElement, effect: EffectDetail, values: EffectValues, time: number): void {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width || canvas.clientWidth || 900));
  const cssHeight = Math.max(1, Math.round(rect.height || canvas.clientHeight || 640));
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.round(cssWidth * ratio);
  const height = Math.round(cssHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const p = normalizeValues(effect, values);
  if (effect.origin === "custom") {
    renderCustom(ctx, effect.code, p, time);
  } else {
    renderBuiltIn(ctx, effect.id, p, time, cssWidth, cssHeight);
  }
  ctx.restore();
}

function normalizeValues(effect: EffectDetail, values: EffectValues): Record<string, EffectParamValue> {
  return Object.fromEntries(effect.parameters.map((param) => [param.id, values[param.id] ?? param.defaultValue]));
}

function n(value: unknown, fallback = 0): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  return Number.isFinite(num) ? num : fallback;
}

function s(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash(x: number, y: number, seed = 0): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

function noise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function parseHexColor(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return hex.split("").map((part) => Number.parseInt(`${part}${part}`, 16)) as [number, number, number];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
  }
  return null;
}

function colorMix(a: string, b: string, t: number): string {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const mix = ca.map((channel, index) => Math.round(lerp(channel, cb[index]!, clamp(t)))) as [number, number, number];
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function fillBase(ctx: CanvasRenderingContext2D, w: number, h: number, a: string, b: string, c?: string): void {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, a);
  if (c) gradient.addColorStop(0.48, c);
  gradient.addColorStop(1, b);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

function drawGrain(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed = 1): void {
  if (amount <= 0) return;
  const step = Math.max(1, Math.round(4 - amount * 3));
  ctx.save();
  ctx.globalAlpha = clamp(amount) * 0.22;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const v = hash(x, y, seed);
      ctx.fillStyle = v > 0.52 ? "#ffffff" : "#000000";
      ctx.fillRect(x, y, step, step);
    }
  }
  ctx.restore();
}

function sampleImageLike(ctx: CanvasRenderingContext2D, w: number, h: number, p: Record<string, EffectParamValue>): void {
  const back = s(p.colorBack, "#f4f1ea");
  const front = s(p.colorFront, "#26313a");
  fillBase(ctx, w, h, back, colorMix(front, back, 0.4), "#e7d6b4");
  ctx.save();
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < 7; i += 1) {
    ctx.fillStyle = i % 2 ? front : "#ffffff";
    ctx.beginPath();
    ctx.ellipse(w * (0.12 + i * 0.14), h * (0.28 + Math.sin(i) * 0.18), w * 0.16, h * 0.34, i * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function renderBuiltIn(ctx: CanvasRenderingContext2D, id: string, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  switch (id) {
    case "paper-texture":
      return paperTexture(ctx, p, w, h);
    case "fluted-glass":
      return flutedGlass(ctx, p, time, w, h);
    case "water":
      return water(ctx, p, time, w, h);
    case "image-dithering":
      return dithering(ctx, p, w, h, true);
    case "halftone-dots":
      return halftoneDots(ctx, p, w, h);
    case "halftone-cmyk":
      return halftoneCmyk(ctx, p, w, h);
    case "heatmap":
      return heatmap(ctx, p, time, w, h);
    case "liquid-metal":
      return liquidMetal(ctx, p, time, w, h);
    case "gem-smoke":
      return gemSmoke(ctx, p, time, w, h);
    case "mesh-gradient":
      return meshGradient(ctx, p, time, w, h);
    case "static-mesh-gradient":
      return meshGradient(ctx, p, 0, w, h);
    case "static-radial-gradient":
      return staticRadial(ctx, p, w, h);
    case "dithering":
      return dithering(ctx, p, w, h, false);
    case "grain-gradient":
      return grainGradient(ctx, p, w, h);
    case "dot-grid":
      return dotGrid(ctx, p, w, h);
    case "neuro-noise":
      return neuroNoise(ctx, p, time, w, h);
    case "simplex-noise":
      return simplexNoise(ctx, p, time, w, h);
    case "god-rays":
      return godRays(ctx, p, time, w, h);
    case "smoke-ring":
      return smokeRing(ctx, p, time, w, h);
    case "metaballs":
      return metaballs(ctx, p, time, w, h);
    default:
      return meshGradient(ctx, p, time, w, h);
  }
}

function paperTexture(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number): void {
  const back = s(p.colorBack, "#f7f2e8");
  const front = s(p.colorFront, "#9fadbc");
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, w, h);
  const seed = n(p.seed, 5.8);
  const roughness = n(p.roughness, 0.4);
  const folds = n(p.folds, 0.65);
  const foldCount = Math.max(1, Math.round(n(p.foldCount, 5)));
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const fiber = noise(x * 0.018 * n(p.scale, 0.6), y * 0.018 * n(p.scale, 0.6), seed);
      const fold = Math.sin((x / w) * Math.PI * foldCount + seed) * folds;
      const alpha = clamp((fiber - 0.42) * roughness + fold * 0.08 + n(p.drops, 0.2) * (hash(x, y, seed) > 0.985 ? 1 : 0), 0, 1);
      ctx.fillStyle = colorMix(back, front, alpha);
      ctx.fillRect(x, y, 2, 2);
    }
  }
}

function flutedGlass(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  sampleImageLike(ctx, w, h, p);
  const size = 8 + n(p.size, 0.5) * 34;
  const angle = (n(p.angle, 0) * Math.PI) / 180;
  const shadow = s(p.colorShadow, "#15202a");
  const highlight = s(p.colorHighlight, "#ffffff");
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(angle);
  ctx.translate(-w / 2, -h / 2);
  for (let x = -size; x < w + size; x += size) {
    const wave = Math.sin(x * 0.04 + time) * size * n(p.distortion, 0.5);
    const grad = ctx.createLinearGradient(x, 0, x + size, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, highlight);
    grad.addColorStop(1, shadow);
    ctx.globalAlpha = 0.08 + n(p.highlights, 0.1) * 0.18;
    ctx.fillStyle = grad;
    ctx.fillRect(x + wave, 0, size * 0.7, h);
  }
  ctx.restore();
  drawGrain(ctx, w, h, n(p.grainOverlay, 0));
}

function water(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorBack, "#0c3240"), "#041018", s(p.colorHighlight, "#bdefff"));
  const ripple = n(p.ripple, 0.66);
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let y = 0; y < h; y += 12) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const yy = y + Math.sin(x * 0.025 + time * n(p.speed, 0.32) * 7 + y * 0.02) * 16 * ripple;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.strokeStyle = s(p.colorHighlight, "#bdefff");
    ctx.globalAlpha = 0.08 + ripple * 0.08;
    ctx.lineWidth = 1 + n(p.foam, 0.25) * 2;
    ctx.stroke();
  }
  ctx.restore();
}

function dithering(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number, imageMode: boolean): void {
  if (imageMode) sampleImageLike(ctx, w, h, p);
  else {
    ctx.fillStyle = s(p.colorBack, "#fbfbf8");
    ctx.fillRect(0, 0, w, h);
  }
  const front = s(p.colorFront, "#111111");
  const matrix = Math.max(2, Math.round(n(p.matrix, 6)));
  const cell = Math.max(4, Math.round(18 / n(p.scale, 0.75)));
  ctx.fillStyle = bool(p.inverted) ? s(p.colorBack, "#fbfbf8") : front;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const threshold = ((x / cell + y / cell * matrix) % matrix) / matrix;
      const field = imageMode ? (Math.sin(x * 0.013) + Math.cos(y * 0.019) + 2) / 4 : noise(x * 0.02, y * 0.02, 4);
      if (field + n(p.density, n(p.intensity, 0.52)) * 0.35 > threshold) ctx.fillRect(x, y, cell, cell);
    }
  }
}

function halftoneDots(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number): void {
  sampleImageLike(ctx, w, h, p);
  const spacing = 7 + n(p.spacing, 0.42) * 24;
  const maxR = spacing * n(p.dotSize, 0.56);
  ctx.save();
  ctx.rotate((n(p.angle, 15) * Math.PI) / 180);
  ctx.fillStyle = s(p.colorFront, "#26313a");
  for (let y = -h; y < h * 1.4; y += spacing) {
    for (let x = -w; x < w * 1.4; x += spacing) {
      const density = (Math.sin(x * 0.015) + Math.cos(y * 0.02) + 2) / 4;
      ctx.globalAlpha = 0.2 + density * 0.72;
      ctx.beginPath();
      ctx.arc(x, y, maxR * density, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  drawGrain(ctx, w, h, n(p.grain, 0.18));
}

function halftoneCmyk(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number): void {
  ctx.fillStyle = "#fffdf8";
  ctx.fillRect(0, 0, w, h);
  const colors = [s(p.cyan, "#00a7d8"), s(p.magenta, "#d31675"), s(p.yellow, "#f5ca26"), s(p.black, "#161616")];
  const angles = [15, 75, 0, 45];
  const spacing = 8 + n(p.spacing, 0.4) * 18;
  colors.forEach((color, layer) => {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((angles[layer]! * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = n(p.ink, 0.82) * 0.62;
    for (let y = -h; y < h * 1.5; y += spacing) {
      for (let x = -w; x < w * 1.5; x += spacing) {
        const d = (Math.sin((x + layer * 20) * 0.014) + Math.cos((y - layer * 15) * 0.018) + 2) / 4;
        ctx.beginPath();
        ctx.arc(x, y, spacing * n(p.dotSize, 0.48) * d, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  });
}

function heatmap(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  const bands = Math.max(2, Math.round(n(p.bands, 7)));
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const v = (noise(x * 0.012, y * 0.012, time * n(p.speed, 0.24)) + Math.sin((x + y) * 0.01 + time) * 0.2) * n(p.intensity, 0.74);
      const band = Math.floor(clamp(v) * bands) / Math.max(1, bands - 1);
      ctx.fillStyle = band < 0.45 ? colorMix(s(p.cold, "#172554"), s(p.mid, "#f97316"), band / 0.45) : colorMix(s(p.mid, "#f97316"), s(p.hot, "#fff7ad"), (band - 0.45) / 0.55);
      ctx.fillRect(x, y, 3, 3);
    }
  }
}

function liquidMetal(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorBack, "#111111"), "#2f3237", s(p.colorAccent, "#8ab4ff"));
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 18; i += 1) {
    const y = (h * i) / 17 + Math.sin(time * n(p.speed, 0.2) * 5 + i) * h * 0.05;
    const grad = ctx.createLinearGradient(0, y - 30, w, y + 30);
    grad.addColorStop(0, "transparent");
    grad.addColorStop(0.45, s(p.colorFront, "#d7dbe0"));
    grad.addColorStop(0.55, "#ffffff");
    grad.addColorStop(1, "transparent");
    ctx.strokeStyle = grad;
    ctx.globalAlpha = 0.1 + n(p.shine, 0.82) * 0.18;
    ctx.lineWidth = 12 + n(p.viscosity, 0.65) * 24;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.25, y - 90, w * 0.75, y + 90, w, y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

function gemSmoke(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorC, "#111827"), s(p.colorA, "#73fbd3"), s(p.colorB, "#7c3aed"));
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 26; i += 1) {
    const x = w * (0.5 + Math.cos(i * 1.7 + time * n(p.speed, 0.22)) * 0.34 * n(p.turbulence, 0.6));
    const y = h * (0.5 + Math.sin(i * 1.13 - time * 0.7) * 0.3);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.min(w, h) * (0.1 + n(p.smoke, 0.64) * 0.12));
    grad.addColorStop(0, i % 2 ? s(p.colorA, "#73fbd3") : s(p.colorB, "#7c3aed"));
    grad.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.12 + n(p.facet, 0.45) * 0.12;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";
}

function meshGradient(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorA, "#14532d"), s(p.colorD, "#f8fafc"), s(p.colorB, "#14b8a6"));
  const colors = [s(p.colorA, "#14532d"), s(p.colorB, "#14b8a6"), s(p.colorC, "#f59e0b"), s(p.colorD, "#f8fafc")];
  colors.forEach((color, i) => {
    const t = time * n(p.speed, 0.2) + i * 1.7;
    const x = w * (0.5 + Math.cos(t) * (0.25 + n(p.swirl, 0.56) * 0.18));
    const y = h * (0.5 + Math.sin(t * 1.3) * (0.22 + n(p.distortion, 0.45) * 0.2));
    const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.7);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.64;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  });
  ctx.globalAlpha = 1;
  drawGrain(ctx, w, h, n(p.grain, 0.1));
}

function staticRadial(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number): void {
  const x = w * n(p.originX, 0.44);
  const y = h * n(p.originY, 0.38);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * n(p.radius, 0.82));
  grad.addColorStop(0, s(p.colorA, "#f8fafc"));
  grad.addColorStop(0.48, s(p.colorB, "#f97316"));
  grad.addColorStop(1, s(p.colorC, "#111827"));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  drawGrain(ctx, w, h, n(p.grain, 0.08));
}

function grainGradient(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number): void {
  const angle = (n(p.angle, 24) * Math.PI) / 180;
  const x = Math.cos(angle) * w;
  const y = Math.sin(angle) * h;
  const grad = ctx.createLinearGradient(0, 0, x, y);
  grad.addColorStop(0, s(p.colorA, "#f8fafc"));
  grad.addColorStop(1, s(p.colorB, "#171717"));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  drawGrain(ctx, w, h, n(p.grain, 0.18), 9);
}

function dotGrid(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, w: number, h: number): void {
  ctx.fillStyle = bool(p.inverted) ? s(p.colorFront, "#242424") : s(p.colorBack, "#ffffff");
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = bool(p.inverted) ? s(p.colorBack, "#ffffff") : s(p.colorFront, "#242424");
  const step = 9 + n(p.size, 0.5) * 30;
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const jitter = (hash(x, y, 3) - 0.5) * step * n(p.jitter, 0.08);
      const dx = (x - w / 2) / (w / 2);
      const dy = (y - h / 2) / (h / 2);
      const fade = 1 - clamp(Math.hypot(dx, dy) * n(p.fade, 0.32));
      ctx.globalAlpha = Math.max(0.1, fade);
      ctx.beginPath();
      ctx.arc(x + jitter, y - jitter, step * n(p.radius, 0.36) * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function neuroNoise(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const v = Math.sin(noise(x * 0.01 * n(p.scale, 0.7), y * 0.01 * n(p.scale, 0.7), time * n(p.speed, 0.18)) * 18 * n(p.complexity, 0.62));
      const t = clamp((v * 0.5 + 0.5) * n(p.contrast, 0.52) + 0.2);
      ctx.fillStyle = t < 0.45 ? colorMix(s(p.colorA, "#09090b"), s(p.colorB, "#38bdf8"), t / 0.45) : colorMix(s(p.colorB, "#38bdf8"), s(p.colorC, "#f0abfc"), (t - 0.45) / 0.55);
      ctx.fillRect(x, y, 3, 3);
    }
  }
}

function simplexNoise(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  const scale = 0.012 * n(p.scale, 0.72);
  const octaves = Math.max(1, Math.round(n(p.octaves, 4)));
  const lacunarity = n(p.lacunarity, 2);
  const gain = n(p.gain, 0.52);
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      let amp = 1;
      let freq = 1;
      let value = 0;
      let total = 0;
      for (let o = 0; o < octaves; o += 1) {
        value += noise(x * scale * freq, y * scale * freq, time * 0.12 + o) * amp;
        total += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      const v = value / Math.max(0.001, total);
      ctx.fillStyle = v > n(p.threshold, 0.48) ? s(p.colorFront, "#111827") : s(p.colorBack, "#f8fafc");
      ctx.fillRect(x, y, 3, 3);
    }
  }
}

function godRays(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorBack, "#020617"), "#0f172a");
  const ox = w * n(p.originX, 0.5);
  const oy = h * n(p.originY, 0.14);
  const rays = Math.max(3, Math.round(n(p.rays, 18)));
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < rays; i += 1) {
    const angle = (Math.PI * 2 * i) / rays + Math.sin(time * n(p.speed, 0.16) + i) * 0.08;
    const spread = 0.04 + n(p.spread, 0.65) * 0.08;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + Math.cos(angle - spread) * w * 1.5, oy + Math.sin(angle - spread) * h * 1.5);
    ctx.lineTo(ox + Math.cos(angle + spread) * w * 1.5, oy + Math.sin(angle + spread) * h * 1.5);
    ctx.closePath();
    ctx.fillStyle = s(p.colorRay, "#fde68a");
    ctx.globalAlpha = 0.015 + n(p.haze, 0.34) * 0.04;
    ctx.fill();
  }
  ctx.restore();
}

function smokeRing(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorBack, "#020617"), "#0b1120");
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * n(p.radius, 0.38);
  const thickness = Math.min(w, h) * n(p.thickness, 0.18);
  for (let i = 0; i < 160; i += 1) {
    const a = (i / 160) * Math.PI * 2;
    const turb = (noise(Math.cos(a) * 3 + time * n(p.speed, 0.2), Math.sin(a) * 3, 5) - 0.5) * thickness * n(p.turbulence, 0.62);
    const x = cx + Math.cos(a) * (radius + turb);
    const y = cy + Math.sin(a) * (radius + turb);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, thickness);
    grad.addColorStop(0, s(p.colorSmoke, "#e5e7eb"));
    grad.addColorStop(0.45, s(p.colorAccent, "#a7f3d0"));
    grad.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = grad;
    ctx.fillRect(x - thickness, y - thickness, thickness * 2, thickness * 2);
  }
  ctx.globalAlpha = 1;
}

function metaballs(ctx: CanvasRenderingContext2D, p: Record<string, EffectParamValue>, time: number, w: number, h: number): void {
  fillBase(ctx, w, h, s(p.colorBack, "#0a0a0a"), "#111827");
  const count = Math.max(2, Math.round(n(p.count, 7)));
  const balls = Array.from({ length: count }, (_, i) => ({
    x: w * (0.5 + Math.cos(time * n(p.speed, 0.24) + i * 2.1) * 0.34),
    y: h * (0.5 + Math.sin(time * n(p.speed, 0.24) * 1.3 + i * 1.4) * 0.3),
    r: Math.min(w, h) * (0.08 + hash(i, 3) * 0.08),
  }));
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const field = balls.reduce((sum, ball) => sum + (ball.r * ball.r) / (Math.hypot(x - ball.x, y - ball.y) ** 2 + 1), 0);
      if (field > n(p.threshold, 0.42)) {
        ctx.fillStyle = field > n(p.threshold, 0.42) + n(p.softness, 0.36) ? s(p.colorFront, "#f8fafc") : s(p.colorAccent, "#22c55e");
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }
}

function renderCustom(ctx: CanvasRenderingContext2D, code: string, params: Record<string, EffectParamValue>, time: number): void {
  try {
    const fn = new Function(
      "ctx",
      "params",
      "time",
      `"use strict";\n${code}\nreturn typeof renderEffect === "function" ? renderEffect(ctx, params, time) : undefined;`,
    ) as (ctx: CanvasRenderingContext2D, params: Record<string, EffectParamValue>, time: number) => void;
    fn(ctx, params, time);
  } catch (error) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fca5a5";
    ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(error instanceof Error ? error.message : "Custom effect error", 20, 36);
  }
}
