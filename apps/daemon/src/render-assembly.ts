import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseJavaScript } from "@babel/parser";
import { parse as parseHtml } from "parse5";
import type {
  ArtifactRevisionDependencyRecord,
  ArtifactRevisionRecord,
  ArtifactRevisionResourcePinRecord,
  SharedDesignKernelRevision,
  Store,
  WorkspaceArtifactRecord,
} from "../../../packages/core/src/index.ts";
import { projectDir, safeJoin } from "./serve-static.ts";
import {
  MAX_RENDER_ASSEMBLY_RESOURCE_BYTES,
  MAX_RENDER_ASSEMBLY_RESOURCES,
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
} from "./resource-revision-payload.ts";

export interface RenderAssemblyTarget {
  projectId: string;
  revisionId: string;
  componentState?: {
    variantKey: string;
    stateKey: string;
  };
}

export interface ComponentFixtureRenderContext {
  protocol: "dezin-component-fixture-v1";
  variantKey: string;
  stateKey: string;
  props: Record<string, unknown>;
  cssVariables?: Record<string, string | number>;
  background?: string;
}

export interface RenderAssembly {
  version: 1;
  projectId: string;
  workspaceId: string;
  artifactId: string;
  artifactRoot: string;
  rootRevision: ArtifactRevisionRecord;
  revisions: ArtifactRevisionRecord[];
  artifacts: WorkspaceArtifactRecord[];
  dependencies: ArtifactRevisionDependencyRecord[];
  resourcePins: ArtifactRevisionResourcePinRecord[];
  resourcePayloads: ResourceRevisionPayloadDescriptor[];
  kernelRevisions: SharedDesignKernelRevision[];
  componentFixture: ComponentFixtureRenderContext | null;
  dependencyLockHash: string;
  assemblyHash: string;
  runtimeKey: string;
}

export class RenderAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderAssemblyError";
  }
}

export class ComponentFixtureContractError extends RenderAssemblyError {
  constructor(message: string) {
    super(message);
    this.name = "ComponentFixtureContractError";
  }
}

export class ComponentRevisionBindingConflictError extends RenderAssemblyError {
  constructor(message: string) {
    super(message);
    this.name = "ComponentRevisionBindingConflictError";
  }
}

export class ComponentInstanceRuntimeContractError extends RenderAssemblyError {
  constructor(message: string) {
    super(message);
    this.name = "ComponentInstanceRuntimeContractError";
  }
}

export interface RenderAssemblyMaterializeDeps {
  dataDir: string;
}

export interface BuildRenderAssemblyOptions {
  dataDir?: string;
  /** Use the bounded leaf-only Core reader for a server-observed Snapshot pin. */
  shallowSnapshotId?: string;
}

export interface MaterializedRenderAssembly {
  artifactDir: string;
  release(): Promise<void>;
}

export interface RenderAssemblyMaterializerOptions {
  idleTtlMs?: number;
  maxIdleEntries?: number;
  maxBytes?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface RenderAssemblyMaterializer {
  acquire(
    deps: RenderAssemblyMaterializeDeps,
    assembly: RenderAssembly,
    signal?: AbortSignal,
  ): Promise<MaterializedRenderAssembly>;
  dispose(): Promise<void>;
}

const execFileAsync = promisify(execFile);
interface MaterializationFlight {
  controller: AbortController;
  waiters: number;
  settled: boolean;
  promise: Promise<string>;
}

const materializationFlights = new Map<string, MaterializationFlight>();
const DEFAULT_ASSEMBLY_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_IDLE_ASSEMBLIES = 4;
const DEFAULT_MAX_ASSEMBLY_BYTES = 1024 * 1024 * 1024;

function assemblyBase(deps: RenderAssemblyMaterializeDeps, assembly: RenderAssembly): string {
  return join(deps.dataDir, "render-assemblies", assembly.projectId, assembly.assemblyHash);
}

function assemblyCacheKey(deps: RenderAssemblyMaterializeDeps, assembly: RenderAssembly): string {
  return `${resolve(deps.dataDir)}\0${assembly.projectId}\0${assembly.assemblyHash}`;
}

export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function stablePreviewHash(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function compareId(left: { id: string }, right: { id: string }): number {
  return compareCodeUnits(left.id, right.id);
}

function dependencySortKey(dependency: ArtifactRevisionDependencyRecord): string {
  return [dependency.revisionId, dependency.instanceId, dependency.componentRevisionId].join("\0");
}

function pinSortKey(pin: ArtifactRevisionResourcePinRecord): string {
  return [pin.revisionId, pin.resourceId, pin.resourceRevisionId].join("\0");
}

function requiresComponentInstanceRuntime(
  dependency: ArtifactRevisionDependencyRecord,
): boolean {
  return dependency.variantKey !== null
    || dependency.stateKey !== null
    || Object.keys(dependency.overrides).length > 0;
}

function fixtureObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ComponentFixtureContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectFixtureFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new ComponentFixtureContractError(`${label} contains unsupported field ${key}`);
  }
}

