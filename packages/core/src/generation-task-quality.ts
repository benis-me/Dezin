import { isDeepStrictEqual } from "node:util";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_FRAME_COUNT = 64;
const MAX_FRAME_DIMENSION = 16_384;
const MAX_FRAME_PIXELS = 268_435_456;

export interface GenerationTaskArtifactQualityGateInput {
  qaProfile: unknown;
  plannedFrames: unknown;
  renderSpec: unknown;
  quality: unknown;
  evidence: unknown;
}

export class GenerationTaskQualityGateError extends Error {
  readonly failureClass = "qa" as const;
  readonly code = "generation-task-quality-gate" as const;

  constructor(message: string) {
    super(message);
    this.name = "GenerationTaskQualityGateError";
  }
}

function fail(message: string): never {
  throw new GenerationTaskQualityGateError(message);
}

function isWellFormedUtf16(value: string): boolean {
  const native = value as string & { isWellFormed?: () => boolean };
  if (typeof native.isWellFormed === "function") return native.isWellFormed();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface CloneState {
  ancestors: WeakSet<object>;
  nodes: number;
}

function canonicalClone(value: unknown, label: string, state: CloneState, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    fail(`${label} exceeds the quality evidence boundary budget`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) fail(`${label} contains malformed Unicode`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") fail(`${label} must contain only JSON data`);
  if (state.ancestors.has(value)) fail(`${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain array`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
        || (key !== "length" && !/^\d+$/.test(key)))) {
        fail(`${label} must be a dense data array`);
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          fail(`${label} must be a dense data array`);
        }
        output.push(canonicalClone(descriptor.value, `${label}[${index}]`, state, depth + 1));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail(`${label} cannot contain symbol fields`);
    const output: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail(`${label} contains unsafe field ${key}`);
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) fail(`${label}.${key} must be data`);
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: canonicalClone(descriptor.value, `${label}.${key}`, state, depth + 1),
        writable: true,
      });
    }
    return output;
  } catch {
    fail(`${label} could not be inspected safely`);
  } finally {
    state.ancestors.delete(value);
  }
}

function normalized(value: unknown, label: string): unknown {
  return canonicalClone(value, label, { ancestors: new WeakSet<object>(), nodes: 0 });
}

