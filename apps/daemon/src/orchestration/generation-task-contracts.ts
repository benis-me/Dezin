import { types as nodeUtilTypes } from "node:util";
import type { GenerationTask } from "../../../../packages/core/src/index.ts";

const OBJECT_PROTOTYPE_KEYS = new Set<PropertyKey>(Reflect.ownKeys(Object.prototype));
const ARRAY_PROTOTYPE_KEYS = new Set<PropertyKey>(Reflect.ownKeys(Array.prototype));
const RESOURCE_KINDS = new Set([
  "research",
  "moodboard",
  "sharingan-capture",
  "file",
  "asset",
  "effect",
  "external-reference",
]);
const CAPABILITY_KINDS = new Set(["text", "image", "video", "browser", "visual-qa"]);
const VIEWER_BRIDGE_TEXT_CONTROL = /[\u0000-\u001f\u007f]/;
const VIEWER_BRIDGE_FRAME_TEXT_LIMIT = 256;
const VIEWER_BRIDGE_BACKGROUND_LIMIT = 4_096;
const VIEWER_BRIDGE_FIXTURE_DEPTH_LIMIT = 16;
const VIEWER_BRIDGE_FIXTURE_NODE_LIMIT = 4_096;
const VIEWER_BRIDGE_FIXTURE_MEMBER_LIMIT = 256;
const VIEWER_BRIDGE_FIXTURE_STRING_LIMIT = 8_192;
const VIEWER_BRIDGE_FRAME_JSON_LIMIT = 65_536;
const JSON_DEPTH_LIMIT = 64;
const JSON_NODE_LIMIT = 100_000;

export type GenerationTaskPayloadContractCode =
  | "GENERATION_TASK_PAYLOAD_INVALID"
  | "GENERATION_TASK_PAYLOAD_LEGACY_V1";
export type GenerationTaskPayloadDisposition = "reject" | "recompile-required";

export class GenerationTaskPayloadContractError extends Error {
  readonly code: GenerationTaskPayloadContractCode;
  readonly disposition: GenerationTaskPayloadDisposition;
  readonly failureClass = "build" as const;

  constructor(
    message: string,
    options: {
      code?: GenerationTaskPayloadContractCode;
      disposition?: GenerationTaskPayloadDisposition;
    } = {},
  ) {
    super(message);
    this.name = "GenerationTaskPayloadContractError";
    this.code = options.code ?? "GENERATION_TASK_PAYLOAD_INVALID";
    this.disposition = options.disposition ?? "reject";
  }
}

function fail(message: string): never {
  throw new GenerationTaskPayloadContractError(message);
}