export function resolveComponentFixtureRenderContext(
  renderSpec: Record<string, unknown>,
  componentState: NonNullable<RenderAssemblyTarget["componentState"]>,
): ComponentFixtureRenderContext {
  const fixture = fixtureObject(renderSpec.componentFixture, "Component RenderSpec componentFixture");
  rejectFixtureFields(fixture, ["protocol", "consumerGlobal", "variants"], "Component fixture");
  if (fixture.protocol !== "dezin-component-fixture-v1"
    || fixture.consumerGlobal !== "__DEZIN_COMPONENT_FIXTURE__") {
    throw new ComponentFixtureContractError(
      "Component RenderSpec must declare the dezin-component-fixture-v1 consumer contract",
    );
  }
  const variants = fixtureObject(fixture.variants, "Component fixture variants");
  if (Object.keys(variants).length > 128) {
    throw new ComponentFixtureContractError("Component fixture declares too many variants");
  }
  const variant = fixtureObject(
    variants[componentState.variantKey],
    `Component fixture variant ${componentState.variantKey}`,
  );
  rejectFixtureFields(variant, ["states"], `Component fixture variant ${componentState.variantKey}`);
  const states = fixtureObject(variant.states, `Component fixture variant ${componentState.variantKey} states`);
  if (Object.keys(states).length > 256) {
    throw new ComponentFixtureContractError(`Component fixture variant ${componentState.variantKey} declares too many states`);
  }
  const state = fixtureObject(
    states[componentState.stateKey],
    `Component fixture state ${componentState.variantKey}/${componentState.stateKey}`,
  );
  rejectFixtureFields(
    state,
    ["props", "cssVariables", "background"],
    `Component fixture state ${componentState.variantKey}/${componentState.stateKey}`,
  );
  const props = state.props === undefined
    ? {}
    : fixtureObject(state.props, `Component fixture state ${componentState.variantKey}/${componentState.stateKey} props`);
  const cssVariablesInput = state.cssVariables === undefined
    ? undefined
    : fixtureObject(
      state.cssVariables,
      `Component fixture state ${componentState.variantKey}/${componentState.stateKey} cssVariables`,
    );
  const cssVariables: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(cssVariablesInput ?? {})) {
    if (!/^--[a-zA-Z0-9_-]{1,120}$/.test(name)
      || (typeof value !== "string" && typeof value !== "number")) {
      throw new ComponentFixtureContractError(
        `Component fixture state ${componentState.variantKey}/${componentState.stateKey} has an invalid CSS variable`,
      );
    }
    cssVariables[name] = value;
  }
  if (Object.keys(cssVariables).length > 256) {
    throw new ComponentFixtureContractError("Component fixture state declares too many CSS variables");
  }
  if (state.background !== undefined
    && (typeof state.background !== "string" || state.background.length === 0 || state.background.length > 4_096)) {
    throw new ComponentFixtureContractError("Component fixture state background is invalid");
  }
  if (JSON.stringify(state).length > 64 * 1024) {
    throw new ComponentFixtureContractError("Component fixture state exceeds the supported payload size");
  }
  return {
    protocol: "dezin-component-fixture-v1",
    variantKey: componentState.variantKey,
    stateKey: componentState.stateKey,
    props,
    ...(cssVariablesInput === undefined ? {} : { cssVariables }),
    ...(state.background === undefined ? {} : { background: state.background }),
  };
}

/**
 * Resolve the complete immutable source closure for a single Artifact Revision.
 * The Core Store validates each direct pin; this builder additionally walks the
 * transitive Component closure and seals every pixel-affecting identity into the
 * dependency and assembly hashes.
 */