function record(value: unknown, label: string): Record<string, unknown> {
  const candidate = normalized(value, label);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail(`${label} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  const candidate = normalized(value, label);
  if (!Array.isArray(candidate)) fail(`${label} must be an array`);
  return candidate;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) {
    fail(`${label} fields are invalid`);
  }
}

function text(value: unknown, label: string, maxLength = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || !isWellFormedUtf16(value)) {
    fail(`${label} must be non-empty bounded text`);
  }
  return value;
}

function validateFrame(value: unknown, index: number): Record<string, unknown> {
  const frame = value as Record<string, unknown>;
  const allowed = new Set(["id", "name", "width", "height", "initialState", "fixture", "background"]);
  if (Object.keys(frame).some((key) => !allowed.has(key))) {
    fail(`Artifact RenderSpec Frame ${index} contains unsupported fields`);
  }
  const id = text(frame.id, `Artifact RenderSpec Frame ${index} id`, 256);
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
    || (frame.width as number) < 1 || (frame.height as number) < 1
    || (frame.width as number) > MAX_FRAME_DIMENSION || (frame.height as number) > MAX_FRAME_DIMENSION
    || (frame.width as number) * (frame.height as number) > MAX_FRAME_PIXELS) {
    fail(`Artifact RenderSpec Frame ${id} dimensions are invalid`);
  }
  if (frame.name !== undefined) text(frame.name, `Artifact RenderSpec Frame ${id} name`, 512);
  if (frame.initialState !== undefined) {
    text(frame.initialState, `Artifact RenderSpec Frame ${id} initial state`, 256);
  }
  if (frame.background !== undefined) {
    text(frame.background, `Artifact RenderSpec Frame ${id} background`, 4_096);
  }
  if (frame.fixture !== undefined
    && (frame.fixture === null || typeof frame.fixture !== "object" || Array.isArray(frame.fixture))) {
    fail(`Artifact RenderSpec Frame ${id} fixture must be an object`);
  }
  return frame;
}

function validateProfile(value: unknown): {
  requiredFrameIds: string[];
  blockingSeverities: string[];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
} {
  const profile = record(value, "Generation Task QA profile");
  exactFields(profile, [
    "requiredFrameIds", "blockingSeverities", "requireRuntimeChecks", "requireVisualReview",
  ], "Generation Task QA profile");
  if (!Array.isArray(profile.requiredFrameIds) || !Array.isArray(profile.blockingSeverities)
    || typeof profile.requireRuntimeChecks !== "boolean"
    || typeof profile.requireVisualReview !== "boolean") {
    fail("Generation Task QA profile is invalid");
  }
  const requiredFrameIds = profile.requiredFrameIds.map((value, index) => text(
    value,
    `Generation Task required Frame ${index}`,
    256,
  ));
  const blockingSeverities = profile.blockingSeverities.map((severity) => {
    if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
      fail("Generation Task blocking severity is invalid");
    }
    return severity;
  });
  if (new Set(requiredFrameIds).size !== requiredFrameIds.length
    || new Set(blockingSeverities).size !== blockingSeverities.length) {
    fail("Generation Task QA profile entries must be unique");
  }
  return {
    requiredFrameIds,
    blockingSeverities,
    requireRuntimeChecks: profile.requireRuntimeChecks,
    requireVisualReview: profile.requireVisualReview,
  };
}

function validateFrames(input: {
  plannedFrames: unknown;
  renderSpec: unknown;
  requiredFrameIds: readonly string[];
}): void {
  const plannedFrames = array(input.plannedFrames, "Generation Task planned Frames");
  const renderSpec = record(input.renderSpec, "Artifact RenderSpec");
  if (!Array.isArray(renderSpec.frames)
    || renderSpec.frames.length === 0 || renderSpec.frames.length > MAX_FRAME_COUNT) {
    fail("Artifact RenderSpec must contain between 1 and 64 Frames");
  }
  const frames = renderSpec.frames.map(validateFrame);
  const frameIds = frames.map((frame) => frame.id as string);
  if (new Set(frameIds).size !== frameIds.length) fail("Artifact RenderSpec Frame ids must be unique");
  if (plannedFrames.length > 0 && !isDeepStrictEqual(frames, plannedFrames)) {
    fail("Artifact RenderSpec Frames diverge from the immutable Task plan");
  }
  for (const requiredFrameId of input.requiredFrameIds) {
    if (!frameIds.includes(requiredFrameId)) {
      fail(`Artifact RenderSpec is missing required Frame ${requiredFrameId}`);
    }
  }
}

function validateQuality(
  value: unknown,
  blockingSeverities: readonly string[],
): void {
  const quality = record(value, "Artifact quality result");
  exactFields(quality, ["state", "score", "findings"], "Artifact quality result");
  if (quality.state !== "passed" && quality.state !== "needs-attention"
    && quality.state !== "failed" && quality.state !== "unassessed") {
    fail("Artifact quality state is invalid");
  }
  if (typeof quality.score !== "number" || !Number.isFinite(quality.score)
    || quality.score < 0 || quality.score > 100) {
    fail("Artifact quality score must be between 0 and 100");
  }
  if (!Array.isArray(quality.findings) || quality.findings.length > 10_000) {
    fail("Artifact quality findings are invalid");
  }
  const findingIds = new Set<string>();
  const activeSeverities: string[] = [];
  const allowed = new Set([
    "severity", "id", "message", "fix", "snippet", "selector", "screenshotPath", "screenshotUrl",
    "reviewSummary", "reviewStatus", "reviewRound", "corroborated",
  ]);
  for (let index = 0; index < quality.findings.length; index += 1) {
    const finding = quality.findings[index] as Record<string, unknown>;
    if (Object.keys(finding).some((key) => !allowed.has(key))) {
      fail(`Artifact quality finding ${index} contains unsupported fields`);
    }
    if (finding.severity !== "P0" && finding.severity !== "P1" && finding.severity !== "P2") {
      fail(`Artifact quality finding ${index} severity is invalid`);
    }
    const id = text(finding.id, `Artifact quality finding ${index} id`, 512);
    if (findingIds.has(id)) fail(`Artifact quality finding id ${id} is duplicated`);
    findingIds.add(id);
    text(finding.message, `Artifact quality finding ${id} message`);
    text(finding.fix, `Artifact quality finding ${id} fix`);
    for (const field of [
      "snippet", "selector", "screenshotPath", "screenshotUrl", "reviewSummary",
    ] as const) {
      if (finding[field] !== undefined) text(finding[field], `Artifact quality finding ${id} ${field}`);
    }
    if (finding.reviewStatus !== undefined
      && finding.reviewStatus !== "active" && finding.reviewStatus !== "resolved") {
      fail(`Artifact quality finding ${id} review status is invalid`);
    }
    if (finding.reviewRound !== undefined
      && (!Number.isSafeInteger(finding.reviewRound) || (finding.reviewRound as number) < 0)) {
      fail(`Artifact quality finding ${id} review round is invalid`);
    }
    if (finding.corroborated !== undefined && typeof finding.corroborated !== "boolean") {
      fail(`Artifact quality finding ${id} corroboration is invalid`);
    }
    if (finding.reviewStatus !== "resolved") activeSeverities.push(finding.severity);
  }
  const blocking = new Set(blockingSeverities);
  const blockingSeverity = activeSeverities.find((severity) => blocking.has(severity));
  if (blockingSeverity !== undefined) {
    fail(`Artifact quality contains an active blocking ${blockingSeverity} finding`);
  }
  if (quality.state === "failed" || quality.state === "unassessed") {
    fail(`Artifact quality state ${quality.state} cannot be published`);
  }
  if ((activeSeverities.length === 0) !== (quality.state === "passed")) {
    fail("Artifact quality state does not match its active findings");
  }
}

function validateEvidence(value: unknown, input: {
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
}): void {
  const evidence = record(value, "Artifact candidate evidence");
  const runtimeChecks = evidence.runtimeChecks;
  if (input.requireRuntimeChecks || runtimeChecks !== undefined) {
    if (!Array.isArray(runtimeChecks) || runtimeChecks.length === 0 || runtimeChecks.length > 1_000) {
      fail("Artifact candidate requires non-empty runtime-check evidence");
    }
    const ids = new Set<string>();
    for (let index = 0; index < runtimeChecks.length; index += 1) {
      const check = runtimeChecks[index] as Record<string, unknown>;
      exactFields(check, ["id", "status"], `Artifact runtime check ${index}`);
      const id = text(check.id, `Artifact runtime check ${index} id`, 512);
      if (ids.has(id)) fail(`Artifact runtime check id ${id} is duplicated`);
      ids.add(id);
      if (check.status !== "passed") fail(`Artifact runtime check ${id} did not pass`);
    }
  }
  const visualReview = evidence.visualReview;
  if (input.requireVisualReview || visualReview !== undefined) {
    if (visualReview === null || typeof visualReview !== "object" || Array.isArray(visualReview)) {
      fail("Artifact candidate requires visual-review evidence");
    }
    const review = visualReview as Record<string, unknown>;
    if (review.status !== "passed") fail("Artifact visual review did not pass");
    if (typeof review.fidelity !== "number" || !Number.isFinite(review.fidelity)
      || review.fidelity < 0 || review.fidelity > 1) {
      fail("Artifact visual review fidelity must be between 0 and 1");
    }
  }
}

export function validateGenerationTaskArtifactQualityGate(
  unsafeInput: GenerationTaskArtifactQualityGateInput,
): void {
  try {
    const input = record(unsafeInput, "Generation Task Artifact quality gate input");
    exactFields(input, ["qaProfile", "plannedFrames", "renderSpec", "quality", "evidence"],
      "Generation Task Artifact quality gate input");
    const profile = validateProfile(input.qaProfile);
    validateFrames({
      plannedFrames: input.plannedFrames,
      renderSpec: input.renderSpec,
      requiredFrameIds: profile.requiredFrameIds,
    });
    validateQuality(input.quality, profile.blockingSeverities);
    validateEvidence(input.evidence, profile);
  } catch (error) {
    if (error instanceof GenerationTaskQualityGateError) throw error;
    fail("Generation Task Artifact quality evidence could not be validated safely");
  }
}
