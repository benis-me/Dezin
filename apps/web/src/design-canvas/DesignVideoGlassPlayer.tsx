/**
 * Video Node player ported from benis-me/react-liquid-glass `VideoGlassDemo`:
 * the frame is drawn through a WebGL2 shader that refracts three circular
 * dome lenses (rewind · play/pause · forward) and a capsule seek bar, with
 * spring-driven press/hover deformation and a rubber-band seek. Sizes scale
 * with the Node so the same controls read on a canvas thumbnail and in focus.
 */
import { Volume2, VolumeX } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { computeDomeConstants } from "refractive-glass-react";

import { cn } from "../lib/utils.ts";

const VIDEO_VERTEX = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const VIDEO_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_video;
uniform vec2 u_size;
uniform vec2 u_texel;
uniform vec2 u_fit;
uniform vec3 u_circles[3];
uniform float u_press[3];
uniform float u_baseScale[3];
uniform float u_depthRatio[3];
uniform float u_domeRadius[3];
uniform float u_domeScale[3];
uniform float u_edgeStrength[3];
uniform float u_edgeWidth[3];
uniform vec4 u_bar;
uniform float u_barRadius;
uniform float u_barScale;
uniform float u_strength;
float erfApprox(float value) { return tanh(1.7724538509 * value); }
vec4 videoAt(vec2 uv) {
  vec2 fitted = (uv - 0.5) * u_fit + 0.5;
  if (fitted.x < 0.0 || fitted.x > 1.0 || fitted.y < 0.0 || fitted.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  return texture(u_video, fitted);
}
vec4 frostedAt(vec2 uv) {
  vec2 offset = u_texel * 0.65;
  vec4 color = videoAt(uv) * 0.4;
  color += videoAt(uv + vec2(offset.x, 0.0)) * 0.15;
  color += videoAt(uv - vec2(offset.x, 0.0)) * 0.15;
  color += videoAt(uv + vec2(0.0, offset.y)) * 0.15;
  color += videoAt(uv - vec2(0.0, offset.y)) * 0.15;
  return color;
}
float roundedRectSdf(vec2 point, vec2 halfSize, float radius) {
  vec2 q = abs(point) - halfSize + vec2(radius);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
void main() {
  vec2 pixel = v_uv * u_size;
  float mask = 0.0;
  vec2 displacement = vec2(0.0);
  float baseScale = 0.0;
  float specular = 0.0;
  for (int index = 0; index < 3; index++) {
    float radius = u_circles[index].z;
    if (radius < 0.1) continue;
    float press = max(u_press[index], 0.001);
    vec2 visibleLocal = pixel - u_circles[index].xy;
    float visibleDistance = length(visibleLocal) - radius * press;
    float aa = fwidth(visibleDistance);
    float circleMask = 1.0 - smoothstep(-aa, aa, visibleDistance);
    if (circleMask > mask) {
      vec2 local = visibleLocal / press;
      float rho = length(local);
      float depth = max(0.001, radius * u_depthRatio[index]);
      float falloff = 0.5 * (1.0 + erfApprox((rho - max(0.0, radius - depth)) / (depth * 1.41421356237)));
      vec2 direction = vec2(0.0);
      if (rho > 0.0001) {
        float cap = min(rho, 0.999 * u_domeRadius[index]);
        float gradient = cap / sqrt(max(0.0001, u_domeRadius[index] * u_domeRadius[index] - cap * cap));
        direction = normalize(local) * gradient * u_domeScale[index];
      }
      displacement = -0.5 * direction * falloff;
      baseScale = u_baseScale[index];
      float align = abs(dot(clamp(local / radius, -1.0, 1.0), vec2(0.8660254, 0.5)));
      float rim = max(0.0, 1.0 + (rho - radius) / max(0.001, u_edgeWidth[index]));
      specular = u_edgeStrength[index] * rim * pow(align, 1.5);
      mask = circleMask;
    }
  }
  if (u_bar.z > 0.1 && u_bar.w > 0.1) {
    vec2 local = pixel - u_bar.xy;
    vec2 halfSize = u_bar.zw * 0.5;
    float distance = roundedRectSdf(local, halfSize, u_barRadius);
    float aa = fwidth(distance);
    float barMask = 1.0 - smoothstep(-aa, aa, distance);
    if (barMask > mask) {
      vec2 q = abs(local) - halfSize + vec2(u_barRadius);
      vec2 outside = max(q, vec2(0.0));
      float outsideLength = length(outside);
      vec2 normal;
      if (q.x > 0.0 || q.y > 0.0) {
        normal = outsideLength > 0.0001 ? outside / outsideLength * sign(local) : vec2(0.0);
      } else if (q.x > q.y) {
        normal = vec2(sign(local.x), 0.0);
      } else {
        normal = vec2(0.0, sign(local.y));
      }
      float minHalf = min(halfSize.x, halfSize.y);
      float magnitude = clamp((minHalf + distance) / max(minHalf, 0.001), 0.0, 1.0);
      float depth = max(0.001, minHalf * 0.5);
      float falloff = 0.5 * (1.0 + erfApprox((distance + depth) / (depth * 1.41421356237)));
      displacement = -0.5 * normal * magnitude * falloff;
      baseScale = u_barScale;
      float align = abs(dot(normal * magnitude, vec2(0.8660254, 0.5)));
      float rim = max(0.0, 1.0 + distance / 2.0);
      specular = 0.25 * rim * pow(align, 1.5);
      mask = barMask;
    }
  }
  float strength = clamp(u_strength, 0.0, 1.0);
  float coverage = clamp(mask * strength, 0.0, 1.0);
  if (coverage <= 0.001) {
    fragColor = videoAt(v_uv);
    return;
  }
  vec2 offset = displacement * baseScale * coverage;
  vec2 displacedUv = v_uv + offset;
  vec4 raw = videoAt(displacedUv);
  vec4 frosted = frostedAt(displacedUv);
  vec4 color = mix(raw, frosted, coverage);
  float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float spec = min(1.0, specular) * 0.498 * coverage;
  float brightBlend = smoothstep(0.3, 0.7, luminance);
  vec3 additive = color.rgb + spec;
  vec3 multiplicative = color.rgb * (1.0 - spec);
  color.rgb = mix(additive, multiplicative, brightBlend);
  color.rgb += (0.5 - luminance) * 0.2 * coverage;
  fragColor = vec4(max(color.rgb, vec3(0.0)), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create video shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Video shader failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function texture(gl: WebGL2RenderingContext): WebGLTexture {
  const result = gl.createTexture();
  if (!result) throw new Error("Unable to create video texture");
  gl.bindTexture(gl.TEXTURE_2D, result);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return result;
}

function PlayGlyph() {
  return (
    <svg viewBox="-9.86 -5.5 52 52" fill="currentColor" aria-hidden>
      <path d="M35.25 24.3575C37.9167 22.8179 37.9167 18.9689 35.25 17.4293L6.00001 0.541836C3.33334 -0.997765 1.73986e-06 0.926732 1.87446e-06 4.00593L3.35081e-06 37.7809C3.48541e-06 40.8601 3.33334 42.7846 6 41.245L35.25 24.3575Z" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="5.25" y="2.625" width="4.5" height="18.75" rx="1.125" />
      <rect x="14.25" y="2.625" width="4.5" height="18.75" rx="1.125" />
    </svg>
  );
}

function RewindGlyph() {
  return (
    <svg viewBox="0 0 47 45" fill="none" aria-hidden style={{ transform: "translate(-1px, 1px)" }}>
      <path d="M17.7049 17.1654L13.5649 20.2254V18.1454L17.8649 14.9454H19.5449V29.0454H17.7049V17.1654ZM27.2205 29.3454C26.1805 29.3454 25.2939 29.1454 24.5605 28.7454C23.8405 28.3321 23.2939 27.7854 22.9205 27.1054C22.5472 26.4254 22.3605 25.6721 22.3605 24.8454H24.2405C24.2672 25.4321 24.4072 25.9454 24.6605 26.3854C24.9139 26.8121 25.2605 27.1454 25.7005 27.3854C26.1405 27.6121 26.6339 27.7254 27.1805 27.7254C27.8339 27.7254 28.3939 27.5921 28.8605 27.3254C29.3405 27.0587 29.7072 26.6854 29.9605 26.2054C30.2139 25.7121 30.3405 25.1387 30.3405 24.4854C30.3405 23.8587 30.2072 23.3121 29.9405 22.8454C29.6739 22.3787 29.3005 22.0187 28.8205 21.7654C28.3539 21.4987 27.8272 21.3654 27.2405 21.3654C26.6139 21.3654 26.0539 21.5187 25.5605 21.8254C25.0672 22.1187 24.7139 22.5254 24.5005 23.0454H22.5005L23.2605 14.9454H31.7405V16.6054H24.8605L24.4405 21.0654C24.7339 20.6921 25.1339 20.3854 25.6405 20.1454C26.1605 19.8921 26.7939 19.7654 27.5405 19.7654C28.3805 19.7654 29.1605 19.9587 29.8805 20.3454C30.6005 20.7321 31.1805 21.2854 31.6205 22.0054C32.0605 22.7121 32.2805 23.5387 32.2805 24.4854C32.2805 25.4587 32.0605 26.3187 31.6205 27.0654C31.1805 27.7987 30.5739 28.3654 29.8005 28.7654C29.0405 29.1521 28.1805 29.3454 27.2205 29.3454Z" fill="currentColor" />
      <path d="M5.63397 24.5454C6.01888 25.2121 6.98113 25.2121 7.36603 24.5454L11.2631 17.7954C11.648 17.1287 11.1669 16.2954 10.3971 16.2954L2.60288 16.2954C1.83308 16.2954 1.35196 17.1287 1.73686 17.7954L5.63397 24.5454Z" fill="currentColor" />
      <path d="M6.61285 17.3867C7.53426 13.9479 9.45469 10.8596 12.1313 8.51231C14.8079 6.165 18.1204 4.6641 21.65 4.19942C25.1796 3.73474 28.7678 4.32714 31.9607 5.90172C35.1536 7.47629 37.8079 9.96232 39.588 13.0454C41.368 16.1285 42.1938 19.6702 41.961 23.2227C41.7281 26.7751 40.4471 30.1787 38.2799 33.0031C36.1126 35.8275 33.1566 37.9458 29.7854 39.0902C26.4143 40.2345 22.7795 40.3535 19.3408 39.4321" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ForwardGlyph() {
  return (
    <svg viewBox="0 0 47 45" fill="none" aria-hidden style={{ transform: "translate(1px, 1px)" }}>
      <path d="M15.7049 17.1654L11.5649 20.2254V18.1454L15.8649 14.9454H17.5449V29.0454H15.7049V17.1654ZM25.2205 29.3454C24.1805 29.3454 23.2939 29.1454 22.5605 28.7454C21.8405 28.3321 21.2939 27.7854 20.9205 27.1054C20.5472 26.4254 20.3605 25.6721 20.3605 24.8454H22.2405C22.2672 25.4321 22.4072 25.9454 22.6605 26.3854C22.9139 26.8121 23.2605 27.1454 23.7005 27.3854C24.1405 27.6121 24.6339 27.7254 25.1805 27.7254C25.8339 27.7254 26.3939 27.5921 26.8605 27.3254C27.3405 27.0587 27.7072 26.6854 27.9605 26.2054C28.2139 25.7121 28.3405 25.1387 28.3405 24.4854C28.3405 23.8587 28.2072 23.3121 27.9405 22.8454C27.6739 22.3787 27.3005 22.0187 26.8205 21.7654C26.3539 21.4987 25.8272 21.3654 25.2405 21.3654C24.6139 21.3654 24.0539 21.5187 23.5605 21.8254C23.0672 22.1187 22.7139 22.5254 22.5005 23.0454H20.5005L21.2605 14.9454H29.7405V16.6054H22.8605L22.4405 21.0654C22.7339 20.6921 23.1339 20.3854 23.6405 20.1454C24.1605 19.8921 24.7939 19.7654 25.5405 19.7654C26.3805 19.7654 27.1605 19.9587 27.8805 20.3454C28.6005 20.7321 29.1805 21.2854 29.6205 22.0054C30.0605 22.7121 30.2805 23.5387 30.2805 24.4854C30.2805 25.4587 30.0605 26.3187 29.6205 27.0654C29.1805 27.7987 28.5739 28.3654 27.8005 28.7654C27.0405 29.1521 26.1805 29.3454 25.2205 29.3454Z" fill="currentColor" />
      <path d="M40.4109 24.5454C40.026 25.2121 39.0638 25.2121 38.6789 24.5454L34.7818 17.7954C34.3969 17.1287 34.878 16.2954 35.6478 16.2954L43.442 16.2954C44.2118 16.2954 44.693 17.1287 44.3081 17.7954L40.4109 24.5454Z" fill="currentColor" />
      <path d="M39.4321 17.3867C38.5107 13.9479 36.5902 10.8596 33.9136 8.51231C31.237 6.165 27.9245 4.6641 24.3949 4.19942C20.8653 3.73474 17.2771 4.32714 14.0842 5.90172C10.8913 7.47629 8.23698 9.96232 6.45695 13.0454C4.67692 16.1285 3.85111 19.6702 4.08395 23.2227C4.31679 26.7751 5.59782 30.1787 7.76505 33.0031C9.93228 35.8275 12.8884 37.9458 16.2595 39.0902C19.6306 40.2345 23.2654 40.3535 26.7042 39.4321" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

interface LensLayout {
  scale: number;
  playSize: number;
  sideSize: number;
  gap: number;
  margin: number;
  circles: Array<[number, number, number]>;
  bar: [number, number, number, number, number];
  barHeight: number;
}

/** The demo's 111/65px controls, scaled with the shorter side of the frame. */
function lensLayout(width: number, height: number): LensLayout {
  const scale = Math.max(0.42, Math.min(1.15, Math.min(width, height) / 300));
  const playSize = 111 * scale;
  const sideSize = 65 * scale;
  const gap = 24 * scale;
  const margin = Math.max(10, Math.min(24, 24 * scale));
  const barHeight = Math.round(30 * scale);
  const centerX = width / 2;
  const centerY = height / 2;
  const offset = playSize / 2 + gap + sideSize / 2;
  const showSides = width >= playSize + 2 * (gap + sideSize) + margin * 2;
  return {
    scale,
    playSize,
    sideSize,
    gap,
    margin,
    circles: [
      [centerX - offset, centerY, showSides ? sideSize / 2 : 0],
      [centerX, centerY, playSize / 2],
      [centerX + offset, centerY, showSides ? sideSize / 2 : 0],
    ],
    bar: [width / 2, height - margin - barHeight / 2, Math.max(0, width - margin * 2), barHeight, barHeight / 2],
    barHeight,
  };
}

type VideoFrameApi = {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const SIDE_BUTTON_SPRING = { stiffness: 1000, damping: 40, mass: 1.5 };
const PLAY_BUTTON_SPRING = { stiffness: 500, damping: 32, mass: 1 };
const BAR_DRAG_SPRING = { stiffness: 550, damping: 35, mass: 1 };
const BUTTON_HOVER_SCALE = 1.045;

function seekRubberBand(distance: number, limit: number): number {
  const magnitude = Math.abs(distance);
  if (magnitude === 0) return 0;
  return Math.sign(distance) * limit * (1 - 1 / (magnitude / limit + 1));
}

function stepSpring(
  value: number,
  velocity: number,
  target: number,
  config: { stiffness: number; damping: number; mass: number },
  elapsed: number,
): readonly [number, number] {
  const steps = Math.max(1, Math.ceil(elapsed / 0.008));
  const dt = elapsed / steps;
  let nextValue = value;
  let nextVelocity = velocity;
  for (let index = 0; index < steps; index += 1) {
    const acceleration = (-config.stiffness * (nextValue - target) - config.damping * nextVelocity) / config.mass;
    nextVelocity += acceleration * dt;
    nextValue += nextVelocity * dt;
  }
  if (Math.abs(nextValue - target) < 0.0005 && Math.abs(nextVelocity) < 0.005) {
    return [target, 0] as const;
  }
  return [nextValue, nextVelocity] as const;
}

function usePointerReleaseFallback(onRelease: () => void) {
  const releaseRef = useRef(onRelease);
  const cleanupRef = useRef<(() => void) | null>(null);
  releaseRef.current = onRelease;
  const disarm = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);
  const arm = useCallback((pointerId: number) => {
    disarm();
    let active = true;
    const finish = () => {
      if (!active) return;
      disarm();
      releaseRef.current();
    };
    const finishPointer = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish();
    };
    const finishWhenHidden = () => {
      if (document.hidden) finish();
    };
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", finish);
    document.addEventListener("visibilitychange", finishWhenHidden);
    cleanupRef.current = () => {
      active = false;
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      window.removeEventListener("blur", finish);
      document.removeEventListener("visibilitychange", finishWhenHidden);
    };
  }, [disarm]);
  useEffect(() => disarm, [disarm]);
  return { arm, disarm };
}

export function DesignVideoGlassPlayer({
  src,
  name,
  focused,
  onNaturalSize,
  onError,
}: {
  src: string;
  name: string;
  focused: boolean;
  onNaturalSize?: (size: { width: number; height: number }) => void;
  onError: () => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pressRef = useRef([1, 1, 1]);
  const pressTargetRef = useRef([1, 1, 1]);
  const hoverRef = useRef([false, false, false]);
  const scaleVelocityRef = useRef([0, 0, 0]);
  const strengthRef = useRef(0);
  const strengthTargetRef = useRef(1);
  const barStretchRef = useRef(0);
  const barStretchTargetRef = useRef(0);
  const barStretchVelocityRef = useRef(0);
  const textureDirtyRef = useRef(true);
  const frameRef = useRef(0);
  const videoFrameRef = useRef(0);
  const ensureDrawRef = useRef<() => void>(() => undefined);
  const readyRef = useRef(false);
  const draggingRef = useRef(false);
  const seekPointerRef = useRef<number | null>(null);
  const resumeAfterSeekRef = useRef(false);
  const layoutKeyRef = useRef("");
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [duration, setDuration] = useState(0);
  const controlsVisible = hovering || focusWithin || !playing;

  useEffect(() => {
    strengthTargetRef.current = controlsVisible ? 1 : 0;
    ensureDrawRef.current();
  }, [controlsVisible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const player = playerRef.current;
    if (!canvas || !video || !player) return;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) return;
    let vertex: WebGLShader;
    let fragment: WebGLShader;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, VIDEO_VERTEX);
      fragment = compile(gl, gl.FRAGMENT_SHADER, VIDEO_FRAGMENT);
    } catch {
      return;
    }
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const videoTexture = texture(gl);
    gl.uniform1i(gl.getUniformLocation(program, "u_video"), 0);
    const locations = {
      size: gl.getUniformLocation(program, "u_size"),
      texel: gl.getUniformLocation(program, "u_texel"),
      fit: gl.getUniformLocation(program, "u_fit"),
      circles: [0, 1, 2].map((index) => gl.getUniformLocation(program, `u_circles[${index}]`)),
      press: gl.getUniformLocation(program, "u_press[0]"),
      baseScale: gl.getUniformLocation(program, "u_baseScale[0]"),
      depthRatio: gl.getUniformLocation(program, "u_depthRatio[0]"),
      domeRadius: gl.getUniformLocation(program, "u_domeRadius[0]"),
      domeScale: gl.getUniformLocation(program, "u_domeScale[0]"),
      edgeStrength: gl.getUniformLocation(program, "u_edgeStrength[0]"),
      edgeWidth: gl.getUniformLocation(program, "u_edgeWidth[0]"),
      bar: gl.getUniformLocation(program, "u_bar"),
      barRadius: gl.getUniformLocation(program, "u_barRadius"),
      barScale: gl.getUniformLocation(program, "u_barScale"),
      strength: gl.getUniformLocation(program, "u_strength"),
    };
    gl.uniform1fv(locations.baseScale, new Float32Array([0.04, 0.07, 0.04]));
    gl.uniform1fv(locations.depthRatio, new Float32Array([0.14, 0.16, 0.14]));
    gl.uniform1fv(locations.edgeStrength, new Float32Array([0.49, 0.5, 0.49]));
    gl.uniform1fv(locations.edgeWidth, new Float32Array([2, 2.5, 2]));
    gl.uniform1f(locations.barScale, 0.04);
    let domeKey = "";
    let sideDome = computeDomeConstants(40, 32.5, 32.5);
    let playDome = computeDomeConstants(35, 55.5, 55.5);

    const videoFrameApi = video as unknown as VideoFrameApi;
    const requestVideoFrame = videoFrameApi.requestVideoFrameCallback?.bind(video);
    const cancelVideoFrame = videoFrameApi.cancelVideoFrameCallback?.bind(video);
    let visible = true;
    let resumeWhenVisible = false;
    let textureReady = false;
    let previousDrawTime = performance.now();

    const buttonTarget = (index: number) =>
      pressTargetRef.current[index]! * (hoverRef.current[index] ? BUTTON_HOVER_SCALE : 1);

    const controlsMoving = () =>
      pressRef.current.some((value, index) =>
        Math.abs(value - buttonTarget(index)) > 0.001 || Math.abs(scaleVelocityRef.current[index]!) > 0.005)
      || Math.abs(strengthRef.current - strengthTargetRef.current) > 0.001
      || Math.abs(barStretchRef.current - barStretchTargetRef.current) > 0.01
      || Math.abs(barStretchVelocityRef.current) > 0.01;

    // Keep the DOM controls on the same geometry the shader refracts.
    const applyLayoutToControls = (layout: LensLayout) => {
      const key = `${layout.playSize}:${layout.sideSize}:${layout.circles.map((circle) => circle.join(",")).join("|")}:${layout.margin}:${layout.barHeight}`;
      if (key === layoutKeyRef.current) return;
      layoutKeyRef.current = key;
      layout.circles.forEach((circle, index) => {
        const button = buttonRefs.current[index];
        if (!button) return;
        const size = index === 1 ? layout.playSize : layout.sideSize;
        button.style.width = `${size}px`;
        button.style.height = `${size}px`;
        button.style.left = `${circle[0]}px`;
        button.style.top = `${circle[1]}px`;
        button.style.display = circle[2] > 0 ? "" : "none";
      });
      const bar = barRef.current;
      if (bar) {
        bar.style.left = `${layout.margin}px`;
        bar.style.right = `${layout.margin}px`;
        bar.style.bottom = `${layout.margin}px`;
        bar.style.height = `${layout.barHeight}px`;
        bar.style.padding = `0 ${Math.round(layout.barHeight * 0.47)}px`;
      }
    };

    const draw = (uploadVideo: boolean, now = performance.now()) => {
      if (!visible) return;
      if (video.readyState < 2 || !player.clientWidth || !player.clientHeight) return;
      const elapsed = Math.min((now - previousDrawTime) / 1_000, 0.033);
      previousDrawTime = now;
      const ratio = Math.min(2.5, 1.25 * (window.devicePixelRatio || 1));
      const width = player.clientWidth;
      const height = player.clientHeight;
      const displayWidth = Math.round(width * ratio);
      const displayHeight = Math.round(height * ratio);
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
      }
      for (let index = 0; index < 3; index += 1) {
        const config = index === 1 ? PLAY_BUTTON_SPRING : SIDE_BUTTON_SPRING;
        const [scale, velocity] = stepSpring(
          pressRef.current[index]!,
          scaleVelocityRef.current[index]!,
          buttonTarget(index),
          config,
          elapsed,
        );
        pressRef.current[index] = scale;
        scaleVelocityRef.current[index] = velocity;
        const button = buttonRefs.current[index];
        if (button) button.style.transform = `translate(-50%, -50%) scale(${scale})`;
      }
      const strengthTarget = strengthTargetRef.current;
      strengthRef.current = Math.abs(strengthTarget - strengthRef.current) < 0.001
        ? strengthTarget
        : strengthRef.current + (strengthTarget - strengthRef.current) * 0.18;
      [barStretchRef.current, barStretchVelocityRef.current] = stepSpring(
        barStretchRef.current,
        barStretchVelocityRef.current,
        barStretchTargetRef.current,
        BAR_DRAG_SPRING,
        elapsed,
      );
      const layout = lensLayout(width, height);
      applyLayoutToControls(layout);
      const nextDomeKey = `${layout.sideSize}:${layout.playSize}`;
      if (nextDomeKey !== domeKey) {
        domeKey = nextDomeKey;
        sideDome = computeDomeConstants(40 * layout.scale, layout.sideSize / 2, layout.sideSize / 2);
        playDome = computeDomeConstants(35 * layout.scale, layout.playSize / 2, layout.playSize / 2);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      if (uploadVideo || textureDirtyRef.current || !textureReady) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          textureReady = true;
          textureDirtyRef.current = false;
        } catch {
          return;
        }
      }
      // Letterbox instead of stretching when the frame and the video disagree.
      const videoAspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : width / height;
      const frameAspect = width / height;
      const fitX = frameAspect > videoAspect ? frameAspect / videoAspect : 1;
      const fitY = frameAspect > videoAspect ? 1 : videoAspect / frameAspect;
      gl.uniform2f(locations.fit, fitX, fitY);
      gl.uniform2f(locations.size, width, height);
      gl.uniform2f(locations.texel, 1 / canvas.width, 1 / canvas.height);
      layout.circles.forEach((circle, index) => gl.uniform3f(locations.circles[index]!, circle[0], circle[1], circle[2]));
      gl.uniform1fv(locations.press, new Float32Array(pressRef.current));
      gl.uniform1fv(locations.domeRadius, new Float32Array([sideDome.Rx, playDome.Rx, sideDome.Rx]));
      gl.uniform1fv(locations.domeScale, new Float32Array([sideDome.scaleX, playDome.scaleX, sideDome.scaleX]));
      const barStretch = barStretchRef.current;
      const barWidth = layout.bar[2] + Math.abs(barStretch);
      const barCenterX = layout.bar[0] + barStretch * 0.5;
      gl.uniform4f(locations.bar, barCenterX, layout.bar[1], barWidth, layout.bar[3]);
      gl.uniform1f(locations.barRadius, layout.bar[4]);
      const bar = barRef.current;
      if (bar) {
        bar.style.transformOrigin = barStretch >= 0 ? "0 50%" : "100% 50%";
        bar.style.transform = `scaleX(${1 + Math.abs(barStretch) / Math.max(1, layout.bar[2])})`;
      }
      gl.uniform1f(locations.strength, strengthRef.current);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (progressRef.current && Number.isFinite(video.duration) && video.duration > 0) {
        progressRef.current.style.width = `${(video.currentTime / video.duration) * 100}%`;
      }
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      }
    };

    const cancelScheduled = () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      if (videoFrameRef.current && cancelVideoFrame) cancelVideoFrame(videoFrameRef.current);
      videoFrameRef.current = 0;
    };

    const scheduleVideoFrame = () => {
      if (!visible || video.paused || videoFrameRef.current || !requestVideoFrame) return;
      videoFrameRef.current = requestVideoFrame((now) => {
        videoFrameRef.current = 0;
        draw(true, now);
        scheduleVideoFrame();
      });
    };

    const scheduleAnimationFrame = () => {
      if (!visible || frameRef.current) return;
      frameRef.current = requestAnimationFrame((now) => {
        frameRef.current = 0;
        const fallbackVideoFrame = !requestVideoFrame && !video.paused;
        draw(fallbackVideoFrame, now);
        if (fallbackVideoFrame || controlsMoving()) scheduleAnimationFrame();
      });
    };

    const ensureDraw = () => {
      if (!visible) return;
      if (!video.paused && requestVideoFrame) scheduleVideoFrame();
      if (video.paused || controlsMoving() || !requestVideoFrame) scheduleAnimationFrame();
    };

    ensureDrawRef.current = ensureDraw;
    const onPlay = () => ensureDraw();
    const onPause = () => {
      cancelScheduled();
      ensureDraw();
    };
    const onSeeked = () => {
      textureDirtyRef.current = true;
      ensureDraw();
    };
    const onLoadedData = () => {
      textureDirtyRef.current = true;
      ensureDraw();
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", onLoadedData);

    // Canvas nodes resize with the frame; redraw so the lenses re-centre.
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          textureDirtyRef.current = true;
          ensureDraw();
        })
      : null;
    resizeObserver?.observe(player);

    const visibilityObserver = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
          if (!visible) {
            resumeWhenVisible = !video.paused;
            cancelScheduled();
            if (resumeWhenVisible) video.pause();
            return;
          }
          if (resumeWhenVisible) {
            resumeWhenVisible = false;
            void video.play().catch(() => ensureDraw());
          } else {
            ensureDraw();
          }
        }, { rootMargin: "120px 0px" })
      : null;
    visibilityObserver?.observe(player);
    ensureDraw();

    return () => {
      visibilityObserver?.disconnect();
      resizeObserver?.disconnect();
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onLoadedData);
      ensureDrawRef.current = () => undefined;
      cancelScheduled();
      gl.deleteTexture(videoTexture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, []);

  const skip = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
    textureDirtyRef.current = true;
    ensureDrawRef.current();
  }, []);

  const seek = useCallback((clientX: number) => {
    const player = playerRef.current;
    const video = videoRef.current;
    const bar = barRef.current;
    if (!player || !video || !bar || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = player.getBoundingClientRect();
    // The bar may be CSS-scaled with the canvas; measure the track in screen px.
    const barRect = bar.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(bar).paddingLeft) || 0;
    const screenScale = rect.width / Math.max(1, player.clientWidth);
    const trackLeft = barRect.left + padding * screenScale;
    const trackWidth = Math.max(1, barRect.width - padding * 2 * screenScale);
    const rawProgress = (clientX - trackLeft) / trackWidth;
    const progress = Math.max(0, Math.min(1, rawProgress));
    const layout = lensLayout(player.clientWidth, player.clientHeight);
    barStretchTargetRef.current = seekRubberBand((rawProgress - progress) * trackWidth / screenScale, layout.margin);
    video.currentTime = progress * video.duration;
    textureDirtyRef.current = true;
    if (progressRef.current) progressRef.current.style.width = `${progress * 100}%`;
    ensureDrawRef.current();
  }, []);

  const finishSeek = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const activePointerId = seekPointerRef.current;
    seekPointerRef.current = null;
    if (activePointerId !== null && barRef.current?.hasPointerCapture(activePointerId)) {
      try {
        barRef.current.releasePointerCapture(activePointerId);
      } catch {
        // already released
      }
    }
    barStretchTargetRef.current = 0;
    ensureDrawRef.current();
    if (resumeAfterSeekRef.current) void videoRef.current?.play().catch(() => setPlaying(false));
    resumeAfterSeekRef.current = false;
  }, []);
  const { arm: armSeekFallback, disarm: disarmSeekFallback } = usePointerReleaseFallback(finishSeek);

  const startSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    seekPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    armSeekFallback(event.pointerId);
    draggingRef.current = true;
    const video = videoRef.current;
    resumeAfterSeekRef.current = !!video && !video.paused;
    video?.pause();
    ensureDrawRef.current();
    seek(event.clientX);
  };
  const moveSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current && event.pointerId === seekPointerRef.current) seek(event.clientX);
  };
  const endSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== seekPointerRef.current) return;
    disarmSeekFallback();
    finishSeek();
  };

  const press = (index: number, value: number) => {
    pressTargetRef.current[index] = value;
    ensureDrawRef.current();
  };
  const hover = (index: number, value: boolean) => {
    hoverRef.current[index] = value;
    ensureDrawRef.current();
  };
  const stopNodeGesture = (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation();

  const controlButton = (
    index: number,
    label: string,
    className: string,
    onClick: () => void,
    glyph: React.ReactNode,
  ) => (
    <button
      ref={(element) => { buttonRefs.current[index] = element; }}
      type="button"
      aria-label={label}
      className={cn("design-canvas-video-player__button nodrag nopan", className)}
      onPointerDown={(event) => {
        stopNodeGesture(event);
        press(index, 0.8);
      }}
      onPointerUp={() => press(index, 1)}
      onPointerCancel={() => press(index, 1)}
      onMouseEnter={() => hover(index, true)}
      onMouseLeave={() => {
        hover(index, false);
        press(index, 1);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {glyph}
    </button>
  );

  return (
    <div
      ref={playerRef}
      className="design-canvas-video-player"
      data-playing={playing || undefined}
      data-focused={focused || undefined}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        loop
        playsInline
        preload="auto"
        className="design-canvas-video-player__video"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            onNaturalSize?.({ width: video.videoWidth, height: video.videoHeight });
          }
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={onError}
      />
      <canvas
        ref={canvasRef}
        className="design-canvas-video-player__canvas"
        style={{ opacity: ready ? 1 : 0 }}
        aria-label={`${name}, refracted through glass controls`}
        role="img"
      />
      <div className="design-canvas-video-player__controls" data-visible={controlsVisible && ready ? "true" : "false"}>
        {controlButton(0, "Rewind 15 seconds", "design-canvas-video-player__button--small", () => skip(-15), <RewindGlyph />)}
        {controlButton(1, playing ? `Pause ${name}` : `Play ${name}`, "design-canvas-video-player__button--large", togglePlayback, playing ? <PauseGlyph /> : <PlayGlyph />)}
        {controlButton(2, "Forward 15 seconds", "design-canvas-video-player__button--small", () => skip(15), <ForwardGlyph />)}
        <div
          ref={barRef}
          className="design-canvas-video-player__bar nodrag nopan"
          role="slider"
          aria-label={`Seek ${name}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration || 0)}
          aria-valuenow={Math.round(videoRef.current?.currentTime ?? 0)}
          tabIndex={0}
          onPointerDown={startSeek}
          onPointerMove={moveSeek}
          onPointerUp={endSeek}
          onPointerCancel={endSeek}
          onLostPointerCapture={endSeek}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") skip(-15);
            else if (event.key === "ArrowRight") skip(15);
            else return;
            event.preventDefault();
          }}
        >
          <div className="design-canvas-video-player__track"><div ref={progressRef} className="design-canvas-video-player__progress" /></div>
          <button
            type="button"
            className="design-canvas-video-player__mute"
            aria-label={muted ? `Unmute ${name}` : `Mute ${name}`}
            onPointerDown={stopNodeGesture}
            onClick={(event) => {
              event.stopPropagation();
              const next = !muted;
              setMuted(next);
              if (videoRef.current) videoRef.current.muted = next;
            }}
          >
            {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  );
}