export function buildRenderAssembly(
  store: Store,
  target: RenderAssemblyTarget,
  options: BuildRenderAssemblyOptions = {},
): RenderAssembly {
  const workspace = store.workspace.getWorkspace(target.projectId);
  if (!workspace) throw new RenderAssemblyError("Preview Target project Workspace was not found");
  const shallowClosure = options.shallowSnapshotId === undefined
    ? null
    : store.workspace.getShallowArtifactClosureForProject(
      target.projectId,
      options.shallowSnapshotId,
      target.revisionId,
    );
  if (options.shallowSnapshotId !== undefined && shallowClosure === null) {
    throw new RenderAssemblyError("Preview Target Snapshot-pinned Artifact Revision was not found");
  }
  const rootRevision = shallowClosure?.rootRevision
    ?? store.workspace.getArtifactRevision(target.revisionId);
  if (!rootRevision || rootRevision.workspaceId !== workspace.id) {
    throw new RenderAssemblyError("Preview Target Artifact Revision was not found in the project Workspace");
  }

  const closureRevisionsById = new Map(
    (shallowClosure?.revisions ?? []).map((revision) => [revision.id, revision]),
  );
  const closureKernelsById = new Map(
    (shallowClosure?.kernelRevisions ?? []).map((kernel) => [kernel.id, kernel]),
  );
  const closureDependenciesByRevisionId = new Map<string, ArtifactRevisionDependencyRecord[]>();
  for (const dependency of shallowClosure?.dependencies ?? []) {
    const dependencies = closureDependenciesByRevisionId.get(dependency.revisionId) ?? [];
    dependencies.push(dependency);
    closureDependenciesByRevisionId.set(dependency.revisionId, dependencies);
  }
  const closureResourcePinsByRevisionId = new Map<string, ArtifactRevisionResourcePinRecord[]>();
  for (const pin of shallowClosure?.resourcePins ?? []) {
    const pins = closureResourcePinsByRevisionId.get(pin.revisionId) ?? [];
    pins.push(pin);
    closureResourcePinsByRevisionId.set(pin.revisionId, pins);
  }
  const artifactsById = new Map<string, WorkspaceArtifactRecord>(
    (shallowClosure?.artifacts ?? []).map((artifact) => [artifact.id, artifact]),
  );
  const requireOwnedArtifact = (artifactId: string): WorkspaceArtifactRecord => {
    const cached = artifactsById.get(artifactId);
    if (cached) return cached;
    if (shallowClosure !== null) {
      throw new RenderAssemblyError("RenderAssembly contains an Artifact outside its bounded closure");
    }
    const artifact = store.workspace.getArtifact(artifactId);
    if (!artifact || artifact.workspaceId !== workspace.id) {
      throw new RenderAssemblyError("RenderAssembly contains a missing Artifact");
    }
    artifactsById.set(artifact.id, artifact);
    return artifact;
  };
  const revisionsById = new Map<string, ArtifactRevisionRecord>();
  const dependenciesByKey = new Map<string, ArtifactRevisionDependencyRecord>();
  const resourcePinsByKey = new Map<string, ArtifactRevisionResourcePinRecord>();
  const kernelsById = new Map<string, SharedDesignKernelRevision>();
  const componentBindingsByArtifactId = new Map<string, {
    revisionId: string;
    instanceId: string;
  }>();
  const visiting = new Set<string>();

  const visit = (revision: ArtifactRevisionRecord): void => {
    if (revisionsById.has(revision.id)) return;
    if (visiting.has(revision.id)) throw new RenderAssemblyError("Component Revision dependency cycle detected");
    if (revision.workspaceId !== workspace.id) {
      throw new RenderAssemblyError("RenderAssembly contains a cross-Workspace Artifact Revision");
    }
    requireOwnedArtifact(revision.artifactId);
    const kernel = shallowClosure === null
      ? store.workspace.getKernelRevision(revision.kernelRevisionId)
      : closureKernelsById.get(revision.kernelRevisionId) ?? null;
    if (!kernel || kernel.workspaceId !== workspace.id) {
      throw new RenderAssemblyError("RenderAssembly contains a cross-Workspace or missing Kernel Revision");
    }

    visiting.add(revision.id);
    kernelsById.set(kernel.id, kernel);
    const dependencies = (shallowClosure === null
      ? store.workspace.listArtifactRevisionDependencies(revision.id)
      : closureDependenciesByRevisionId.get(revision.id) ?? [])
      .filter((dependency) => dependency.status === "linked");
    for (const dependency of dependencies) {
      const key = dependencySortKey(dependency);
      if (dependenciesByKey.has(key)) throw new RenderAssemblyError("RenderAssembly contains a duplicate Component pin");
      dependenciesByKey.set(key, dependency);
      const component = requireOwnedArtifact(dependency.componentArtifactId);
      const componentRevision = shallowClosure === null
        ? store.workspace.getArtifactRevision(dependency.componentRevisionId)
        : closureRevisionsById.get(dependency.componentRevisionId) ?? null;
      if (!component
        || component.kind !== "component"
        || component.workspaceId !== workspace.id
        || !componentRevision
        || componentRevision.workspaceId !== workspace.id
        || componentRevision.artifactId !== component.id) {
        throw new RenderAssemblyError("RenderAssembly contains an invalid Component Revision pin");
      }
      const existingBinding = componentBindingsByArtifactId.get(component.id);
      if (existingBinding && existingBinding.revisionId !== componentRevision.id) {
        throw new ComponentRevisionBindingConflictError(
          `Component Artifact ${component.id} is pinned to incompatible Revisions by instances `
          + `${existingBinding.instanceId} (${existingBinding.revisionId}) and `
          + `${dependency.instanceId} (${componentRevision.id}); exact per-instance Revision binding is unavailable`,
        );
      }
      componentBindingsByArtifactId.set(component.id, {
        revisionId: componentRevision.id,
        instanceId: dependency.instanceId,
      });
      visit(componentRevision);
    }
    const revisionResourcePins = shallowClosure === null
      ? store.workspace.listArtifactRevisionResourcePins(revision.id)
      : closureResourcePinsByRevisionId.get(revision.id) ?? [];
    for (const pin of revisionResourcePins) {
      const key = pinSortKey(pin);
      if (resourcePinsByKey.has(key)) throw new RenderAssemblyError("RenderAssembly contains a duplicate Resource pin");
      resourcePinsByKey.set(key, pin);
    }
    visiting.delete(revision.id);
    revisionsById.set(revision.id, revision);
  };

  visit(rootRevision);
  const componentRevisions = [...revisionsById.values()]
    .filter((revision) => revision.id !== rootRevision.id)
    .sort(compareId);
  const revisions = [rootRevision, ...componentRevisions];
  const artifacts = [...new Set(revisions.map((revision) => revision.artifactId))]
    .map((artifactId) => artifactsById.get(artifactId)!)
    .sort(compareId);
  const dependencies = [...dependenciesByKey.values()]
    .sort((left, right) => compareCodeUnits(dependencySortKey(left), dependencySortKey(right)));
  const resourcePins = [...resourcePinsByKey.values()]
    .sort((left, right) => compareCodeUnits(pinSortKey(left), pinSortKey(right)));
  const kernelRevisions = [...kernelsById.values()].sort(compareId);
  const runtimeDependency = dependencies.find(requiresComponentInstanceRuntime);
  if (runtimeDependency) {
    throw new ComponentInstanceRuntimeContractError(
      `The linked Component dependency closure contains instance ${runtimeDependency.instanceId} with `
      + "variant, state, or overrides that require an exact runtime adapter",
    );
  }
  const resourceRevisionIds = new Set(resourcePins.map((pin) => pin.resourceRevisionId));
  for (const kernel of kernelRevisions) {
    for (const resourceRevisionId of kernel.sharedAssetRevisionIds) resourceRevisionIds.add(resourceRevisionId);
  }
  if (resourceRevisionIds.size > MAX_RENDER_ASSEMBLY_RESOURCES) {
    throw new RenderAssemblyError("RenderAssembly contains too many Resource Revision payloads");
  }
  if (resourceRevisionIds.size > 0 && !options.dataDir) {
    throw new RenderAssemblyError("RenderAssembly Resource Revision storage is unavailable");
  }
  let resourcePayloads: ResourceRevisionPayloadDescriptor[];
  try {
    resourcePayloads = [...resourceRevisionIds]
      .map((resourceRevisionId) => {
        const expectedResourceId = resourcePins.find(
          (pin) => pin.resourceRevisionId === resourceRevisionId,
        )?.resourceId;
        return resolveResourceRevisionPayloadDescriptor({
          store,
          dataDir: options.dataDir!,
          workspaceId: rootRevision.workspaceId,
          resourceRevisionId,
          ...(expectedResourceId === undefined ? {} : { expectedResourceId }),
        });
      })
      .sort((left, right) => compareCodeUnits(left.resourceRevisionId, right.resourceRevisionId));
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) throw new RenderAssemblyError(error.message);
    throw error;
  }
  const resourceBytes = resourcePayloads.reduce((total, payload) => total + payload.byteLength, 0);
  if (!Number.isSafeInteger(resourceBytes) || resourceBytes > MAX_RENDER_ASSEMBLY_RESOURCE_BYTES) {
    throw new RenderAssemblyError("RenderAssembly Resource Revision payload bytes exceed the supported bound");
  }
  const kernelSharedAssetIds = new Set(kernelRevisions.flatMap((kernel) => kernel.sharedAssetRevisionIds));
  for (const payload of resourcePayloads) {
    if (kernelSharedAssetIds.has(payload.resourceRevisionId) && payload.resourceKind !== "asset") {
      throw new RenderAssemblyError("RenderAssembly Kernel shared payload is not an Asset Resource Revision");
    }
  }
  const rootArtifact = requireOwnedArtifact(rootRevision.artifactId);
  if (target.componentState && rootArtifact.kind !== "component") {
    throw new ComponentFixtureContractError("Component state can only render a Component Artifact");
  }
  const componentFixture = target.componentState
    ? resolveComponentFixtureRenderContext(rootRevision.renderSpec, target.componentState)
    : null;
  const dependencyLockHash = stablePreviewHash("dezin-preview-dependency-lock-v1", {
    componentRevisions: componentRevisions.map((revision) => ({
      id: revision.id,
      artifactId: revision.artifactId,
      trackId: revision.trackId,
      sourceCommitHash: revision.sourceCommitHash,
      sourceTreeHash: revision.sourceTreeHash,
      artifactRoot: revision.artifactRoot,
      kernelRevisionId: revision.kernelRevisionId,
    })),
    dependencies,
    resourcePins,
    resourcePayloads,
    kernels: kernelRevisions.map((kernel) => ({
      id: kernel.id,
      checksum: kernel.checksum,
      sharedAssetRevisionIds: kernel.sharedAssetRevisionIds,
    })),
  });
  const assemblyHash = stablePreviewHash("dezin-render-assembly-v1", {
    projectId: target.projectId,
    workspaceId: rootRevision.workspaceId,
    artifactId: rootRevision.artifactId,
    revisionId: rootRevision.id,
    sourceCommitHash: rootRevision.sourceCommitHash,
    sourceTreeHash: rootRevision.sourceTreeHash,
    artifactRoot: rootRevision.artifactRoot,
    renderSpec: rootRevision.renderSpec,
    componentFixture,
    dependencyLockHash,
  });

  return {
    version: 1,
    projectId: target.projectId,
    workspaceId: rootRevision.workspaceId,
    artifactId: rootRevision.artifactId,
    artifactRoot: rootRevision.artifactRoot,
    rootRevision,
    revisions,
    artifacts,
    dependencies,
    resourcePins,
    resourcePayloads,
    kernelRevisions,
    componentFixture,
    dependencyLockHash,
    assemblyHash,
    runtimeKey: `${target.projectId}:version:preview-target-${assemblyHash}`,
  };
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  return String(result.stdout).trim();
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function safeRealpath(root: string, candidate: string, label: string): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!inside(realRoot, realCandidate)) throw new RenderAssemblyError(`${label} escapes its RenderAssembly source root`);
  return realCandidate;
}