function failLegacyV1(kind: GenerationTask["kind"]): never {
  throw new GenerationTaskPayloadContractError(
    `${kind} Task uses the legacy v1 payload and must be recompiled before execution`,
    {
      code: "GENERATION_TASK_PAYLOAD_LEGACY_V1",
      disposition: "recompile-required",
    },
  );
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail(`${label} could not be inspected safely`);
  }
  if (value === null || typeof value !== "object" || isArray || nodeUtilTypes.isProxy(value)) {
    fail(`${label} must be a non-proxy plain object`);
  }
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  if (prototype === Object.prototype) {
    let inheritedKeys: PropertyKey[];
    try {
      inheritedKeys = Reflect.ownKeys(prototype);
    } catch {
      fail(`${label} could not be inspected safely`);
    }
    if (inheritedKeys.some((key) => !OBJECT_PROTOTYPE_KEYS.has(key))) {
      fail(`${label} has an inherited field`);
    }
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") fail(`${label} cannot contain symbol fields`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label} could not be inspected safely`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value: unknown, label: string): unknown[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail(`${label} could not be inspected safely`);
  }
  if (!isArray || nodeUtilTypes.isProxy(value)) fail(`${label} must be a non-proxy array`);
  let prototype: object | null;
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value as object);
    keys = Reflect.ownKeys(value as object);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value as object, "length");
  } catch {
    fail(`${label} could not be inspected safely`);
  }
  if (prototype !== Array.prototype) fail(`${label} must use the standard array prototype`);
  let inheritedKeys: PropertyKey[];
  try {
    inheritedKeys = Reflect.ownKeys(Array.prototype);
  } catch {
    fail(`${label} could not be inspected safely`);
  }
  if (inheritedKeys.some((key) => !ARRAY_PROTOTYPE_KEYS.has(key))) {
    fail(`${label} has an inherited field`);
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0) {
    fail(`${label} length must be a non-negative safe integer data property`);
  }
  const length = Number(lengthDescriptor.value);
  for (const key of keys) {
    if (typeof key !== "string") fail(`${label} cannot contain symbol fields`);
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= length) {
      fail(`${label} has unexpected field ${key}`);
    }
  }
  const source = value as unknown[];
  const result = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    } catch {
      fail(`${label} could not be inspected safely`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${label} must be dense data`);
    }
    result[index] = descriptor.value;
  }
  return result;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = plainRecord(value, label);
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (required.some((key) => !Object.hasOwn(record, key)) || keys.some((key) => !allowed.has(key))) {
    fail(`${label} fields are invalid`);
  }
  if (requiredSet.size !== required.length || allowed.size !== required.length + optional.length) {
    fail(`${label} contract contains duplicate fields`);
  }
  return record;
}

function canonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (!isWellFormedUtf16(value)) fail(`${label} must contain well-formed Unicode`);
  if (value !== value.trim()) fail(`${label} must be canonical`);
  return value;
}

function nullableCanonicalString(value: unknown, label: string): string | null {
  return value === null ? null : canonicalString(value, label);
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive finite number`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  options: { unique?: boolean; sorted?: boolean } = {},
): string[] {
  const result = denseArray(value, label).map((entry, index) => canonicalString(entry, `${label}[${index}]`));
  if (options.unique && new Set(result).size !== result.length) fail(`${label} must be unique`);
  if (options.sorted) {
    const sorted = [...result].sort(compareBinary);
    if (result.some((entry, index) => entry !== sorted[index])) fail(`${label} must be sorted`);
  }
  return result;
}

interface JsonBoundaryState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function validateJsonValue(
  value: unknown,
  label: string,
  state: JsonBoundaryState = { ancestors: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > JSON_NODE_LIMIT || depth > JSON_DEPTH_LIMIT) {
    fail(`${label} exceeds the JSON boundary budget`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) fail(`${label} JSON strings must contain well-formed Unicode`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} JSON numbers must be finite`);
    return;
  }
  if (typeof value !== "object") fail(`${label} must contain only JSON values`);
  if (state.ancestors.has(value)) fail(`${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    let array = false;
    try {
      array = Array.isArray(value);
    } catch {
      fail(`${label} could not be inspected safely`);
    }
    if (array) {
      for (const [index, entry] of denseArray(value, label).entries()) {
        validateJsonValue(entry, `${label}[${index}]`, state, depth + 1);
      }
      return;
    }
    const record = plainRecord(value, label);
    for (const key of Object.keys(record)) {
      if (!isWellFormedUtf16(key)) fail(`${label} JSON keys must contain well-formed Unicode`);
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail(`${label} contains unsafe field ${key}`);
      }
      validateJsonValue(record[key], `${label}.${key}`, state, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function validateJsonObject(value: unknown, label: string): void {
  plainRecord(value, label);
  validateJsonValue(value, label);
}

interface FixtureBoundaryState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function viewerText(value: unknown, label: string, limit: number): string {
  const text = canonicalString(value, label);
  if (text.length > limit) fail(`${label} exceeds the Viewer bridge length limit of ${limit}`);
  if (VIEWER_BRIDGE_TEXT_CONTROL.test(text)) fail(`${label} cannot contain C0 or DEL control characters`);
  return text;
}

function viewerFixtureKey(value: string, label: string): void {
  if (value.length === 0 || value.length > VIEWER_BRIDGE_FRAME_TEXT_LIMIT) {
    fail(`${label} exceeds the Viewer bridge length limit of ${VIEWER_BRIDGE_FRAME_TEXT_LIMIT}`);
  }
  if (!isWellFormedUtf16(value)) fail(`${label} must contain well-formed Unicode`);
  if (VIEWER_BRIDGE_TEXT_CONTROL.test(value)) fail(`${label} cannot contain C0 or DEL control characters`);
}

function validateViewerFixtureValue(
  value: unknown,
  label: string,
  state: FixtureBoundaryState,
  depth: number,
): void {
  state.nodes += 1;
  if (state.nodes > VIEWER_BRIDGE_FIXTURE_NODE_LIMIT) {
    fail(`${label} exceeds the Viewer bridge fixture node limit of ${VIEWER_BRIDGE_FIXTURE_NODE_LIMIT}`);
  }
  if (depth > VIEWER_BRIDGE_FIXTURE_DEPTH_LIMIT) {
    fail(`${label} exceeds the Viewer bridge fixture depth limit of ${VIEWER_BRIDGE_FIXTURE_DEPTH_LIMIT}`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) fail(`${label} strings must contain well-formed Unicode`);
    if (value.length > VIEWER_BRIDGE_FIXTURE_STRING_LIMIT) {
      fail(`${label} exceeds the Viewer bridge fixture string limit of ${VIEWER_BRIDGE_FIXTURE_STRING_LIMIT}`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} numbers must be finite`);
    return;
  }
  if (typeof value !== "object") fail(`${label} must contain only Viewer bridge JSON values`);
  if (state.ancestors.has(value)) fail(`${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    let array = false;
    try {
      array = Array.isArray(value);
    } catch {
      fail(`${label} could not be inspected safely`);
    }
    if (array) {
      const values = denseArray(value, label);
      if (values.length > VIEWER_BRIDGE_FIXTURE_MEMBER_LIMIT) {
        fail(`${label} exceeds the Viewer bridge fixture array member limit of ${VIEWER_BRIDGE_FIXTURE_MEMBER_LIMIT}`);
      }
      for (const [index, entry] of values.entries()) {
        validateViewerFixtureValue(entry, `${label}[${index}]`, state, depth + 1);
      }
      return;
    }
    const record = plainRecord(value, label);
    const keys = Object.keys(record);
    if (keys.length > VIEWER_BRIDGE_FIXTURE_MEMBER_LIMIT) {
      fail(`${label} exceeds the Viewer bridge fixture object member limit of ${VIEWER_BRIDGE_FIXTURE_MEMBER_LIMIT}`);
    }
    for (const key of keys) {
      viewerFixtureKey(key, `${label} key`);
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail(`${label} contains unsafe field ${key}`);
      }
      validateViewerFixtureValue(record[key], `${label}.${key}`, state, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function validateLocator(value: unknown, label: string): void {
  const locator = exactObject(value, ["designNodeId"], ["sourcePath", "selector"], label);
  canonicalString(locator.designNodeId, `${label} designNodeId`);
  if (Object.hasOwn(locator, "sourcePath")) canonicalString(locator.sourcePath, `${label} sourcePath`);
  if (Object.hasOwn(locator, "selector")) canonicalString(locator.selector, `${label} selector`);
}

function validateFrame(value: unknown, label: string): string {
  const frame = exactObject(
    value,
    ["id", "name", "width", "height"],
    ["initialState", "fixture", "background"],
    label,
  );
  const id = viewerText(frame.id, `${label} id`, VIEWER_BRIDGE_FRAME_TEXT_LIMIT);
  canonicalString(frame.name, `${label} name`);
  positiveNumber(frame.width, `${label} width`);
  positiveNumber(frame.height, `${label} height`);
  if (Object.hasOwn(frame, "initialState")) {
    viewerText(frame.initialState, `${label} initialState`, VIEWER_BRIDGE_FRAME_TEXT_LIMIT);
  }
  if (Object.hasOwn(frame, "background")) {
    viewerText(frame.background, `${label} background`, VIEWER_BRIDGE_BACKGROUND_LIMIT);
  }
  if (Object.hasOwn(frame, "fixture")) {
    plainRecord(frame.fixture, `${label} fixture`);
    validateViewerFixtureValue(
      frame.fixture,
      `${label} fixture`,
      { ancestors: new WeakSet<object>(), nodes: 0 },
      0,
    );
  }
  let envelope: string;
  try {
    envelope = JSON.stringify({
      protocol: "dezin-frame-v1",
      frameId: id,
      ...(Object.hasOwn(frame, "initialState") ? { initialState: frame.initialState } : {}),
      ...(Object.hasOwn(frame, "fixture") ? { fixture: frame.fixture } : {}),
      ...(Object.hasOwn(frame, "background") ? { background: frame.background } : {}),
    });
  } catch {
    fail(`${label} Viewer bridge envelope must be JSON serializable`);
  }
  if (envelope.length > VIEWER_BRIDGE_FRAME_JSON_LIMIT) {
    fail(`${label} exceeds the Viewer bridge JSON envelope limit of ${VIEWER_BRIDGE_FRAME_JSON_LIMIT}`);
  }
  return id;
}

function validateFrames(value: unknown, label: string): string[] {
  const ids = denseArray(value, label).map((frame, index) => validateFrame(frame, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) fail(`${label} ids must be unique`);
  const sorted = [...ids].sort(compareBinary);
  if (ids.some((id, index) => id !== sorted[index])) fail(`${label} must be sorted`);
  return ids;
}

function validateComponentDependency(
  value: unknown,
  artifactId: string,
  label: string,
): string {
  const dependency = exactObject(value, [
    "kind",
    "ownerArtifactId",
    "instanceId",
    "componentArtifactId",
    "componentRevisionId",
    "sourceLocator",
    "overrides",
    "status",
  ], ["variantKey", "stateKey"], label);
  if (dependency.kind !== "component-instance") fail(`${label} kind must be component-instance`);
  if (canonicalString(dependency.ownerArtifactId, `${label} owner Artifact id`) !== artifactId) {
    fail(`${label} owner Artifact does not match its Task target`);
  }
  const instanceId = canonicalString(dependency.instanceId, `${label} instance id`);
  const componentArtifactId = canonicalString(dependency.componentArtifactId, `${label} Component Artifact id`);
  const componentRevisionId = nullableCanonicalString(
    dependency.componentRevisionId,
    `${label} Component Revision id`,
  );
  if (componentRevisionId === null && componentArtifactId === artifactId) {
    fail(`${label} cannot depend on its own generated Component`);
  }
  if (Object.hasOwn(dependency, "variantKey")) canonicalString(dependency.variantKey, `${label} variant key`);
  if (Object.hasOwn(dependency, "stateKey")) canonicalString(dependency.stateKey, `${label} state key`);
  validateLocator(dependency.sourceLocator, `${label} source locator`);
  validateJsonObject(dependency.overrides, `${label} overrides`);
  if (dependency.status !== "linked" && dependency.status !== "detached") {
    fail(`${label} status must be linked or detached`);
  }
  return JSON.stringify(["component", artifactId, instanceId]);
}

function validateResourceDependency(value: unknown, artifactId: string, label: string): string {
  const dependency = exactObject(value, ["kind", "ownerArtifactId", "resourceId"], [], label);
  if (dependency.kind !== "resource") fail(`${label} kind must be resource`);
  if (canonicalString(dependency.ownerArtifactId, `${label} owner Artifact id`) !== artifactId) {
    fail(`${label} owner Artifact does not match its Task target`);
  }
  const resourceId = canonicalString(dependency.resourceId, `${label} Resource id`);
  return JSON.stringify(["resource", artifactId, resourceId]);
}

function validateBrief(value: unknown, label: string): Record<string, unknown> {
  const brief = exactObject(
    value,
    ["proposalRationale", "assumptions", "targetInstructions"],
    [],
    label,
  );
  canonicalString(brief.proposalRationale, `${label} Proposal rationale`);
  stringArray(brief.assumptions, `${label} assumptions`);
  return brief;
}

function validateCapabilityDescriptors(
  value: unknown,
  task: GenerationTask,
  label: string,
  requireRequired: boolean,
): void {
  const descriptorIds = denseArray(value, label).map((value, index) => {
    const descriptor = exactObject(value, ["id", "kind", "required"], [], `${label}[${index}]`);
    const id = canonicalString(descriptor.id, `${label}[${index}] id`);
    if (typeof descriptor.kind !== "string" || !CAPABILITY_KINDS.has(descriptor.kind)) {
      fail(`${label}[${index}] capability kind is unsupported`);
    }
    if (typeof descriptor.required !== "boolean") {
      fail(`${label}[${index}] required must be boolean`);
    }
    if (requireRequired && descriptor.required !== true) {
      fail(`${label}[${index}] required must be true for a Resource Task`);
    }
    return id;
  });
  if (new Set(descriptorIds).size !== descriptorIds.length) fail(`${label} ids must be unique`);
  const sortedIds = [...descriptorIds].sort(compareBinary);
  if (descriptorIds.some((id, index) => id !== sortedIds[index])) fail(`${label} must be sorted`);
  const taskCapabilityIds = stringArray(task.capabilities, `${task.kind} Task capabilities`, {
    unique: true,
    sorted: true,
  });
  if (descriptorIds.length !== taskCapabilityIds.length
    || descriptorIds.some((id, index) => id !== taskCapabilityIds[index])) {
    fail(`${label} do not match the Task capabilities`);
  }
}

function validateArtifactPayload(task: GenerationTask): void {
  if (task.target.type !== "artifact") fail(`${task.kind} Task target must be an Artifact`);
  const rawPayload = plainRecord(task.payload, `${task.kind} Task payload`);
  if (rawPayload.version === 1) failLegacyV1(task.kind);
  const payload = exactObject(
    task.payload,
    [
      "version",
      "artifactPlan",
      "dependencyPlans",
      "responsiveFrames",
      "brief",
      "capabilityDescriptors",
    ],
    [],
    `${task.kind} Task payload`,
  );
  if (payload.version !== 2) fail(`${task.kind} Task payload version is unsupported`);
  const plan = exactObject(payload.artifactPlan, [
    "operation",
    "nodeId",
    "artifactId",
    "kind",
    "name",
    "trackId",
    "baseRevisionId",
    "dependsOnArtifactIds",
    "capabilityIds",
    "responsiveFrameIds",
  ], [], `${task.kind} Artifact plan`);
  if (plan.operation !== "create" && plan.operation !== "revise") {
    fail(`${task.kind} Artifact plan operation is unsupported`);
  }
  canonicalString(plan.nodeId, `${task.kind} Artifact plan node id`);
  if (canonicalString(plan.artifactId, `${task.kind} Artifact plan Artifact id`) !== task.target.id) {
    fail(`${task.kind} Artifact plan target does not match its Task`);
  }
  if (plan.kind !== task.kind) fail(`${task.kind} Artifact plan kind does not match its Task`);
  canonicalString(plan.name, `${task.kind} Artifact plan name`);
  if (canonicalString(plan.trackId, `${task.kind} Artifact plan Track id`) !== task.target.trackId) {
    fail(`${task.kind} Artifact plan Track does not match its Task`);
  }
  nullableCanonicalString(plan.baseRevisionId, `${task.kind} Artifact plan base Revision id`);
  stringArray(plan.dependsOnArtifactIds, `${task.kind} Artifact dependency ids`, { unique: true, sorted: true });
  const capabilityIds = stringArray(plan.capabilityIds, `${task.kind} Artifact capability ids`, {
    unique: true,
    sorted: true,
  });
  const taskCapabilitySet = new Set(task.capabilities);
  if (taskCapabilitySet.size !== task.capabilities.length
    || capabilityIds.length !== taskCapabilitySet.size
    || capabilityIds.some((id) => !taskCapabilitySet.has(id))) {
    fail(`${task.kind} Artifact capability ids do not match its Task capabilities`);
  }
  const plannedFrameIds = stringArray(plan.responsiveFrameIds, `${task.kind} Artifact responsive Frame ids`, {
    unique: true,
    sorted: true,
  });
  const dependencies = denseArray(payload.dependencyPlans, `${task.kind} dependency plans`);
  const dependencyKeys = dependencies.map((dependency, index) => {
    const record = plainRecord(dependency, `${task.kind} dependency plan[${index}]`);
    if (record.kind === "component-instance") {
      return validateComponentDependency(dependency, task.target.id, `${task.kind} dependency plan[${index}]`);
    }
    if (record.kind === "resource") {
      return validateResourceDependency(dependency, task.target.id, `${task.kind} dependency plan[${index}]`);
    }
    fail(`${task.kind} dependency plan[${index}] kind is unsupported`);
  });
  if (new Set(dependencyKeys).size !== dependencyKeys.length) {
    fail(`${task.kind} dependency plans must be unique`);
  }
  const sortedDependencyKeys = [...dependencyKeys].sort(compareBinary);
  if (dependencyKeys.some((key, index) => key !== sortedDependencyKeys[index])) {
    fail(`${task.kind} dependency plans must be sorted`);
  }
  const frameIds = validateFrames(payload.responsiveFrames, `${task.kind} responsive Frames`);
  if (frameIds.length !== plannedFrameIds.length
    || frameIds.some((id, index) => id !== plannedFrameIds[index])) {
    fail(`${task.kind} responsive Frame ids do not match its Artifact plan`);
  }
  const brief = validateBrief(payload.brief, `${task.kind} Task brief`);
  const instructions = exactObject(
    brief.targetInstructions,
    ["operation", "kind", "name"],
    [],
    `${task.kind} Task target instructions`,
  );
  if (instructions.operation !== plan.operation) {
    fail(`${task.kind} Task target instructions operation does not match its Artifact plan`);
  }
  if (instructions.kind !== plan.kind) {
    fail(`${task.kind} Task target instructions kind does not match its Artifact plan`);
  }
  if (canonicalString(instructions.name, `${task.kind} Task target instructions name`) !== plan.name) {
    fail(`${task.kind} Task target instructions name does not match its Artifact plan`);
  }
  validateCapabilityDescriptors(
    payload.capabilityDescriptors,
    task,
    `${task.kind} Task capability descriptors`,
    false,
  );
}

function validateResourcePayload(task: GenerationTask): void {
  if (task.target.type !== "resource") fail("Resource Task target must be a Resource");
  const rawPayload = plainRecord(task.payload, "Resource Task payload");
  if (rawPayload.version === 1) failLegacyV1(task.kind);
  const payload = exactObject(
    task.payload,
    ["version", "operation", "brief", "capabilityDescriptors", "adapter"],
    [],
    "Resource Task payload",
  );
  if (payload.version !== 2) fail("Resource Task payload version is unsupported");
  const operation = exactObject(payload.operation, [
    "operation",
    "nodeId",
    "resourceId",
    "kind",
    "title",
    "revisionPolicy",
  ], [], "Resource operation");
  if (operation.operation !== "create" && operation.operation !== "revise") {
    fail("Resource operation must be create or revise");
  }
  canonicalString(operation.nodeId, "Resource operation node id");
  if (canonicalString(operation.resourceId, "Resource operation Resource id") !== task.target.id) {
    fail("Resource operation target does not match its Task");
  }
  if (typeof operation.kind !== "string" || !RESOURCE_KINDS.has(operation.kind)) {
    fail("Resource operation Resource kind is unsupported");
  }
  canonicalString(operation.title, "Resource operation title");
  const policy = exactObject(operation.revisionPolicy, ["kind"], [], "Resource revision policy");
  if (policy.kind !== "generate") fail("Resource Task must use the frozen generate revision policy");
  const brief = validateBrief(payload.brief, "Resource Task brief");
  const instructions = exactObject(
    brief.targetInstructions,
    ["operation", "kind", "title"],
    [],
    "Resource Task target instructions",
  );
  if (instructions.operation !== operation.operation) {
    fail("Resource Task target instructions operation does not match its operation");
  }
  if (instructions.kind !== operation.kind) {
    fail("Resource Task target instructions kind does not match its operation");
  }
  if (canonicalString(instructions.title, "Resource Task target instructions title") !== operation.title) {
    fail("Resource Task target instructions title does not match its operation");
  }
  validateCapabilityDescriptors(
    payload.capabilityDescriptors,
    task,
    "Resource Task capability descriptors",
    true,
  );
  const adapter = exactObject(payload.adapter, ["id", "version", "kind"], [], "Resource Task adapter");
  if (adapter.kind !== operation.kind) fail("Resource Task adapter kind does not match its operation");
  if (adapter.version !== 1) fail("Resource Task adapter version is unsupported");
  if (canonicalString(adapter.id, "Resource Task adapter id") !== `dezin.resource-adapter.${operation.kind}`) {
    fail("Resource Task adapter id does not match its Resource kind");
  }
}

function validateTransition(value: unknown, label: string): void {
  const transition = exactObject(value, ["type"], ["durationMs", "easing"], label);
  if (transition.type !== "none" && transition.type !== "fade" && transition.type !== "slide") {
    fail(`${label} transition type is unsupported`);
  }
  if (Object.hasOwn(transition, "durationMs")) {
    safeInteger(transition.durationMs, `${label} duration`, 0);
  }
  if (Object.hasOwn(transition, "easing")) canonicalString(transition.easing, `${label} easing`);
}

function validatePrototypeIntent(value: unknown, label: string): string {
  const intent = exactObject(value, [
    "edgeId",
    "sourceArtifactId",
    "targetArtifactId",
    "trigger",
  ], ["sourceLocator", "targetState", "transition"], label);
  const edgeId = canonicalString(intent.edgeId, `${label} edge id`);
  canonicalString(intent.sourceArtifactId, `${label} source Artifact id`);
  canonicalString(intent.targetArtifactId, `${label} target Artifact id`);
  if (Object.hasOwn(intent, "sourceLocator")) validateLocator(intent.sourceLocator, `${label} source locator`);
  if (intent.trigger !== "click" && intent.trigger !== "submit") fail(`${label} trigger is unsupported`);
  if (Object.hasOwn(intent, "targetState")) canonicalString(intent.targetState, `${label} target state`);
  if (Object.hasOwn(intent, "transition")) validateTransition(intent.transition, `${label} transition`);
  return edgeId;
}

function validatePrototypePayload(task: GenerationTask): void {
  if (task.target.type !== "workspace" || task.target.id !== task.workspaceId) {
    fail("Prototype validation target must be its Workspace");
  }
  const payload = exactObject(
    task.payload,
    ["version", "prototypeIntents", "responsiveFrames", "artifactIds"],
    [],
    "Prototype validation Task payload",
  );
  if (payload.version !== 1) fail("Prototype validation Task payload version is unsupported");
  const edgeIds = denseArray(payload.prototypeIntents, "Prototype intents")
    .map((intent, index) => validatePrototypeIntent(intent, `Prototype intent[${index}]`));
  if (new Set(edgeIds).size !== edgeIds.length) fail("Prototype intent edge ids must be unique");
  const sortedEdgeIds = [...edgeIds].sort(compareBinary);
  if (edgeIds.some((id, index) => id !== sortedEdgeIds[index])) fail("Prototype intents must be sorted");
  validateFrames(payload.responsiveFrames, "Prototype responsive Frames");
  stringArray(payload.artifactIds, "Prototype Artifact ids", { unique: true });
}

function validateCheckpointPayload(task: GenerationTask): void {
  if (task.target.type !== "workspace" || task.target.id !== task.workspaceId) {
    fail("Checkpoint target must be its Workspace");
  }
  const payload = exactObject(
    task.payload,
    ["version", "proposalId", "proposalRevision", "baseSnapshotId"],
    [],
    "Checkpoint Task payload",
  );
  if (payload.version !== 1) fail("Checkpoint Task payload version is unsupported");
  canonicalString(payload.proposalId, "Checkpoint Proposal id");
  safeInteger(payload.proposalRevision, "Checkpoint Proposal revision", 1);
  canonicalString(payload.baseSnapshotId, "Checkpoint base Snapshot id");
}

function validateReservedPayload(task: GenerationTask): void {
  if (task.kind === "propagation-candidate" && task.target.type !== "artifact") {
    fail("Propagation candidate target must be an Artifact");
  }
  if (task.kind === "propagation-publish"
    && (task.target.type !== "workspace" || task.target.id !== task.workspaceId)) {
    fail("Propagation publish target must be its Workspace");
  }
  const payload = exactObject(task.payload, ["version"], [], `${task.kind} Task payload`);
  if (payload.version !== 1) fail(`${task.kind} Task payload version is unsupported`);
}

function assertNever(kind: never): never {
  return fail(`Unsupported Generation Task kind ${String(kind)}`);
}

/**
 * Validates the complete immutable payload contract emitted by the Plan compiler.
 * Executable Artifact and Resource leaves require v2; durable v1 leaves receive
 * an explicit recompile-required disposition and are never sent to an executor.
 * Propagation kinds intentionally accept only a version marker until Task 13 defines
 * their frozen payloads; the executor still rejects both kinds as non-executable.
 */
export function validateGenerationTaskPayload(task: GenerationTask): void {
  switch (task.kind) {
    case "page":
    case "component":
      validateArtifactPayload(task);
      return;
    case "resource":
      validateResourcePayload(task);
      return;
    case "prototype-validation":
      validatePrototypePayload(task);
      return;
    case "checkpoint":
      validateCheckpointPayload(task);
      return;
    case "propagation-candidate":
    case "propagation-publish":
      validateReservedPayload(task);
      return;
    default:
      return assertNever(task.kind);
  }
}