async function withRevisionCheckout<T>(
  repository: string,
  base: string,
  revision: ArtifactRevisionRecord,
  signal: AbortSignal | undefined,
  operation: (checkout: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const resolvedCommit = await git(repository, ["rev-parse", `${revision.sourceCommitHash}^{commit}`], signal)
    .catch(() => { throw new RenderAssemblyError(`Artifact Revision ${revision.id} source commit is unavailable`); });
  if (resolvedCommit !== revision.sourceCommitHash) {
    throw new RenderAssemblyError(`Artifact Revision ${revision.id} source commit is not exact`);
  }
  const resolvedTree = await git(repository, ["rev-parse", `${resolvedCommit}^{tree}`], signal);
  if (resolvedTree !== revision.sourceTreeHash) {
    throw new RenderAssemblyError(`Artifact Revision ${revision.id} source tree hash does not match Git`);
  }
  const checkout = join(base, `.checkout-${revision.id}-${randomUUID()}`);
  let registered = false;
  try {
    await git(repository, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", checkout, resolvedCommit], signal);
    registered = true;
    signal?.throwIfAborted();
    const [head, tree] = await Promise.all([
      git(checkout, ["rev-parse", "HEAD"], signal),
      git(checkout, ["rev-parse", "HEAD^{tree}"], signal),
    ]);
    if (head !== revision.sourceCommitHash || tree !== revision.sourceTreeHash) {
      throw new RenderAssemblyError(`Artifact Revision ${revision.id} checkout identity changed`);
    }
    return await operation(checkout);
  } finally {
    if (registered) {
      await git(repository, ["worktree", "remove", "--force", checkout]).catch(() => {});
    }
    await rm(checkout, { recursive: true, force: true }).catch(() => {});
  }
}

async function sourceFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256").update("dezin-render-assembly-source-v1\0");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1);
      hash.update(relative).update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const targetPath = isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
        if (!inside(root, targetPath)) {
          throw new RenderAssemblyError(`RenderAssembly symlink ${relative} escapes its source root`);
        }
        hash.update("symlink\0").update(target).update("\0");
      } else if (entry.isFile()) {
        const [bytes, metadata] = await Promise.all([readFile(path), lstat(path)]);
        hash.update("file\0").update(String(metadata.mode & 0o111)).update("\0").update(bytes).update("\0");
      } else {
        throw new RenderAssemblyError(`RenderAssembly contains unsupported source entry ${relative}`);
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function assemblyDescriptor(assembly: RenderAssembly): Record<string, unknown> {
  return {
    version: assembly.version,
    projectId: assembly.projectId,
    workspaceId: assembly.workspaceId,
    artifactId: assembly.artifactId,
    artifactRoot: assembly.artifactRoot,
    assemblyHash: assembly.assemblyHash,
    dependencyLockHash: assembly.dependencyLockHash,
    resourcePins: assembly.resourcePins,
    resourcePayloads: assembly.resourcePayloads,
    kernelRevisions: assembly.kernelRevisions,
    componentFixture: assembly.componentFixture,
    revisions: assembly.revisions.map((revision) => ({
      id: revision.id,
      artifactId: revision.artifactId,
      sourceCommitHash: revision.sourceCommitHash,
      sourceTreeHash: revision.sourceTreeHash,
      artifactRoot: revision.artifactRoot,
    })),
  };
}

function renderContextManifest(assembly: RenderAssembly): Record<string, unknown> {
  const kernel = assembly.kernelRevisions.find(
    (candidate) => candidate.id === assembly.rootRevision.kernelRevisionId,
  );
  if (!kernel) throw new RenderAssemblyError("RenderAssembly root Kernel Revision is unavailable");
  return {
    version: 1,
    assemblyHash: assembly.assemblyHash,
    dependencyLockHash: assembly.dependencyLockHash,
    projectId: assembly.projectId,
    workspaceId: assembly.workspaceId,
    artifactId: assembly.artifactId,
    revisionId: assembly.rootRevision.id,
    kernel,
    kernels: assembly.kernelRevisions,
    resourcePins: assembly.resourcePins,
    resourcePayloads: assembly.resourcePayloads,
    componentFixture: assembly.componentFixture,
  };
}

function scriptJson(value: unknown): string {
  // Parse the canonical JSON at runtime instead of executing it as an object
  // literal: keys such as `__proto__` must remain inert data, not syntax.
  return JSON.stringify(JSON.stringify(value))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderContextBootstrap(context: Record<string, unknown>): string {
  return `(function(context){
var deepFreeze=function(value,seen){if(!value||typeof value!=='object'||seen.indexOf(value)>=0)return value;seen.push(value);var keys=Object.keys(value);for(var i=0;i<keys.length;i++)deepFreeze(value[keys[i]],seen);return Object.freeze(value);};
context=deepFreeze(context,[]);
try{Object.defineProperty(window,'__DEZIN_RENDER_CONTEXT__',{value:context,writable:false,configurable:false});}catch(_){window.__DEZIN_RENDER_CONTEXT__=context;}
var root=document.documentElement,kernel=context.kernel||{},tokens=kernel.tokens||{};
for(var key in tokens){if(!Object.prototype.hasOwnProperty.call(tokens,key))continue;var name=key.indexOf('--')===0?key:'--dezin-'+String(key).replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase();if(name&&name!=='--dezin-')root.style.setProperty(name,String(tokens[key]));}
root.setAttribute('data-dezin-kernel-revision',String(kernel.id||''));
var fixture=context.componentFixture;
if(fixture){try{Object.defineProperty(window,'__DEZIN_COMPONENT_FIXTURE__',{value:fixture,writable:false,configurable:false});}catch(_){window.__DEZIN_COMPONENT_FIXTURE__=fixture;}
root.setAttribute('data-dezin-component-variant',fixture.variantKey);root.setAttribute('data-dezin-component-state',fixture.stateKey);
var variables=fixture.cssVariables||{};for(var variable in variables)if(Object.prototype.hasOwnProperty.call(variables,variable))root.style.setProperty(variable,String(variables[variable]));
if(fixture.background){root.style.background=fixture.background;var applyBackground=function(){if(document.body)document.body.style.background=fixture.background;};if(document.body)applyBackground();else document.addEventListener('DOMContentLoaded',applyBackground,{once:true});}}
})(JSON.parse(${scriptJson(context)}));`;
}

const COMPONENT_FIXTURE_SOURCE_EXTENSIONS = new Set([
  ".html", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte",
]);

interface HtmlSyntaxNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlSyntaxNode[];
}

function identifierName(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  return node.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function patternBindsIdentifier(value: unknown, identifier: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => patternBindsIdentifier(entry, identifier));
  const node = value as Record<string, unknown>;
  if (node.type === "Identifier") return node.name === identifier;
  if (node.type === "RestElement") return patternBindsIdentifier(node.argument, identifier);
  if (node.type === "AssignmentPattern") return patternBindsIdentifier(node.left, identifier);
  if (node.type === "ObjectPattern") return patternBindsIdentifier(node.properties, identifier);
  if (node.type === "ArrayPattern") return patternBindsIdentifier(node.elements, identifier);
  if (node.type === "ObjectProperty") return patternBindsIdentifier(node.value, identifier);
  return false;
}

function syntaxTreeBindsBrowserGlobal(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(syntaxTreeBindsBrowserGlobal);
  const node = value as Record<string, unknown>;
  switch (node.type) {
    case "VariableDeclarator":
      if (patternBindsIdentifier(node.id, "window") || patternBindsIdentifier(node.id, "globalThis")) return true;
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      if (patternBindsIdentifier(node.id, "window")
        || patternBindsIdentifier(node.id, "globalThis")
        || patternBindsIdentifier(node.params, "window")
        || patternBindsIdentifier(node.params, "globalThis")) return true;
      break;
    case "ClassDeclaration":
    case "ClassExpression":
      if (patternBindsIdentifier(node.id, "window") || patternBindsIdentifier(node.id, "globalThis")) return true;
      break;
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ImportSpecifier":
      if (patternBindsIdentifier(node.local, "window") || patternBindsIdentifier(node.local, "globalThis")) return true;
      break;
    case "CatchClause":
      if (patternBindsIdentifier(node.param, "window") || patternBindsIdentifier(node.param, "globalThis")) return true;
      break;
  }
  return Object.values(node).some(syntaxTreeBindsBrowserGlobal);
}

function isFixtureMemberExpression(value: Record<string, unknown>): boolean {
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") return false;
  const objectName = identifierName(value.object);
  if (objectName !== "window" && objectName !== "globalThis") return false;
  if (value.computed === true) {
    const property = value.property;
    return property !== null
      && typeof property === "object"
      && (property as Record<string, unknown>).type === "StringLiteral"
      && (property as Record<string, unknown>).value === "__DEZIN_COMPONENT_FIXTURE__";
  }
  return identifierName(value.property) === "__DEZIN_COMPONENT_FIXTURE__";
}

function fixtureMemberIsRead(
  parent: Record<string, unknown> | null,
  parentKey: string | null,
): boolean {
  if (!parent) return true;
  if (parent.type === "AssignmentExpression" && parentKey === "left") return false;
  if (parent.type === "AssignmentPattern" && parentKey === "left") return false;
  if ((parent.type === "ForInStatement" || parent.type === "ForOfStatement") && parentKey === "left") return false;
  if (parent.type === "UpdateExpression" && parentKey === "argument") return false;
  return !(parent.type === "UnaryExpression" && parent.operator === "delete" && parentKey === "argument");
}

function syntaxTreeConsumesComponentFixture(
  value: unknown,
  parent: Record<string, unknown> | null = null,
  parentKey: string | null = null,
): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => syntaxTreeConsumesComponentFixture(entry, parent, parentKey));
  }
  const node = value as Record<string, unknown>;
  if (isFixtureMemberExpression(node) && fixtureMemberIsRead(parent, parentKey)) return true;
  return Object.entries(node).some(([key, entry]) => (
    syntaxTreeConsumesComponentFixture(entry, node, key)
  ));
}

function sourceConsumesComponentFixture(source: string, extension: string): boolean {
  const parseScript = (script: string, typed: boolean): boolean => {
    try {
      const syntaxTree = parseJavaScript(script, {
        sourceType: "unambiguous",
        plugins: typed ? ["typescript", "jsx"] : ["jsx"],
      });
      return !syntaxTreeBindsBrowserGlobal(syntaxTree)
        && syntaxTreeConsumesComponentFixture(syntaxTree);
    } catch {
      return false;
    }
  };
  if (extension !== ".html" && extension !== ".vue" && extension !== ".svelte") {
    return parseScript(source, extension === ".ts" || extension === ".tsx");
  }
  let document: HtmlSyntaxNode;
  try {
    document = parseHtml(source) as unknown as HtmlSyntaxNode;
  } catch {
    return false;
  }
  const scripts: string[] = [];
  const collectScripts = (node: HtmlSyntaxNode): void => {
    if (node.tagName === "script") {
      scripts.push((node.childNodes ?? [])
        .filter((child) => child.nodeName === "#text")
        .map((child) => child.value ?? "")
        .join(""));
      return;
    }
    for (const child of node.childNodes ?? []) collectScripts(child);
  };
  collectScripts(document);
  return scripts.some((script) => parseScript(script, extension === ".vue" || extension === ".svelte"));
}

async function declaresComponentFixtureConsumer(root: string): Promise<boolean> {
  let inspectedBytes = 0;
  const visit = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".dezin") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await visit(path)) return true;
        continue;
      }
      if (!entry.isFile() || !COMPONENT_FIXTURE_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const metadata = await lstat(path);
      if (metadata.size > 2 * 1024 * 1024 || inspectedBytes + metadata.size > 32 * 1024 * 1024) continue;
      inspectedBytes += metadata.size;
      const extension = extname(entry.name).toLowerCase();
      if (sourceConsumesComponentFixture(await readFile(path, "utf8"), extension)) return true;
    }
    return false;
  };
  return visit(root);
}

async function installRenderContext(source: string, assembly: RenderAssembly): Promise<void> {
  const artifactDir = safeJoin(source, assembly.artifactRoot);
  if (!artifactDir) throw new RenderAssemblyError("RenderAssembly Artifact root escapes its source tree");
  if (assembly.componentFixture && !(await declaresComponentFixtureConsumer(artifactDir))) {
    throw new ComponentFixtureContractError(
      "Component fixture source does not consume window.__DEZIN_COMPONENT_FIXTURE__",
    );
  }
  const context = renderContextManifest(assembly);
  const bootstrap = renderContextBootstrap(context);
  await mkdir(join(artifactDir, ".dezin"), { recursive: true });
  await Promise.all([
    writeFile(join(artifactDir, ".dezin", "render-context.json"), `${JSON.stringify(context, null, 2)}\n`, "utf8"),
    writeFile(join(artifactDir, ".dezin", "render-context.js"), `${bootstrap}\n`, "utf8"),
  ]);
}

async function materializeResourcePayloads(
  deps: RenderAssemblyMaterializeDeps,
  source: string,
  assembly: RenderAssembly,
  signal?: AbortSignal,
): Promise<void> {
  const artifactDir = safeJoin(source, assembly.artifactRoot);
  if (!artifactDir) throw new RenderAssemblyError("RenderAssembly Artifact root escapes its source tree");
  await safeRealpath(source, artifactDir, "RenderAssembly Artifact root");
  const dezinRoot = join(artifactDir, ".dezin");
  // .dezin is a renderer-owned sidecar. Replacing it in the disposable assembly
  // prevents checked-in files or symlinks from redirecting immutable payloads.
  await rm(dezinRoot, { recursive: true, force: true });
  await mkdir(dezinRoot, { recursive: true });
  for (const payload of assembly.resourcePayloads) {
    signal?.throwIfAborted();
    const destination = safeJoin(artifactDir, payload.mountPath);
    if (!destination || !inside(dezinRoot, destination)) {
      throw new RenderAssemblyError("Resource Revision mount path escapes the Artifact runtime sidecar");
    }
    try {
      await verifyResourceRevisionPayload(deps.dataDir, payload, { destination, signal });
    } catch (error) {
      if (error instanceof ResourceRevisionPayloadError) throw new RenderAssemblyError(error.message);
      throw error;
    }
  }
}

async function materializeRenderAssemblyOnce(
  deps: RenderAssemblyMaterializeDeps,
  assembly: RenderAssembly,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const repository = projectDir(deps.dataDir, assembly.projectId);
  if (!existsSync(join(repository, ".git"))) {
    throw new RenderAssemblyError("Preview Target source repository is unavailable");
  }
  const base = assemblyBase(deps, assembly);
  const descriptor = assemblyDescriptor(assembly);
  const descriptorHash = stablePreviewHash("dezin-render-assembly-manifest-v1", descriptor);
  const cachedArtifact = async (): Promise<string | null> => {
    const source = join(base, "source");
    const manifestPath = join(base, "manifest.json");
    const cached = await readFile(manifestPath, "utf8").then((text) => JSON.parse(text) as {
      descriptorHash?: unknown;
      sourceHash?: unknown;
    }).catch(() => null);
    if (!cached) {
      if (existsSync(base)) throw new RenderAssemblyError("cached RenderAssembly is incomplete");
      return null;
    }
    if (cached.descriptorHash !== descriptorHash || typeof cached.sourceHash !== "string") {
      throw new RenderAssemblyError("cached RenderAssembly manifest does not match its immutable identity");
    }
    const actualSourceHash = await sourceFingerprint(source)
      .catch(() => { throw new RenderAssemblyError("cached RenderAssembly source is unavailable"); });
    if (actualSourceHash !== cached.sourceHash) {
      throw new RenderAssemblyError("cached RenderAssembly source changed after materialization");
    }
    const artifact = safeJoin(source, assembly.artifactRoot);
    if (!artifact) throw new RenderAssemblyError("RenderAssembly Artifact root escapes its source tree");
    return safeRealpath(source, artifact, "RenderAssembly Artifact root");
  };
  const cached = await cachedArtifact();
  if (cached) return cached;

  await mkdir(dirname(base), { recursive: true });
  const staging = `${base}.tmp-${randomUUID()}`;
  const source = join(staging, "source");
  const manifestPath = join(staging, "manifest.json");
  await mkdir(staging, { recursive: true });
  try {
    await withRevisionCheckout(repository, staging, assembly.rootRevision, signal, async (checkout) => {
      await cp(checkout, source, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (entry) => basename(entry) !== ".git",
      });
    });
    for (const revision of assembly.revisions.slice(1)) {
      signal?.throwIfAborted();
      await withRevisionCheckout(repository, staging, revision, signal, async (checkout) => {
        const componentSource = safeJoin(checkout, revision.artifactRoot);
        const componentDestination = safeJoin(source, revision.artifactRoot);
        if (!componentSource || !componentDestination) {
          throw new RenderAssemblyError(`Component Revision ${revision.id} root escapes its source tree`);
        }
        await safeRealpath(checkout, componentSource, `Component Revision ${revision.id} root`);
        await rm(componentDestination, { recursive: true, force: true });
        await mkdir(dirname(componentDestination), { recursive: true });
        await cp(componentSource, componentDestination, { recursive: true, verbatimSymlinks: true });
      });
    }
    signal?.throwIfAborted();
    await materializeResourcePayloads(deps, source, assembly, signal);
    signal?.throwIfAborted();
    await installRenderContext(source, assembly);
    signal?.throwIfAborted();
    const sourceHash = await sourceFingerprint(source);
    await writeFile(manifestPath, `${JSON.stringify({ descriptorHash, sourceHash, descriptor }, null, 2)}\n`, "utf8");
    signal?.throwIfAborted();
    try {
      await rename(staging, base);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const winner = await cachedArtifact();
      if (!winner) throw new RenderAssemblyError("RenderAssembly atomic publisher lost without a valid winner");
      await rm(staging, { recursive: true, force: true });
      return winner;
    }
    const publishedSource = join(base, "source");
    const artifact = safeJoin(publishedSource, assembly.artifactRoot);
    if (!artifact) throw new RenderAssemblyError("RenderAssembly Artifact root escapes its source tree");
    return await safeRealpath(publishedSource, artifact, "RenderAssembly Artifact root");
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function materializeRenderAssembly(
  deps: RenderAssemblyMaterializeDeps,
  assembly: RenderAssembly,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const key = assemblyCacheKey(deps, assembly);
  let flight = materializationFlights.get(key);
  while (flight?.controller.signal.aborted && !flight.settled) {
    await flight.promise.catch(() => {});
    signal?.throwIfAborted();
    flight = materializationFlights.get(key);
  }
  if (!flight) {
    const controller = new AbortController();
    const created: MaterializationFlight = {
      controller,
      waiters: 0,
      settled: false,
      promise: materializeRenderAssemblyOnce(deps, assembly, controller.signal),
    };
    flight = created;
    materializationFlights.set(key, created);
    void created.promise.finally(() => {
      created.settled = true;
      if (materializationFlights.get(key) === created) materializationFlights.delete(key);
    }).catch(() => {});
  }
  flight.waiters += 1;
  try {
    if (!signal) return await flight.promise;
    return await new Promise<string>((resolveMaterialized, reject) => {
      let finished = false;
      const finish = (operation: () => void): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        operation();
      };
      const onAbort = (): void => finish(() => reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Preview Target materialization aborted", "AbortError")));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else void flight!.promise.then(
        (path) => finish(() => resolveMaterialized(path)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  } finally {
    flight.waiters -= 1;
    if (!flight.settled && flight.waiters === 0) {
      flight.controller.abort(new DOMException("Preview Target materialization has no waiters", "AbortError"));
    }
  }
}

// Materializer instances can overlap during daemon lifecycle transitions and in
// tests. Keep ownership/removal coordination process-wide so one inventory can
// never prune a stable base that another instance has already handed out.
const activeAssemblyOwners = new Map<string, number>();
const assemblyRemovalFlights = new Map<string, Promise<void>>();

interface RetainedAssemblyEntry {
  key: string;
  base: string;
  artifactDir: string;
  verified: boolean;
  refs: number;
  bytes: number;
  idleSince: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else bytes += (await lstat(path)).size;
    }
  };
  await visit(root);
  return bytes;
}

/**
 * Retains immutable assemblies while a client lease uses them, then keeps only a
 * bounded idle LRU. Active refs are never evicted, even when they exceed the byte cap.
 */
export function createRenderAssemblyMaterializer(
  options: RenderAssemblyMaterializerOptions = {},
): RenderAssemblyMaterializer {
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_ASSEMBLY_IDLE_TTL_MS;
  const maxIdleEntries = options.maxIdleEntries ?? DEFAULT_MAX_IDLE_ASSEMBLIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSEMBLY_BYTES;
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const entries = new Map<string, RetainedAssemblyEntry>();
  const inventoryFlights = new Map<string, Promise<void>>();

  const retainOwner = async (key: string): Promise<void> => {
    while (true) {
      const removal = assemblyRemovalFlights.get(key);
      if (removal) {
        await removal.catch(() => {});
        continue;
      }
      activeAssemblyOwners.set(key, (activeAssemblyOwners.get(key) ?? 0) + 1);
      return;
    }
  };

  const releaseOwner = (key: string): void => {
    const remaining = (activeAssemblyOwners.get(key) ?? 1) - 1;
    if (remaining > 0) activeAssemblyOwners.set(key, remaining);
    else activeAssemblyOwners.delete(key);
  };

  const isOwned = (entry: RetainedAssemblyEntry): boolean =>
    entry.refs > 0 || (activeAssemblyOwners.get(entry.key) ?? 0) > 0;

  const clearIdleTimer = (entry: RetainedAssemblyEntry): void => {
    if (!entry.idleTimer) return;
    cancel(entry.idleTimer);
    entry.idleTimer = undefined;
  };

  const removeEntry = async (entry: RetainedAssemblyEntry): Promise<boolean> => {
    if (isOwned(entry) || entries.get(entry.key) !== entry) return false;
    clearIdleTimer(entry);
    entries.delete(entry.key);
    const existingRemoval = assemblyRemovalFlights.get(entry.key);
    if (existingRemoval) {
      await existingRemoval.catch(() => {});
      return true;
    }
    const removal = rm(entry.base, { recursive: true, force: true });
    assemblyRemovalFlights.set(entry.key, removal);
    try {
      await removal;
    } finally {
      if (assemblyRemovalFlights.get(entry.key) === removal) {
        assemblyRemovalFlights.delete(entry.key);
      }
    }
    return true;
  };

  const scheduleIdleRemoval = (entry: RetainedAssemblyEntry): void => {
    clearIdleTimer(entry);
    if (isOwned(entry) || !Number.isFinite(idleTtlMs)) return;
    const age = Math.max(0, now() - entry.idleSince);
    const delay = Math.max(0, idleTtlMs - age);
    entry.idleTimer = schedule(() => {
      entry.idleTimer = undefined;
      void removeEntry(entry).catch(() => {});
    }, Math.min(delay, 2_147_483_647));
    (entry.idleTimer as { unref?: () => void }).unref?.();
  };

  const evictOverflow = async (): Promise<void> => {
    const expired = [...entries.values()]
      .filter((entry) => !isOwned(entry) && now() - entry.idleSince >= idleTtlMs);
    for (const entry of expired) await removeEntry(entry);

    const idle = [...entries.values()]
      .filter((entry) => !isOwned(entry))
      .sort((left, right) => left.idleSince - right.idleSince || compareCodeUnits(left.key, right.key));
    let totalBytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (idle.length > maxIdleEntries || (totalBytes > maxBytes && idle.length > 0)) {
      const oldest = idle.shift();
      if (!oldest) break;
      if (await removeEntry(oldest)) totalBytes -= oldest.bytes;
    }
  };

  const trackPersistentBase = async (
    deps: RenderAssemblyMaterializeDeps,
    assembly: RenderAssembly,
  ): Promise<RetainedAssemblyEntry | null> => {
    const key = assemblyCacheKey(deps, assembly);
    const existing = entries.get(key);
    if (existing) return existing;
    const base = assemblyBase(deps, assembly);
    const metadata = await lstat(base).catch(() => null);
    if (!metadata?.isDirectory()) return null;
    const entry: RetainedAssemblyEntry = {
      key,
      base,
      artifactDir: join(base, "source"),
      verified: false,
      refs: 0,
      bytes: await directoryBytes(base).catch(() => Number.MAX_SAFE_INTEGER),
      idleSince: Math.min(metadata.mtimeMs, now()),
    };
    const winner = entries.get(key);
    if (winner) return winner;
    entries.set(key, entry);
    scheduleIdleRemoval(entry);
    return entry;
  };

  const inventoryDataDir = async (deps: RenderAssemblyMaterializeDeps): Promise<void> => {
    const dataDir = resolve(deps.dataDir);
    let flight = inventoryFlights.get(dataDir);
    if (!flight) {
      flight = (async () => {
        const root = join(dataDir, "render-assemblies");
        const projects = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        });
        for (const project of projects) {
          if (!project.isDirectory()) continue;
          const projectRoot = join(root, project.name);
          const assemblies = await readdir(projectRoot, { withFileTypes: true }).catch(() => []);
          for (const assembly of assemblies) {
            const stagingMatch = /^([a-f0-9]{64})\.tmp-.*$/.exec(assembly.name);
            if (assembly.isDirectory() && stagingMatch) {
              const key = `${dataDir}\0${project.name}\0${stagingMatch[1]}`;
              const activeMaterialization = materializationFlights.get(key);
              if (activeMaterialization && !activeMaterialization.settled) {
                await activeMaterialization.promise.catch(() => {});
              }
              await rm(join(projectRoot, assembly.name), { recursive: true, force: true });
              continue;
            }
            if (!assembly.isDirectory() || !/^[a-f0-9]{64}$/.test(assembly.name)) continue;
            const key = `${dataDir}\0${project.name}\0${assembly.name}`;
            if (entries.has(key)) continue;
            const base = join(projectRoot, assembly.name);
            const metadata = await lstat(base).catch(() => null);
            if (!metadata?.isDirectory()) continue;
            const entry: RetainedAssemblyEntry = {
              key,
              base,
              artifactDir: join(base, "source"),
              verified: false,
              refs: 0,
              bytes: await directoryBytes(base).catch(() => Number.MAX_SAFE_INTEGER),
              idleSince: Math.min(metadata.mtimeMs, now()),
            };
            if (!entries.has(key)) entries.set(key, entry);
          }
        }
        await evictOverflow();
        for (const entry of entries.values()) {
          if (!isOwned(entry) && !entry.idleTimer) scheduleIdleRemoval(entry);
        }
      })();
      inventoryFlights.set(dataDir, flight);
      void flight.catch(() => {
        if (inventoryFlights.get(dataDir) === flight) inventoryFlights.delete(dataDir);
      });
    }
    await flight;
  };

  const markIdle = async (entry: RetainedAssemblyEntry): Promise<void> => {
    if (entry.refs > 0) return;
    entry.bytes = await directoryBytes(entry.base).catch(() => 0);
    entry.idleSince = now();
    const idleAt = new Date(entry.idleSince);
    await utimes(entry.base, idleAt, idleAt).catch(() => {});
    scheduleIdleRemoval(entry);
  };

  return {
    async acquire(deps, assembly, signal) {
      signal?.throwIfAborted();
      const key = assemblyCacheKey(deps, assembly);
      await retainOwner(key);
      let entry: RetainedAssemblyEntry | undefined;
      let entryRefHeld = false;
      try {
        await inventoryDataDir(deps);
        entry = entries.get(key);
        if (!entry || !entry.verified || !existsSync(entry.base)) {
          const artifactDir = await materializeRenderAssembly(deps, assembly, signal);
          signal?.throwIfAborted();
          entry = entries.get(key);
          let created = false;
          if (!entry) {
            entry = {
              key,
              base: assemblyBase(deps, assembly),
              artifactDir,
              verified: true,
              refs: 0,
              bytes: 0,
              idleSince: now(),
            };
            // Publish retention before the first asynchronous size scan so a
            // concurrent acquire joins this refcount instead of creating an
            // invisible second entry for the same assembly directory.
            entries.set(key, entry);
            created = true;
          } else {
            entry.artifactDir = artifactDir;
            entry.verified = true;
          }
          if (created) {
            entry.bytes = await directoryBytes(entry.base).catch(() => Number.MAX_SAFE_INTEGER);
          }
        }
        clearIdleTimer(entry);
        entry.refs += 1;
        entryRefHeld = true;
        await evictOverflow();
        signal?.throwIfAborted();
        let released = false;
        return {
          artifactDir: entry.artifactDir,
          release: async () => {
            if (released) return;
            released = true;
            entryRefHeld = false;
            entry!.refs = Math.max(0, entry!.refs - 1);
            try {
              if (entry!.refs === 0) await markIdle(entry!);
            } finally {
              releaseOwner(key);
            }
            await evictOverflow();
          },
        };
      } catch (error) {
        if (entryRefHeld && entry) {
          entry.refs = Math.max(0, entry.refs - 1);
          if (entry.refs === 0) await markIdle(entry).catch(() => {});
        }
        releaseOwner(key);
        await trackPersistentBase(deps, assembly).catch(() => null);
        await evictOverflow().catch(() => {});
        throw error;
      }
    },

    async dispose() {
      const idle = [...entries.values()].filter((entry) => entry.refs === 0);
      await Promise.all(idle.map(removeEntry));
    },
  };
}

export const renderAssemblyMaterializer = createRenderAssemblyMaterializer();

export function acquireMaterializedRenderAssembly(
  deps: RenderAssemblyMaterializeDeps,
  assembly: RenderAssembly,
  signal?: AbortSignal,
): Promise<MaterializedRenderAssembly> {
  return renderAssemblyMaterializer.acquire(deps, assembly, signal);
}
