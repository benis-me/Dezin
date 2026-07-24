import { isDeepStrictEqual } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { getProvider } from "../../../../packages/agent/src/index.ts";
import type {
  ArtifactRevisionDependency,
  ArtifactRevisionRecord,
  ArtifactRevisionResourcePin,
  Project,
  ProjectWorkspace,
  Resource,
  ResourceRevision,
  Settings,
  SharedDesignKernelRevision,
  Store,
  WorkspaceArtifactRecord,
  WorkspaceGenerationAgentSelection,
  WorkspaceGraph,
  WorkspaceSnapshot,
} from "../../../../packages/core/src/index.ts";
import {
  MAX_PROTOTYPE_TRANSITION_DURATION_MS,
  normalizeWorkspaceGenerationAgentSelection,
  readFrozenPrototypeRenderFrames,
  resolveFrozenPrototypeRelations,
  WorkspaceStoreCodecError,
} from "../../../../packages/core/src/index.ts";
import {
  DesignRegistry,
  type DesignSystem,
} from "../../../../packages/design/src/index.ts";
import type { SkillInfo } from "../../../../packages/skills/src/index.ts";
import {
  BlockedContextError,
  CONTEXT_PRIORITY,
  ContextIntegrityError,
  checksumBytes,
  cloneAndFreeze,
  estimateContextTokens,
  stableStringify,
  type AgentTurnRequest,
  type ContextCandidate,
  type ContextCandidateSource,
  type ContextItemClass,
  type ContextItemRef,
  type ContextPack,
  type ContextPackRepository,
  type ExplicitContextResolution,
  type ResourceRevisionSnapshot,
} from "../context/context-types.ts";
import {
  ContextPackStore,
  createWorkspaceContextPackRepository,
} from "../context/context-pack-store.ts";
import {
  resourceAdapters,
  type ResourceAdapterRegistry,
} from "../context/adapters/index.ts";
import { ContextResolver } from "../context/context-resolver.ts";
import {
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "../resource-revision-payload.ts";
import {
  ResearchResourceRevisionError,
  researchRevisionContextPackId,
  selectResearchRevisionDirection,
} from "../research-resource-revision.ts";
import {
  parseProviderProfiles,
  providerRuntimeConfig,
  redactProviderProfiles,
} from "../provider-profile-config.ts";
import { buildProjectAgentPrompt } from "../run-handler.ts";
import { reviewerAgentCommand, reviewerModel } from "../run-policy.ts";
import type {
  GenerationTaskContextRequest,
  GenerationTaskContextResolver,
} from "./generation-plan-service.ts";
import {
  decodeSharinganCaptureResourceBundle,
  SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL,
  validateSharinganCaptureResourceBundleSemantics,
} from "./sharingan-capture-resource-bundle.ts";

const SHA256 = /^[0-9a-f]{64}$/;

const EXECUTION_PROFILE_PROTOCOL = "dezin.artifact-execution-profile.v4" as const;
const IMAGE_GENERATION_PROFILE_PROTOCOL = "dezin.artifact-image-generation.v2" as const;
const RESOURCE_EXECUTION_PROFILE_PROTOCOL = "dezin.resource-execution-profile.v3" as const;
const RESOURCE_IMAGE_GENERATION_PROFILE_PROTOCOL = "dezin.resource-image-generation.v1" as const;
const ARTIFACT_TARGET_CONTEXT_PROTOCOL = "dezin.generation-target-context.v3" as const;
const RESOURCE_TARGET_CONTEXT_PROTOCOL = "dezin.generation-target-context.v2" as const;
const RESOURCE_KINDS = Object.freeze([
  "research",
  "moodboard",
  "sharingan-capture",
  "file",
  "asset",
  "effect",
  "external-reference",
] as const satisfies readonly Resource["kind"][]);
const RESOURCE_KIND_SET = new Set<Resource["kind"]>(RESOURCE_KINDS);
const SETTINGS_FIELDS = Object.freeze([
  "agentCommand",
  "model",
  "apiBaseUrl",
  "apiKey",
  "defaultDesignSystemId",
  "customInstructions",
  "imageApiBaseUrl",
  "imageApiKey",
  "imageModel",
  "removeBackgroundModel",
  "editRegionModel",
  "extractLayerModel",
  "videoApiBaseUrl",
  "videoApiKey",
  "videoModel",
  "aiProviderId",
  "aiProviderEnabled",
  "aiProviderModels",
  "aiProviderOrganization",
  "aiProviderProfiles",
  "visualQaEnabled",
  "autoFixLiveRuntimeErrors",
  "sharinganAffirmed",
  "visualQaAgentCommand",
  "visualQaModel",
  "researchEnabled",
  "researchAgentCommand",
  "researchModel",
  "autoImproveEnabled",
  "autoImproveMaxRounds",
] as const satisfies readonly (keyof Settings)[]);

export interface ArtifactExecutionProfileOwnership {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly targetArtifactId: string;
}

export interface FrozenArtifactExecutionProfile {
  readonly protocol: typeof EXECUTION_PROFILE_PROTOCOL;
  readonly ownership: ArtifactExecutionProfileOwnership;
  /** True only when this exact Artifact Task pins one immutable Capture Revision. */
  readonly hasExactSharinganCapture: boolean;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly skillId: string | null;
    readonly designSystemId: string | null;
    readonly mode: Project["mode"];
    readonly sharingan: boolean;
    readonly sourceUrl: string | null;
    readonly checksum: string;
  };
  readonly settings: {
    readonly value: Settings;
    readonly checksum: string;
  };
  readonly agent: {
    readonly command: string;
    readonly providerId: string;
    readonly model: string | null;
    readonly credentialProviderId: string;
    readonly baseUrl: string;
    readonly organization: string;
    readonly credentialRequired: boolean;
  };
  readonly designSystem: {
    readonly requestedId: string | null;
    readonly resolvedId: string;
    readonly revision: string;
    readonly checksum: string;
    readonly content: DesignSystem;
  } | null;
  readonly skill: {
    readonly id: string;
    readonly revision: string;
    readonly checksum: string;
    readonly content: SkillInfo;
  } | null;
  readonly researchDirection: {
    readonly directionId: string;
    readonly revision: string;
    readonly checksum: string;
    readonly content: string;
    readonly resourceId: string;
    readonly revisionId: string;
    readonly revisionChecksum: string;
    readonly payloadChecksum: string;
  } | null;
  readonly prompt: {
    readonly rendererProtocol: "dezin.project-agent-prompt.v1";
    readonly rendererVersion: 1;
    readonly systemPrompt: string;
    readonly checksum: string;
  };
  readonly quality: {
    readonly visualQaEnabled: boolean;
    readonly reviewer: {
      readonly command: string;
      readonly providerId: string;
      readonly model: string | null;
    };
    readonly expectedSharinganRequestedUrl: string | null;
    readonly ignores: readonly {
      readonly ruleId: string;
      readonly selector: string | null;
    }[];
  };
  readonly imageGeneration: {
    readonly protocol: typeof IMAGE_GENERATION_PROFILE_PROTOCOL;
    readonly enabled: boolean;
    readonly providerId: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly apiVersion: string;
    readonly credentialRequired: boolean;
    readonly checksum: string;
  };
  readonly checksum: string;
}

export interface FreezeArtifactExecutionProfileInput {
  readonly ownership: ArtifactExecutionProfileOwnership;
  readonly hasExactSharinganCapture: boolean;
  readonly project: Pick<
    Project,
    "id" | "name" | "skillId" | "designSystemId" | "mode" | "sharingan"
  > & { readonly sourceUrl: string | null };
  readonly settings: Settings;
  readonly agent: Pick<
    FrozenArtifactExecutionProfile["agent"],
    "command" | "providerId" | "model"
  >;
  readonly designSystem: {
    readonly requestedId: string | null;
    readonly resolvedId: string;
    readonly content: DesignSystem;
  } | null;
  readonly skill: {
    readonly id: string;
    readonly content: SkillInfo;
  } | null;
  readonly researchDirection: {
    readonly directionId: string;
    readonly content: string;
    readonly resourceId: string;
    readonly revisionId: string;
    readonly revisionChecksum: string;
    readonly payloadChecksum: string;
  } | null;
  readonly prompt: Omit<FrozenArtifactExecutionProfile["prompt"], "checksum">;
  readonly quality: FrozenArtifactExecutionProfile["quality"];
  readonly imageGenerationEnabled: boolean;
}

export interface ResourceExecutionProfileOwnership {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly targetResourceId: string;
}

export interface FrozenResourceExecutionProfile {
  readonly protocol: typeof RESOURCE_EXECUTION_PROFILE_PROTOCOL;
  readonly ownership: ResourceExecutionProfileOwnership;
  readonly resource: { readonly kind: Resource["kind"] };
  readonly adapter: {
    readonly id: string;
    readonly version: 1;
    readonly kind: Resource["kind"];
  };
  readonly implementation: {
    readonly requestProtocol: string;
    readonly promptProtocol: string;
    readonly contractProtocol: string;
  };
  readonly agent: {
    readonly command: string;
    readonly providerId: string;
    readonly model: string | null;
    readonly baseUrl: string;
    readonly organization: string;
    readonly credentialProviderId: string;
    readonly credentialRequired: boolean;
  };
  /** Independent no-tools quality reviewer identity, frozen separately from the generating Agent. */
  readonly reviewer: {
    readonly command: "claude" | "codebuddy";
    readonly providerId: "claude" | "codebuddy";
    readonly model: string | null;
    readonly baseUrl: string;
    readonly credentialSource: "anthropic-profile" | "agent" | "session";
    readonly credentialRequired: boolean;
  };
  /** Present only for Moodboard Tasks; freezes every non-secret image-provider semantic. */
  readonly imageGeneration: {
    readonly protocol: typeof RESOURCE_IMAGE_GENERATION_PROFILE_PROTOCOL;
    readonly enabled: boolean;
    readonly providerId: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly apiVersion: string;
    readonly credentialRequired: boolean;
  } | null;
  readonly sharingan: {
    readonly bundleProtocol: typeof SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL;
    readonly sourceProtocol: "dezin.sharingan-pages.v2";
    readonly sourceSchemaVersion: 2;
    readonly exporterId: "dezin-sharingan-capture";
    readonly exporterVersion: 1;
    readonly exportRequestProtocol: "dezin.sharingan-capture-export-request.v1";
    readonly exportResultProtocol: "dezin.sharingan-capture-export.v1";
  } | null;
  readonly checksum: string;
}

export interface FreezeResourceExecutionProfileInput {
  readonly ownership: ResourceExecutionProfileOwnership;
  readonly resourceKind: Resource["kind"];
  readonly adapter: FrozenResourceExecutionProfile["adapter"];
  readonly settings: Settings;
}

export interface ResourceExecutionProfileExpectation extends ResourceExecutionProfileOwnership {
  readonly resourceKind: Resource["kind"];
  readonly adapter: FrozenResourceExecutionProfile["adapter"];
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareBinary);
  const expected = [...keys].sort(compareBinary);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new ContextIntegrityError(`${label} fields are invalid`);
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ContextIntegrityError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function taskAgentSelection(
  payload: Record<string, unknown>,
  label: string,
): WorkspaceGenerationAgentSelection | null {
  if (!Object.hasOwn(payload, "agent")) return null;
  try {
    return normalizeWorkspaceGenerationAgentSelection(payload.agent, label);
  } catch (error) {
    if (error instanceof WorkspaceStoreCodecError) {
      throw new ContextIntegrityError(error.message);
    }
    throw error;
  }
}

function settingsForFrozenTaskAgent(
  settings: Settings,
  agent: WorkspaceGenerationAgentSelection | null,
): Settings {
  if (agent === null) return settings;
  const reviewerProviderId = agent.providerId === "claude" || agent.providerId === "codebuddy"
    ? agent.providerId
    : null;
  return {
    ...settings,
    agentCommand: agent.command,
    model: agent.model ?? "",
    ...(reviewerProviderId === null
      ? {}
      : {
          // A post-approval Task's immutable Agent selection owns the complete
          // generation chain; stale global Visual QA settings cannot switch its
          // critic to another provider or model.
          visualQaAgentCommand: reviewerProviderId,
          visualQaModel: agent.model ?? "",
        }),
  };
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ContextIntegrityError(`${label} is invalid`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new ContextIntegrityError(`${label} is invalid`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function credentialFreeAgentBaseUrl(
  value: unknown,
  label = "Resource execution Agent base URL",
): string {
  const raw = stringValue(value, label).trim();
  if (raw.length === 0) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ContextIntegrityError(`${label} is invalid: ${String(error)}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0 || url.password.length > 0
    || url.search.length > 0 || url.hash.length > 0) {
    throw new ContextIntegrityError(`${label} must be canonical and credential-free`);
  }
  if (raw !== url.href && `${raw}/` !== url.href) {
    throw new ContextIntegrityError(`${label} must be canonical and credential-free`);
  }
  return url.href;
}

function hashedBody<T extends Record<string, unknown>>(body: T): T & { checksum: string } {
  return { ...body, checksum: checksumBytes(stableStringify(body)) };
}

function artifactImageCredentialRequired(settings: Settings, providerId: string): boolean {
  const profile = parseProviderProfiles(settings.aiProviderProfiles)[providerId];
  return Boolean(
    profile?.apiKey.trim()
      || profile?.apiKeyConfigured
      || (settings.aiProviderId.trim() === providerId
        && (settings.imageApiKey.trim() || settings.imageApiKeyConfigured)),
  );
}

function frozenImageGenerationProfile(
  settings: Settings,
  enabled: boolean,
  frozenCredentialRequired?: boolean,
): FrozenArtifactExecutionProfile["imageGeneration"] {
  const providerId = settings.aiProviderId.trim();
  const runtime = providerRuntimeConfig(settings, providerId);
  const credentialRequired = frozenCredentialRequired
    ?? artifactImageCredentialRequired(settings, providerId);
  return hashedBody({
    protocol: IMAGE_GENERATION_PROFILE_PROTOCOL,
    enabled,
    providerId,
    baseUrl: credentialFreeAgentBaseUrl(
      runtime.baseUrl || settings.imageApiBaseUrl,
      "Artifact image provider base URL",
    ),
    model: settings.imageModel.trim(),
    apiVersion: (runtime.organization || settings.aiProviderOrganization).trim(),
    credentialRequired,
  });
}

function artifactImageGenerationEnabled(settings: Settings): boolean {
  const providerId = settings.aiProviderId.trim();
  if (!providerId) return false;
  const runtime = providerRuntimeConfig(settings, providerId);
  const semantic = frozenImageGenerationProfile(settings, false);
  return Boolean(
    runtime.enabled
      && semantic.baseUrl
      && semantic.model
      && semantic.credentialRequired,
  );
}

function artifactImageProviderCredential(settings: Settings, providerId: string): string {
  const profile = parseProviderProfiles(settings.aiProviderProfiles)[providerId];
  if (profile !== undefined) return profile.apiKey.trim();
  return settings.aiProviderId.trim() === providerId ? settings.imageApiKey.trim() : "";
}

function sanitizedSettings(settings: Settings): Settings {
  const clone = structuredClone(settings);
  return {
    ...clone,
    apiKey: "",
    imageApiKey: "",
    videoApiKey: "",
    aiProviderProfiles: redactProviderProfiles(clone.aiProviderProfiles),
  };
}

function resourceImplementationProtocols(
  kind: Resource["kind"],
): FrozenResourceExecutionProfile["implementation"] {
  if (kind === "research") {
    return Object.freeze({
      requestProtocol: "dezin.resource-agent-request.v1",
      promptProtocol: "dezin.research-generation-prompt.v3",
      contractProtocol: "dezin.research-generation.v3",
    });
  }
  if (kind === "moodboard") {
    return Object.freeze({
      requestProtocol: "dezin.resource-agent-request.v1",
      promptProtocol: "dezin.moodboard-generation-prompt.v2",
      contractProtocol: "dezin.moodboard-generation.v2",
    });
  }
  if (kind === "sharingan-capture") {
    return Object.freeze({
      requestProtocol: "dezin.sharingan-capture-export-request.v1",
      promptProtocol: "dezin.sharingan-pages.v2",
      contractProtocol: "dezin.sharingan-capture-export.v1",
    });
  }
  return Object.freeze({
    requestProtocol: "dezin.owned-resource-source-request.v1",
    promptProtocol: "dezin.owned-resource-source.v1",
    contractProtocol: "dezin.owned-resource-revision.v1",
  });
}

function resourceCredentialProviderId(providerId: string): string {
  if (providerId === "codebuddy") return "codebuddy";
  if (providerId === "claude") return "anthropic";
  if (providerId === "codex" || providerId === "copilot") return "openai";
  return providerId;
}

function artifactAgentCredentialSemantic(
  settings: Settings,
  providerId: string,
): Pick<
  FrozenArtifactExecutionProfile["agent"],
  "credentialProviderId" | "baseUrl" | "organization" | "credentialRequired"
> {
  if (providerId === "codebuddy") {
    return {
      credentialProviderId: "codebuddy",
      baseUrl: "",
      organization: "",
      credentialRequired: false,
    };
  }
  const usesAnthropicEndpoint = providerId === "claude";
  const usesOpenAiEndpoint = providerId === "codex";
  return {
    credentialProviderId: resourceCredentialProviderId(providerId),
    baseUrl: usesAnthropicEndpoint || usesOpenAiEndpoint ? settings.apiBaseUrl.trim() : "",
    organization: usesOpenAiEndpoint ? settings.aiProviderOrganization.trim() : "",
    credentialRequired: Boolean(settings.apiKey.trim() || settings.apiKeyConfigured),
  };
}

function resourceCredentialConfigured(settings: Settings): boolean {
  return Boolean(settings.apiKey.trim() || settings.apiKeyConfigured);
}

function resourceReviewerProfile(settings: Settings): FrozenResourceExecutionProfile["reviewer"] {
  const command = reviewerAgentCommand(settings, settings.agentCommand);
  const model = reviewerModel(
    settings,
    settings.model.trim() || undefined,
    settings.agentCommand,
  ) ?? null;
  if (command === "codebuddy") {
    return Object.freeze({
      command,
      providerId: command,
      model,
      baseUrl: "",
      credentialSource: "session" as const,
      credentialRequired: false,
    });
  }
  const anthropic = providerRuntimeConfig(settings, "anthropic");
  if (anthropic.enabled) {
    return Object.freeze({
      command: "claude" as const,
      providerId: "claude" as const,
      model,
      baseUrl: credentialFreeAgentBaseUrl(anthropic.baseUrl),
      credentialSource: "anthropic-profile" as const,
      credentialRequired: Boolean(anthropic.apiKey.trim() || anthropic.apiKeyConfigured),
    });
  }
  if (getProvider(settings.agentCommand)?.id === "claude") {
    return Object.freeze({
      command: "claude" as const,
      providerId: "claude" as const,
      model,
      baseUrl: credentialFreeAgentBaseUrl(settings.apiBaseUrl),
      credentialSource: "agent" as const,
      credentialRequired: resourceCredentialConfigured(settings),
    });
  }
  return Object.freeze({
    command: "claude" as const,
    providerId: "claude" as const,
    model,
    baseUrl: "",
    credentialSource: "session" as const,
    credentialRequired: false,
  });
}

function sharinganExecutionProtocols(
  kind: Resource["kind"],
): FrozenResourceExecutionProfile["sharingan"] {
  return kind === "sharingan-capture" ? Object.freeze({
    bundleProtocol: SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL,
    sourceProtocol: "dezin.sharingan-pages.v2" as const,
    sourceSchemaVersion: 2 as const,
    exporterId: "dezin-sharingan-capture" as const,
    exporterVersion: 1 as const,
    exportRequestProtocol: "dezin.sharingan-capture-export-request.v1" as const,
    exportResultProtocol: "dezin.sharingan-capture-export.v1" as const,
  }) : null;
}

const IMAGE_PROVIDERS_WITH_DEFAULT_BASE_URL = new Set(["fal", "gemini", "vertex"]);

function resourceImageGenerationProfile(
  kind: Resource["kind"],
  settings: Settings,
): FrozenResourceExecutionProfile["imageGeneration"] {
  if (kind !== "moodboard") return null;
  const providerId = settings.aiProviderId.trim();
  const runtime = providerRuntimeConfig(settings, providerId);
  const providerProfile = parseProviderProfiles(settings.aiProviderProfiles)[providerId];
  const baseUrl = credentialFreeAgentBaseUrl(runtime.baseUrl || settings.imageApiBaseUrl);
  const model = settings.imageModel.trim();
  const apiVersion = (runtime.organization || settings.aiProviderOrganization).trim();
  const credentialRequired = Boolean(
    providerProfile?.apiKey.trim()
      || providerProfile?.apiKeyConfigured
      || (settings.aiProviderId.trim() === providerId
        && (settings.imageApiKey.trim() || settings.imageApiKeyConfigured)),
  );
  const enabled = Boolean(
    providerId
      && model
      && credentialRequired
      && (baseUrl || IMAGE_PROVIDERS_WITH_DEFAULT_BASE_URL.has(providerId)),
  );
  return Object.freeze({
    protocol: RESOURCE_IMAGE_GENERATION_PROFILE_PROTOCOL,
    enabled,
    providerId,
    baseUrl,
    model,
    apiVersion,
    credentialRequired,
  });
}

/** Freezes only non-secret behavior for one exact Resource Task Attempt. */
export function freezeResourceExecutionProfile(
  input: FreezeResourceExecutionProfileInput,
): FrozenResourceExecutionProfile {
  const command = input.settings.agentCommand.trim() || "claude";
  const providerId = providerIdentity(command);
  const credentialProviderId = resourceCredentialProviderId(providerId);
  const hostAuthenticated = providerId === "codebuddy";
  const body = {
    protocol: RESOURCE_EXECUTION_PROFILE_PROTOCOL,
    ownership: structuredClone(input.ownership),
    resource: { kind: input.resourceKind },
    adapter: structuredClone(input.adapter),
    implementation: resourceImplementationProtocols(input.resourceKind),
    agent: {
      command,
      providerId,
      model: input.settings.model.trim() || null,
      baseUrl: hostAuthenticated ? "" : credentialFreeAgentBaseUrl(input.settings.apiBaseUrl),
      organization: hostAuthenticated ? "" : input.settings.aiProviderOrganization.trim(),
      credentialProviderId,
      credentialRequired: hostAuthenticated ? false : resourceCredentialConfigured(input.settings),
    },
    reviewer: resourceReviewerProfile(input.settings),
    imageGeneration: resourceImageGenerationProfile(input.resourceKind, input.settings),
    sharingan: sharinganExecutionProtocols(input.resourceKind),
  };
  return validateResourceExecutionProfile(hashedBody(body));
}

/** Strict standalone validator used by both Context extraction and runtime defense in depth. */
export function validateResourceExecutionProfile(
  value: unknown,
  expected?: ResourceExecutionProfileExpectation,
): FrozenResourceExecutionProfile {
  const profile = plainRecord(value, "Resource execution profile");
  exactKeys(profile, [
    "protocol", "ownership", "resource", "adapter", "implementation", "agent", "reviewer", "imageGeneration", "sharingan", "checksum",
  ], "Resource execution profile");
  if (profile.protocol !== RESOURCE_EXECUTION_PROFILE_PROTOCOL
    || typeof profile.checksum !== "string" || !SHA256.test(profile.checksum)) {
    throw new ContextIntegrityError("Resource execution profile protocol or checksum is invalid");
  }
  const ownershipRecord = plainRecord(profile.ownership, "Resource execution profile ownership");
  exactKeys(ownershipRecord, [
    "projectId", "workspaceId", "planId", "taskId", "targetResourceId",
  ], "Resource execution profile ownership");
  const ownership: ResourceExecutionProfileOwnership = {
    projectId: nonEmptyString(ownershipRecord.projectId, "Resource execution Project id"),
    workspaceId: nonEmptyString(ownershipRecord.workspaceId, "Resource execution Workspace id"),
    planId: nonEmptyString(ownershipRecord.planId, "Resource execution Plan id"),
    taskId: nonEmptyString(ownershipRecord.taskId, "Resource execution Task id"),
    targetResourceId: nonEmptyString(ownershipRecord.targetResourceId, "Resource execution target id"),
  };
  const resourceRecord = plainRecord(profile.resource, "Resource execution target Resource");
  exactKeys(resourceRecord, ["kind"], "Resource execution target Resource");
  if (typeof resourceRecord.kind !== "string"
    || !RESOURCE_KIND_SET.has(resourceRecord.kind as Resource["kind"])) {
    throw new ContextIntegrityError("Resource execution target kind is invalid");
  }
  const resourceKind = resourceRecord.kind as Resource["kind"];
  const adapterRecord = plainRecord(profile.adapter, "Resource execution adapter");
  exactKeys(adapterRecord, ["id", "version", "kind"], "Resource execution adapter");
  if (adapterRecord.id !== `dezin.resource-adapter.${resourceKind}`
    || adapterRecord.version !== 1 || adapterRecord.kind !== resourceKind) {
    throw new ContextIntegrityError("Resource execution adapter identity is invalid");
  }
  const adapter: FrozenResourceExecutionProfile["adapter"] = {
    id: adapterRecord.id,
    version: 1,
    kind: resourceKind,
  };
  if (expected && (!isDeepStrictEqual(ownership, {
    projectId: expected.projectId,
    workspaceId: expected.workspaceId,
    planId: expected.planId,
    taskId: expected.taskId,
    targetResourceId: expected.targetResourceId,
  }) || expected.resourceKind !== resourceKind || !isDeepStrictEqual(expected.adapter, adapter))) {
    throw new ContextIntegrityError("Resource execution profile ownership or adapter does not match the exact Task");
  }
  const implementationRecord = plainRecord(profile.implementation, "Resource execution implementation");
  exactKeys(implementationRecord, [
    "requestProtocol", "promptProtocol", "contractProtocol",
  ], "Resource execution implementation");
  const implementation = {
    requestProtocol: nonEmptyString(implementationRecord.requestProtocol, "Resource execution request protocol"),
    promptProtocol: nonEmptyString(implementationRecord.promptProtocol, "Resource execution prompt protocol"),
    contractProtocol: nonEmptyString(implementationRecord.contractProtocol, "Resource execution contract protocol"),
  };
  if (!isDeepStrictEqual(implementation, resourceImplementationProtocols(resourceKind))) {
    throw new ContextIntegrityError("Resource execution implementation protocol is incompatible");
  }
  const agentRecord = plainRecord(profile.agent, "Resource execution Agent");
  exactKeys(agentRecord, [
    "command", "providerId", "model", "baseUrl", "organization", "credentialProviderId", "credentialRequired",
  ], "Resource execution Agent");
  const command = nonEmptyString(agentRecord.command, "Resource execution Agent command");
  const providerId = nonEmptyString(agentRecord.providerId, "Resource execution Agent provider");
  if (typeof agentRecord.credentialRequired !== "boolean") {
    throw new ContextIntegrityError("Resource execution Agent credential policy is invalid");
  }
  const agent = {
    command,
    providerId,
    model: nullableString(agentRecord.model, "Resource execution Agent model"),
    baseUrl: credentialFreeAgentBaseUrl(agentRecord.baseUrl),
    organization: stringValue(agentRecord.organization, "Resource execution Agent organization"),
    credentialProviderId: nonEmptyString(
      agentRecord.credentialProviderId,
      "Resource execution Agent credential provider",
    ),
    credentialRequired: agentRecord.credentialRequired,
  };
  if (providerIdentity(command) !== providerId
    || resourceCredentialProviderId(providerId) !== agent.credentialProviderId) {
    throw new ContextIntegrityError("Resource execution Agent identity is invalid");
  }
  const reviewerRecord = plainRecord(profile.reviewer, "Resource execution reviewer");
  exactKeys(reviewerRecord, [
    "command", "providerId", "model", "baseUrl", "credentialSource", "credentialRequired",
  ], "Resource execution reviewer");
  if ((reviewerRecord.command !== "claude" && reviewerRecord.command !== "codebuddy")
    || reviewerRecord.providerId !== reviewerRecord.command
    || (reviewerRecord.credentialSource !== "anthropic-profile"
      && reviewerRecord.credentialSource !== "agent"
      && reviewerRecord.credentialSource !== "session")
    || typeof reviewerRecord.credentialRequired !== "boolean") {
    throw new ContextIntegrityError("Resource execution reviewer identity is invalid");
  }
  const reviewerCommand = reviewerRecord.command;
  const reviewerCredentialSource = reviewerRecord.credentialSource;
  const reviewer: FrozenResourceExecutionProfile["reviewer"] = {
    command: reviewerCommand,
    providerId: reviewerCommand,
    model: nullableString(reviewerRecord.model, "Resource execution reviewer model"),
    baseUrl: credentialFreeAgentBaseUrl(reviewerRecord.baseUrl),
    credentialSource: reviewerCredentialSource,
    credentialRequired: reviewerRecord.credentialRequired,
  };
  if ((reviewer.credentialSource === "session" && (reviewer.baseUrl || reviewer.credentialRequired))
    || (reviewer.command === "codebuddy" && reviewer.credentialSource !== "session")) {
    throw new ContextIntegrityError("Resource execution reviewer credential policy is invalid");
  }
  let imageGeneration: FrozenResourceExecutionProfile["imageGeneration"] = null;
  if (profile.imageGeneration !== null) {
    const item = plainRecord(profile.imageGeneration, "Resource execution image generation");
    exactKeys(item, [
      "protocol", "enabled", "providerId", "baseUrl", "model", "apiVersion", "credentialRequired",
    ], "Resource execution image generation");
    if (item.protocol !== RESOURCE_IMAGE_GENERATION_PROFILE_PROTOCOL
      || typeof item.enabled !== "boolean" || typeof item.credentialRequired !== "boolean") {
      throw new ContextIntegrityError("Resource execution image generation policy is invalid");
    }
    imageGeneration = {
      protocol: RESOURCE_IMAGE_GENERATION_PROFILE_PROTOCOL,
      enabled: item.enabled,
      providerId: nonEmptyString(item.providerId, "Resource image provider"),
      baseUrl: credentialFreeAgentBaseUrl(item.baseUrl),
      model: stringValue(item.model, "Resource image model"),
      apiVersion: stringValue(item.apiVersion, "Resource image API version"),
      credentialRequired: item.credentialRequired,
    };
    if (imageGeneration.enabled && (!imageGeneration.model || !imageGeneration.credentialRequired
      || (!imageGeneration.baseUrl && !IMAGE_PROVIDERS_WITH_DEFAULT_BASE_URL.has(imageGeneration.providerId)))) {
      throw new ContextIntegrityError("Enabled Resource image generation is incomplete");
    }
  }
  if ((resourceKind === "moodboard") !== (imageGeneration !== null)) {
    throw new ContextIntegrityError("Resource image generation profile is incompatible with Resource kind");
  }
  let sharingan: FrozenResourceExecutionProfile["sharingan"] = null;
  if (profile.sharingan !== null) {
    const item = plainRecord(profile.sharingan, "Resource execution Sharingan protocol");
    exactKeys(item, [
      "bundleProtocol", "sourceProtocol", "sourceSchemaVersion", "exporterId", "exporterVersion",
      "exportRequestProtocol", "exportResultProtocol",
    ], "Resource execution Sharingan protocol");
    sharingan = {
      bundleProtocol: item.bundleProtocol as typeof SHARINGAN_CAPTURE_RESOURCE_BUNDLE_PROTOCOL,
      sourceProtocol: item.sourceProtocol as "dezin.sharingan-pages.v2",
      sourceSchemaVersion: item.sourceSchemaVersion as 2,
      exporterId: item.exporterId as "dezin-sharingan-capture",
      exporterVersion: item.exporterVersion as 1,
      exportRequestProtocol: item.exportRequestProtocol as "dezin.sharingan-capture-export-request.v1",
      exportResultProtocol: item.exportResultProtocol as "dezin.sharingan-capture-export.v1",
    };
  }
  if (!isDeepStrictEqual(sharingan, sharinganExecutionProtocols(resourceKind))) {
    throw new ContextIntegrityError("Resource execution Sharingan protocol identity is incompatible");
  }
  const resultBody = {
    protocol: RESOURCE_EXECUTION_PROFILE_PROTOCOL,
    ownership,
    resource: { kind: resourceKind },
    adapter,
    implementation,
    agent,
    reviewer,
    imageGeneration,
    sharingan,
  };
  if (profile.checksum !== checksumBytes(stableStringify(resultBody))) {
    throw new ContextIntegrityError("Resource execution profile checksum is invalid");
  }
  return cloneAndFreeze({ ...resultBody, checksum: profile.checksum });
}

/**
 * Captures every non-secret input that can alter an Artifact Agent turn or QA
 * decision. The checksum is embedded in the target Context item, so the
 * Attempt input hash inherits this exact execution identity.
 */
export function freezeArtifactExecutionProfile(
  input: FreezeArtifactExecutionProfileInput,
): FrozenArtifactExecutionProfile {
  const project = hashedBody({
    id: input.project.id,
    name: input.project.name,
    skillId: input.project.skillId,
    designSystemId: input.project.designSystemId,
    mode: input.project.mode,
    sharingan: input.project.sharingan,
    sourceUrl: input.project.sourceUrl,
  });
  const settingsValue = sanitizedSettings(input.settings);
  const settings = {
    value: settingsValue,
    checksum: checksumBytes(stableStringify(settingsValue)),
  };
  const designSystem = input.designSystem === null ? null : (() => {
    const content = structuredClone(input.designSystem.content);
    const checksum = checksumBytes(stableStringify(content));
    return {
      requestedId: input.designSystem.requestedId,
      resolvedId: input.designSystem.resolvedId,
      revision: checksum,
      checksum,
      content,
    };
  })();
  const skill = input.skill === null ? null : (() => {
    const content = structuredClone(input.skill.content);
    const checksum = checksumBytes(stableStringify(content));
    return { id: input.skill.id, revision: checksum, checksum, content };
  })();
  const researchDirection = input.researchDirection === null ? null : (() => {
    const checksum = checksumBytes(input.researchDirection.content);
    return {
      ...structuredClone(input.researchDirection),
      revision: checksum,
      checksum,
    };
  })();
  const prompt = {
    ...structuredClone(input.prompt),
    checksum: checksumBytes(input.prompt.systemPrompt),
  };
  const imageGeneration = frozenImageGenerationProfile(
    settingsValue,
    input.imageGenerationEnabled,
    artifactImageCredentialRequired(input.settings, input.settings.aiProviderId.trim()),
  );
  const agent = {
    ...structuredClone(input.agent),
    ...artifactAgentCredentialSemantic(input.settings, input.agent.providerId),
  };
  const body = {
    protocol: EXECUTION_PROFILE_PROTOCOL,
    ownership: structuredClone(input.ownership),
    hasExactSharinganCapture: input.hasExactSharinganCapture,
    project,
    settings,
    agent,
    designSystem,
    skill,
    researchDirection,
    prompt,
    quality: structuredClone(input.quality),
    imageGeneration,
  };
  return validateArtifactExecutionProfile(hashedBody(body));
}

function validateSettings(value: unknown): Settings {
  const settings = plainRecord(value, "Artifact execution settings");
  exactKeys(settings, SETTINGS_FIELDS, "Artifact execution settings");
  const stringFields = SETTINGS_FIELDS.filter((key) => ![
    "aiProviderEnabled",
    "visualQaEnabled",
    "autoFixLiveRuntimeErrors",
    "sharinganAffirmed",
    "researchEnabled",
    "autoImproveEnabled",
    "autoImproveMaxRounds",
  ].includes(key));
  if (stringFields.some((field) => typeof settings[field] !== "string")
    || typeof settings.aiProviderEnabled !== "boolean"
    || typeof settings.visualQaEnabled !== "boolean"
    || typeof settings.autoFixLiveRuntimeErrors !== "boolean"
    || typeof settings.sharinganAffirmed !== "boolean"
    || typeof settings.researchEnabled !== "boolean"
    || typeof settings.autoImproveEnabled !== "boolean"
    || !Number.isSafeInteger(settings.autoImproveMaxRounds)
    || Number(settings.autoImproveMaxRounds) < 0
    || settings.apiKey !== "" || settings.imageApiKey !== "" || settings.videoApiKey !== "") {
    throw new ContextIntegrityError("Artifact execution settings are invalid or contain persisted credentials");
  }
  const profiles = parseProviderProfiles(String(settings.aiProviderProfiles));
  if (Object.values(profiles).some((profile) => profile.apiKey !== "")) {
    throw new ContextIntegrityError("Artifact execution settings contain provider credentials");
  }
  return structuredClone(settings) as unknown as Settings;
}

type FrozenActor = Readonly<{
  command: string;
  providerId: string;
  model: string | null;
}>;

function validateActor(value: unknown, label: string): FrozenActor {
  const actor = plainRecord(value, label);
  exactKeys(actor, ["command", "providerId", "model"], label);
  return {
    command: nonEmptyString(actor.command, `${label} command`),
    providerId: nonEmptyString(actor.providerId, `${label} provider`),
    model: nullableString(actor.model, `${label} model`),
  };
}

function validateArtifactAgent(value: unknown, settings: Settings): FrozenArtifactExecutionProfile["agent"] {
  const record = plainRecord(value, "Artifact execution Agent");
  exactKeys(record, [
    "command",
    "providerId",
    "model",
    "credentialProviderId",
    "baseUrl",
    "organization",
    "credentialRequired",
  ], "Artifact execution Agent");
  const actor: FrozenActor = {
    command: nonEmptyString(record.command, "Artifact execution Agent command"),
    providerId: nonEmptyString(record.providerId, "Artifact execution Agent provider"),
    model: nullableString(record.model, "Artifact execution Agent model"),
  };
  if (typeof record.baseUrl !== "string"
    || typeof record.organization !== "string"
    || typeof record.credentialRequired !== "boolean") {
    throw new ContextIntegrityError("Artifact execution Agent credential semantic is invalid");
  }
  const expected = artifactAgentCredentialSemantic(settings, actor.providerId);
  const agent: FrozenArtifactExecutionProfile["agent"] = {
    ...actor,
    credentialProviderId: nonEmptyString(
      record.credentialProviderId,
      "Artifact execution Agent credential provider",
    ),
    baseUrl: record.baseUrl,
    organization: record.organization,
    credentialRequired: record.credentialRequired,
  };
  if (agent.credentialProviderId !== expected.credentialProviderId
    || agent.baseUrl !== expected.baseUrl
    || agent.organization !== expected.organization) {
    throw new ContextIntegrityError(
      "Artifact execution Agent credential semantic does not match frozen settings",
    );
  }
  return agent;
}

function validateArtifactExecutionProfile(
  value: unknown,
  expected?: ArtifactExecutionProfileOwnership,
): FrozenArtifactExecutionProfile {
  const profile = plainRecord(value, "Artifact execution profile");
  exactKeys(profile, [
    "protocol", "ownership", "hasExactSharinganCapture", "project", "settings", "agent", "designSystem",
    "skill", "researchDirection", "prompt", "quality", "imageGeneration", "checksum",
  ], "Artifact execution profile");
  if (profile.protocol !== EXECUTION_PROFILE_PROTOCOL || typeof profile.checksum !== "string"
    || !SHA256.test(profile.checksum)) {
    throw new ContextIntegrityError("Artifact execution profile protocol or checksum is invalid");
  }
  const ownershipRecord = plainRecord(profile.ownership, "Artifact execution profile ownership");
  exactKeys(ownershipRecord, [
    "projectId", "workspaceId", "planId", "taskId", "targetArtifactId",
  ], "Artifact execution profile ownership");
  const ownership: ArtifactExecutionProfileOwnership = {
    projectId: nonEmptyString(ownershipRecord.projectId, "Artifact execution Project id"),
    workspaceId: nonEmptyString(ownershipRecord.workspaceId, "Artifact execution Workspace id"),
    planId: nonEmptyString(ownershipRecord.planId, "Artifact execution Plan id"),
    taskId: nonEmptyString(ownershipRecord.taskId, "Artifact execution Task id"),
    targetArtifactId: nonEmptyString(ownershipRecord.targetArtifactId, "Artifact execution target id"),
  };
  if (expected && !isDeepStrictEqual(ownership, expected)) {
    throw new ContextIntegrityError("Artifact execution profile ownership does not match the exact Task");
  }
  if (typeof profile.hasExactSharinganCapture !== "boolean") {
    throw new ContextIntegrityError("Artifact execution Task Sharingan semantic is invalid");
  }
  const hasExactSharinganCapture = profile.hasExactSharinganCapture;
  const project = plainRecord(profile.project, "Artifact execution Project");
  exactKeys(project, [
    "id", "name", "skillId", "designSystemId", "mode", "sharingan", "sourceUrl", "checksum",
  ], "Artifact execution Project");
  if (project.mode !== "prototype" && project.mode !== "standard") {
    throw new ContextIntegrityError("Artifact execution Project mode is invalid");
  }
  if (typeof project.sharingan !== "boolean") {
    throw new ContextIntegrityError("Artifact execution Project Sharingan mode is invalid");
  }
  const projectMode: Project["mode"] = project.mode;
  const projectSharingan: boolean = project.sharingan;
  const projectBody = {
    id: nonEmptyString(project.id, "Artifact execution Project id"),
    name: nonEmptyString(project.name, "Artifact execution Project name"),
    skillId: project.skillId === null ? null : nonEmptyString(project.skillId, "Artifact execution skill id"),
    designSystemId: project.designSystemId === null
      ? null
      : nonEmptyString(project.designSystemId, "Artifact execution design system id"),
    mode: projectMode,
    sharingan: projectSharingan,
    sourceUrl: project.sourceUrl === null ? null : nonEmptyString(project.sourceUrl, "Artifact execution source URL"),
  };
  if (projectBody.id !== ownership.projectId
    || typeof project.checksum !== "string"
    || project.checksum !== checksumBytes(stableStringify(projectBody))) {
    throw new ContextIntegrityError("Artifact execution Project checksum or ownership is invalid");
  }
  const settingsRecord = plainRecord(profile.settings, "Artifact execution settings envelope");
  exactKeys(settingsRecord, ["value", "checksum"], "Artifact execution settings envelope");
  const settings = validateSettings(settingsRecord.value);
  if (settingsRecord.checksum !== checksumBytes(stableStringify(settings))) {
    throw new ContextIntegrityError("Artifact execution settings checksum is invalid");
  }
  const agent = validateArtifactAgent(profile.agent, settings);
  if (agent.command !== (settings.agentCommand || "claude") || agent.model !== (settings.model || null)
    || agent.providerId !== providerIdentity(agent.command)) {
    throw new ContextIntegrityError("Artifact execution Agent does not match frozen settings");
  }
  const designSystem = profile.designSystem === null ? null : (() => {
    const value = plainRecord(profile.designSystem, "Artifact execution design system");
    exactKeys(value, ["requestedId", "resolvedId", "revision", "checksum", "content"], "Artifact execution design system");
    const content = plainRecord(value.content, "Artifact execution design system content") as unknown as DesignSystem;
    const checksum = checksumBytes(stableStringify(content));
    if (value.requestedId !== null && typeof value.requestedId !== "string") {
      throw new ContextIntegrityError("Artifact execution requested design system id is invalid");
    }
    if (value.resolvedId !== content.id || value.revision !== checksum || value.checksum !== checksum) {
      throw new ContextIntegrityError("Artifact execution design system checksum or identity is invalid");
    }
    return {
      requestedId: value.requestedId as string | null,
      resolvedId: nonEmptyString(value.resolvedId, "Artifact execution resolved design system id"),
      revision: checksum,
      checksum,
      content: structuredClone(content),
    };
  })();
  const skill = profile.skill === null ? null : (() => {
    const value = plainRecord(profile.skill, "Artifact execution skill");
    exactKeys(value, ["id", "revision", "checksum", "content"], "Artifact execution skill");
    const content = plainRecord(value.content, "Artifact execution skill content") as unknown as SkillInfo;
    const checksum = checksumBytes(stableStringify(content));
    if (value.id !== content.id || value.revision !== checksum || value.checksum !== checksum) {
      throw new ContextIntegrityError("Artifact execution skill checksum or identity is invalid");
    }
    return {
      id: nonEmptyString(value.id, "Artifact execution skill id"),
      revision: checksum,
      checksum,
      content: structuredClone(content),
    };
  })();
  const requestedDesignSystemId = hasExactSharinganCapture
    ? null
    : (projectBody.designSystemId ?? settings.defaultDesignSystemId) || null;
  if ((hasExactSharinganCapture && designSystem !== null)
    || (!hasExactSharinganCapture && designSystem === null)
    || (designSystem !== null && designSystem.requestedId !== requestedDesignSystemId)) {
    throw new ContextIntegrityError("Artifact execution design system does not match the exact Task semantic");
  }
  if ((hasExactSharinganCapture && skill !== null)
    || (!hasExactSharinganCapture && projectBody.skillId !== null && skill?.id !== projectBody.skillId)) {
    throw new ContextIntegrityError("Artifact execution skill does not match the exact Task semantic");
  }
  const researchDirection = profile.researchDirection === null ? null : (() => {
    const value = plainRecord(profile.researchDirection, "Artifact execution Research direction");
    exactKeys(value, [
      "directionId", "revision", "checksum", "content", "resourceId", "revisionId", "revisionChecksum",
      "payloadChecksum",
    ], "Artifact execution Research direction");
    const content = nonEmptyString(value.content, "Artifact execution Research direction content");
    const checksum = checksumBytes(content);
    if (value.revision !== checksum || value.checksum !== checksum
      || typeof value.revisionChecksum !== "string" || !SHA256.test(value.revisionChecksum)
      || typeof value.payloadChecksum !== "string" || !SHA256.test(value.payloadChecksum)) {
      throw new ContextIntegrityError("Artifact execution Research direction checksum is invalid");
    }
    return {
      directionId: nonEmptyString(value.directionId, "Artifact execution Research direction id"),
      revision: checksum,
      checksum,
      content,
      resourceId: nonEmptyString(value.resourceId, "Artifact execution Research Resource id"),
      revisionId: nonEmptyString(value.revisionId, "Artifact execution Research Revision id"),
      revisionChecksum: value.revisionChecksum,
      payloadChecksum: value.payloadChecksum,
    };
  })();
  const promptRecord = plainRecord(profile.prompt, "Artifact execution prompt");
  exactKeys(promptRecord, [
    "rendererProtocol", "rendererVersion", "systemPrompt", "checksum",
  ], "Artifact execution prompt");
  const systemPrompt = nonEmptyString(promptRecord.systemPrompt, "Artifact execution system prompt");
  if (promptRecord.rendererProtocol !== "dezin.project-agent-prompt.v1"
    || promptRecord.rendererVersion !== 1
    || promptRecord.checksum !== checksumBytes(systemPrompt)) {
    throw new ContextIntegrityError("Artifact execution prompt protocol or checksum is invalid");
  }
  const qualityRecord = plainRecord(profile.quality, "Artifact execution quality policy");
  exactKeys(qualityRecord, [
    "visualQaEnabled", "reviewer", "expectedSharinganRequestedUrl", "ignores",
  ], "Artifact execution quality policy");
  if (typeof qualityRecord.visualQaEnabled !== "boolean" || !Array.isArray(qualityRecord.ignores)) {
    throw new ContextIntegrityError("Artifact execution quality policy is invalid");
  }
  const reviewer = validateActor(qualityRecord.reviewer, "Artifact execution reviewer");
  const ignores = qualityRecord.ignores.map((entry, index) => {
    const ignore = plainRecord(entry, `Artifact execution quality ignore ${index}`);
    exactKeys(ignore, ["ruleId", "selector"], `Artifact execution quality ignore ${index}`);
    return {
      ruleId: nonEmptyString(ignore.ruleId, `Artifact execution quality ignore ${index} rule`),
      selector: ignore.selector === null
        ? null
        : nonEmptyString(ignore.selector, `Artifact execution quality ignore ${index} selector`),
    };
  });
  const expectedSharinganRequestedUrl = qualityRecord.expectedSharinganRequestedUrl === null
    ? null
    : nonEmptyString(qualityRecord.expectedSharinganRequestedUrl, "Artifact execution Sharingan URL");
  const exactReviewerCommand = reviewerAgentCommand(settings, agent.command);
  const exactReviewerModel = reviewerModel(settings, agent.model ?? undefined, agent.command) ?? null;
  if (reviewer.command !== exactReviewerCommand || reviewer.model !== exactReviewerModel
    || reviewer.providerId !== providerIdentity(reviewer.command)) {
    throw new ContextIntegrityError("Artifact execution reviewer does not match frozen quality settings");
  }
  if ((hasExactSharinganCapture && expectedSharinganRequestedUrl === null)
    || (!hasExactSharinganCapture && expectedSharinganRequestedUrl !== null)
    || (hasExactSharinganCapture && qualityRecord.visualQaEnabled !== true)) {
    throw new ContextIntegrityError("Artifact execution Sharingan quality policy does not match the exact Task semantic");
  }
  const imageGenerationRecord = plainRecord(
    profile.imageGeneration,
    "Artifact execution image generation profile",
  );
  exactKeys(imageGenerationRecord, [
    "protocol", "enabled", "providerId", "baseUrl", "model", "apiVersion", "credentialRequired", "checksum",
  ], "Artifact execution image generation profile");
  if (imageGenerationRecord.protocol !== IMAGE_GENERATION_PROFILE_PROTOCOL
    || typeof imageGenerationRecord.enabled !== "boolean"
    || typeof imageGenerationRecord.credentialRequired !== "boolean") {
    throw new ContextIntegrityError("Artifact execution image generation profile is invalid");
  }
  const imageGenerationBody = {
    protocol: IMAGE_GENERATION_PROFILE_PROTOCOL,
    enabled: imageGenerationRecord.enabled,
    providerId: stringValue(
      imageGenerationRecord.providerId,
      "Artifact execution image provider id",
    ),
    baseUrl: stringValue(
      imageGenerationRecord.baseUrl,
      "Artifact execution image base URL",
    ),
    model: stringValue(imageGenerationRecord.model, "Artifact execution image model"),
    apiVersion: stringValue(
      imageGenerationRecord.apiVersion,
      "Artifact execution image API version",
    ),
    credentialRequired: imageGenerationRecord.credentialRequired,
  };
  const expectedImageGenerationChecksum = checksumBytes(stableStringify(imageGenerationBody));
  if (imageGenerationBody.enabled && (!imageGenerationBody.baseUrl.length
      || !imageGenerationBody.model.length || !imageGenerationBody.credentialRequired)) {
    throw new ContextIntegrityError("Artifact execution image generation profile is enabled without complete provider semantics");
  }
  if (imageGenerationRecord.checksum !== expectedImageGenerationChecksum) {
    throw new ContextIntegrityError("Artifact execution image generation profile checksum is invalid");
  }
  const imageGeneration = {
    ...imageGenerationBody,
    checksum: imageGenerationRecord.checksum as string,
  };
  if (!isDeepStrictEqual(
    imageGeneration,
    frozenImageGenerationProfile(
      settings,
      imageGeneration.enabled,
      imageGeneration.credentialRequired,
    ),
  )) {
    throw new ContextIntegrityError(
      "Artifact execution image generation profile does not match frozen settings",
    );
  }
  const resultBody = {
    protocol: EXECUTION_PROFILE_PROTOCOL,
    ownership,
    hasExactSharinganCapture,
    project: { ...projectBody, checksum: project.checksum as string },
    settings: { value: settings, checksum: settingsRecord.checksum as string },
    agent,
    designSystem,
    skill,
    researchDirection,
    prompt: {
      rendererProtocol: "dezin.project-agent-prompt.v1" as const,
      rendererVersion: 1 as const,
      systemPrompt,
      checksum: promptRecord.checksum as string,
    },
    quality: {
      visualQaEnabled: qualityRecord.visualQaEnabled,
      reviewer,
      expectedSharinganRequestedUrl,
      ignores,
    },
    imageGeneration,
  };
  if (profile.checksum !== checksumBytes(stableStringify(resultBody))) {
    throw new ContextIntegrityError("Artifact execution profile checksum is invalid");
  }
  return cloneAndFreeze({ ...resultBody, checksum: profile.checksum });
}

/** Restores only secrets from current Settings; every behavioral field stays frozen. */
export function hydrateArtifactExecutionSettings(
  profile: FrozenArtifactExecutionProfile,
  liveSettings: Settings,
): Settings {
  const exact = validateArtifactExecutionProfile(profile);
  const frozen = exact.settings.value;
  const liveCommand = liveSettings.agentCommand.trim() || "claude";
  const sameProvider = providerIdentity(liveCommand) === exact.agent.providerId;
  const liveCredential = artifactAgentCredentialSemantic(liveSettings, exact.agent.providerId);
  const sameEndpoint = exact.agent.baseUrl === liveCredential.baseUrl;
  const sameOrganization = exact.agent.organization === liveCredential.organization;
  const credentialMatches = sameProvider && sameEndpoint && sameOrganization;
  const apiKey = exact.agent.providerId === "codebuddy"
    ? ""
    : credentialMatches ? liveSettings.apiKey.trim() : "";
  if (exact.agent.credentialRequired && !apiKey) {
    throw new ContextIntegrityError(
      "Current credential for the frozen Artifact Agent provider, endpoint, and organization is unavailable",
    );
  }
  return {
    ...structuredClone(frozen),
    apiKey,
    visualQaEnabled: exact.quality.visualQaEnabled,
  };
}

export type BoundArtifactImageGeneration = Readonly<
  FrozenArtifactExecutionProfile["imageGeneration"] & { readonly apiKey: string }
>;

/**
 * Produces the non-persistent postprocessing input for one exact Attempt.
 * Provider/base/model/API-version semantics remain frozen; only the current
 * credential for that exact frozen provider identity may enter the process.
 */
export function hydrateArtifactImageGeneration(
  profile: FrozenArtifactExecutionProfile,
  liveSettings: Settings,
): BoundArtifactImageGeneration {
  const exact = validateArtifactExecutionProfile(profile).imageGeneration;
  const current = frozenImageGenerationProfile(
    liveSettings,
    artifactImageGenerationEnabled(liveSettings),
  );
  if (!isDeepStrictEqual(current, exact)) {
    throw new ContextIntegrityError(
      "Current Artifact image provider, endpoint, model, API version, credential requirement, or enabled state does not match the frozen Attempt",
    );
  }
  const apiKey = exact.enabled
    ? artifactImageProviderCredential(liveSettings, exact.providerId)
    : "";
  if (exact.enabled && exact.credentialRequired && !apiKey) {
    throw new ContextIntegrityError(
      "Current credential for the frozen Artifact image provider is unavailable",
    );
  }
  return Object.freeze({
    ...exact,
    apiKey,
  });
}

export type BoundResourceAgentExecution = Readonly<
  FrozenResourceExecutionProfile["agent"] & { readonly apiKey: string }
>;

/** Restores only the current credential belonging to the frozen CLI provider. */
export function hydrateResourceAgentExecution(
  profile: FrozenResourceExecutionProfile,
  liveSettings: Settings,
): BoundResourceAgentExecution {
  const exact = validateResourceExecutionProfile(profile);
  const implementation = getProvider(exact.agent.command);
  if (!implementation || implementation.id !== exact.agent.providerId) {
    throw new ContextIntegrityError("Frozen Resource Agent implementation is unavailable or incompatible");
  }
  if (exact.agent.providerId === "codebuddy") {
    return Object.freeze({ ...exact.agent, apiKey: "" });
  }
  const liveCommand = liveSettings.agentCommand.trim() || "claude";
  const liveProviderId = providerIdentity(liveCommand);
  const currentBaseUrl = credentialFreeAgentBaseUrl(liveSettings.apiBaseUrl);
  const currentOrganization = liveSettings.aiProviderOrganization.trim();
  const credentialMatches = liveProviderId === exact.agent.providerId
    && resourceCredentialProviderId(liveProviderId) === exact.agent.credentialProviderId
    && currentBaseUrl === exact.agent.baseUrl
    && currentOrganization === exact.agent.organization;
  const apiKey = credentialMatches ? liveSettings.apiKey.trim() : "";
  if (exact.agent.credentialRequired && !apiKey) {
    throw new ContextIntegrityError("Current credential for the frozen Resource Agent provider is unavailable");
  }
  return Object.freeze({ ...exact.agent, apiKey });
}

export type BoundResourceReviewerExecution = Readonly<
  FrozenResourceExecutionProfile["reviewer"] & { readonly apiKey: string }
>;

/** Restores only the credential for the exact frozen independent Resource reviewer. */
export function hydrateResourceReviewerExecution(
  profile: FrozenResourceExecutionProfile,
  liveSettings: Settings,
): BoundResourceReviewerExecution {
  const exact = validateResourceExecutionProfile(profile).reviewer;
  if (exact.providerId === "codebuddy") {
    return Object.freeze({ ...exact, apiKey: "" });
  }
  const current = resourceReviewerProfile(liveSettings);
  if (!isDeepStrictEqual(current, exact)) {
    throw new ContextIntegrityError(
      "Current Resource reviewer command, model, endpoint, credential source, or credential requirement does not match the frozen Attempt",
    );
  }
  const apiKey = exact.credentialSource === "anthropic-profile"
    ? providerRuntimeConfig(liveSettings, "anthropic").apiKey.trim()
    : exact.credentialSource === "agent"
      ? liveSettings.apiKey.trim()
      : "";
  if (exact.credentialRequired && !apiKey) {
    throw new ContextIntegrityError("Current credential for the frozen Resource reviewer is unavailable");
  }
  return Object.freeze({ ...exact, apiKey });
}

export type BoundResourceImageGeneration = Readonly<
  NonNullable<FrozenResourceExecutionProfile["imageGeneration"]> & { readonly apiKey: string }
>;

/** Restores only the current credential for the exact frozen Moodboard image endpoint. */
export function hydrateResourceImageGeneration(
  profile: FrozenResourceExecutionProfile,
  liveSettings: Settings,
): BoundResourceImageGeneration {
  const exact = validateResourceExecutionProfile(profile).imageGeneration;
  if (exact === null || !exact.enabled) {
    throw new ContextIntegrityError("Frozen Moodboard image generation is not configured");
  }
  const current = providerRuntimeConfig(liveSettings, exact.providerId);
  const currentBaseUrl = credentialFreeAgentBaseUrl(current.baseUrl || liveSettings.imageApiBaseUrl);
  const currentApiVersion = (current.organization || liveSettings.aiProviderOrganization).trim();
  const currentModel = liveSettings.imageModel.trim();
  const currentProfile = parseProviderProfiles(liveSettings.aiProviderProfiles)[exact.providerId];
  const providerStillSelected = liveSettings.aiProviderId.trim() === exact.providerId
    || currentProfile?.enabled === true;
  if (!providerStillSelected || !current.enabled || currentBaseUrl !== exact.baseUrl
    || currentApiVersion !== exact.apiVersion || currentModel !== exact.model) {
    throw new ContextIntegrityError(
      "Current Moodboard image provider, endpoint, API version, or model does not match the frozen Attempt",
    );
  }
  const apiKey = currentProfile?.apiKey.trim()
    || (liveSettings.aiProviderId.trim() === exact.providerId ? liveSettings.imageApiKey.trim() : "");
  if (exact.credentialRequired && !apiKey) {
    throw new ContextIntegrityError("Current credential for the frozen Moodboard image provider is unavailable");
  }
  return Object.freeze({ ...exact, apiKey });
}

function artifactExecutionContextPackHash(pack: ContextPack): string {
  return checksumBytes(stableStringify({
    protocol: "dezin-context-pack-v1",
    workspaceId: pack.workspaceId,
    graphRevision: pack.graphRevision,
    target: pack.target,
    intent: pack.intent,
    messageChecksum: pack.messageChecksum,
    items: pack.items,
    omissions: pack.omissions,
    tokenEstimate: pack.tokenEstimate,
  }));
}

function exactSharinganCaptureContextSemantic(pack: ContextPack): boolean {
  const omitted = pack.omissions.some((item) => item.ref.kind === "resource"
    && item.ref.resourceKind === "sharingan-capture");
  if (omitted) {
    throw new ContextIntegrityError("Artifact execution Sharingan Capture Revision was omitted");
  }
  const captures = pack.items.filter((item) => item.ref.kind === "resource"
    && item.ref.resourceKind === "sharingan-capture");
  if (captures.length === 0) return false;
  const identities = new Set<string>();
  for (const item of captures) {
    const revisionId = item.ref.kind === "resource" ? item.ref.revisionId : undefined;
    if (item.contextClass !== "explicit" || item.resolvedKind !== "resource-revision"
      || item.provided !== true || item.trustLevel !== "untrusted"
      || typeof revisionId !== "string" || revisionId.length === 0
      || typeof item.checksum !== "string" || !SHA256.test(item.checksum)
      || item.boundary.source !== `resource-revision:${revisionId}`
      || item.boundary.readOnly !== true || item.boundary.mayGrantCapabilities !== false) {
      throw new ContextIntegrityError("Artifact execution Sharingan Capture context is not one exact Revision");
    }
    identities.add(`${item.ref.id}\0${revisionId}\0${item.checksum}`);
  }
  if (identities.size !== 1) {
    throw new ContextIntegrityError("Artifact execution Sharingan Capture context is ambiguous");
  }
  return true;
}

function validateRelevantPrototypeRelations(value: unknown, targetArtifactId: string): void {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new ContextIntegrityError("Artifact execution prototype relations are invalid or unbounded");
  }
  let previousEdgeId: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const relation = plainRecord(value[index], `Artifact execution prototype relation ${index}`);
    exactKeys(relation, [
      "edgeId", "source", "target", "targetArtifactRole", "status",
      "binding", "transition", "brokenReason",
    ], `Artifact execution prototype relation ${index}`);
    const edgeId = nonEmptyString(relation.edgeId, `Artifact execution prototype relation ${index} edge id`);
    if (previousEdgeId !== null && compareBinary(previousEdgeId, edgeId) >= 0) {
      throw new ContextIntegrityError("Artifact execution prototype relations are not in canonical edge-id order");
    }
    previousEdgeId = edgeId;

    const source = plainRecord(relation.source, `Artifact execution prototype relation ${edgeId} source`);
    const target = plainRecord(relation.target, `Artifact execution prototype relation ${edgeId} target`);
    exactKeys(source, ["nodeId", "artifactId", "kind", "name", "revisionId"],
      `Artifact execution prototype relation ${edgeId} source`);
    exactKeys(target, ["nodeId", "artifactId", "kind", "name", "revisionId"],
      `Artifact execution prototype relation ${edgeId} target`);
    nonEmptyString(source.nodeId, `Artifact execution prototype relation ${edgeId} source node id`);
    nonEmptyString(target.nodeId, `Artifact execution prototype relation ${edgeId} target node id`);
    const sourceArtifactId = nonEmptyString(
      source.artifactId,
      `Artifact execution prototype relation ${edgeId} source Artifact id`,
    );
    const destinationArtifactId = nonEmptyString(
      target.artifactId,
      `Artifact execution prototype relation ${edgeId} target Artifact id`,
    );
    if ((source.kind !== "page" && source.kind !== "component")
      || (target.kind !== "page" && target.kind !== "component")) {
      throw new ContextIntegrityError(`Artifact execution prototype relation ${edgeId} endpoint kind is invalid`);
    }
    nonEmptyString(source.name, `Artifact execution prototype relation ${edgeId} source name`);
    nonEmptyString(target.name, `Artifact execution prototype relation ${edgeId} target name`);
    nullableString(source.revisionId, `Artifact execution prototype relation ${edgeId} source Revision id`);
    nullableString(target.revisionId, `Artifact execution prototype relation ${edgeId} target Revision id`);
    const sourceIsTaskTarget = sourceArtifactId === targetArtifactId;
    const destinationIsTaskTarget = destinationArtifactId === targetArtifactId;
    const expectedRole = sourceIsTaskTarget && destinationIsTaskTarget
      ? "both"
      : sourceIsTaskTarget
        ? "source"
        : destinationIsTaskTarget
          ? "target"
          : null;
    if (expectedRole === null || relation.targetArtifactRole !== expectedRole) {
      throw new ContextIntegrityError(
        `Artifact execution prototype relation ${edgeId} does not identify the Task target role`,
      );
    }

    if (relation.status !== "planned" && relation.status !== "interactive" && relation.status !== "broken") {
      throw new ContextIntegrityError(`Artifact execution prototype relation ${edgeId} status is invalid`);
    }
    let binding: Record<string, unknown> | null = null;
    if (relation.binding !== null) {
      binding = plainRecord(relation.binding, `Artifact execution prototype relation ${edgeId} binding`);
      exactKeys(binding, [
        "sourceArtifactId", "sourceRevisionId", "sourceLocator", "trigger",
        "targetArtifactId", "targetState",
      ], `Artifact execution prototype relation ${edgeId} binding`);
      if (binding.sourceArtifactId !== sourceArtifactId || binding.targetArtifactId !== destinationArtifactId) {
        throw new ContextIntegrityError(
          `Artifact execution prototype relation ${edgeId} binding endpoints are invalid`,
        );
      }
      nonEmptyString(binding.sourceRevisionId, `Artifact execution prototype relation ${edgeId} source Revision id`);
      if (binding.trigger !== "click" && binding.trigger !== "submit") {
        throw new ContextIntegrityError(`Artifact execution prototype relation ${edgeId} trigger is invalid`);
      }
      nullableString(binding.targetState, `Artifact execution prototype relation ${edgeId} target state`);
      const locator = plainRecord(
        binding.sourceLocator,
        `Artifact execution prototype relation ${edgeId} source locator`,
      );
      exactKeys(locator, ["designNodeId", "sourcePath", "selector"],
        `Artifact execution prototype relation ${edgeId} source locator`);
      nonEmptyString(locator.designNodeId, `Artifact execution prototype relation ${edgeId} design node id`);
      nullableString(locator.sourcePath, `Artifact execution prototype relation ${edgeId} source path`);
      nullableString(locator.selector, `Artifact execution prototype relation ${edgeId} selector`);
    }

    if (relation.transition !== null) {
      if (binding === null) {
        throw new ContextIntegrityError(
          `Artifact execution prototype relation ${edgeId} transition has no binding`,
        );
      }
      const transition = plainRecord(
        relation.transition,
        `Artifact execution prototype relation ${edgeId} transition`,
      );
      exactKeys(transition, ["type", "durationMs", "easing"],
        `Artifact execution prototype relation ${edgeId} transition`);
      if (transition.type !== "none" && transition.type !== "fade" && transition.type !== "slide") {
        throw new ContextIntegrityError(`Artifact execution prototype relation ${edgeId} transition type is invalid`);
      }
      if (!Number.isSafeInteger(transition.durationMs)
        || (transition.durationMs as number) < 0
        || (transition.durationMs as number) > MAX_PROTOTYPE_TRANSITION_DURATION_MS) {
        throw new ContextIntegrityError(`Artifact execution prototype relation ${edgeId} duration is invalid`);
      }
      nullableString(transition.easing, `Artifact execution prototype relation ${edgeId} easing`);
    }

    if (relation.status === "planned") {
      if (binding !== null || relation.transition !== null || relation.brokenReason !== null) {
        throw new ContextIntegrityError(`Artifact execution planned prototype relation ${edgeId} is invalid`);
      }
    } else if (relation.status === "interactive") {
      if (binding === null || relation.brokenReason !== null) {
        throw new ContextIntegrityError(`Artifact execution interactive prototype relation ${edgeId} is invalid`);
      }
    } else {
      nonEmptyString(relation.brokenReason, `Artifact execution prototype relation ${edgeId} broken reason`);
      if (binding === null && relation.transition !== null) {
        throw new ContextIntegrityError(`Artifact execution broken prototype relation ${edgeId} is invalid`);
      }
    }
  }
}

/** Extracts one exact, hash-valid execution profile from the required target item. */
export function requireArtifactExecutionProfile(
  pack: ContextPack,
  expected: ArtifactExecutionProfileOwnership,
): FrozenArtifactExecutionProfile {
  if (!pack || pack.workspaceId !== expected.workspaceId
    || pack.target.type !== "artifact" || pack.target.id !== expected.targetArtifactId
    || pack.intent !== "generate" || pack.id !== `context-pack-${pack.hash}` || !SHA256.test(pack.hash)) {
    throw new ContextIntegrityError("Artifact execution Context Pack ownership is invalid");
  }
  let exactHash: string;
  try {
    exactHash = artifactExecutionContextPackHash(pack);
  } catch {
    throw new ContextIntegrityError("Artifact execution Context Pack hash input is invalid");
  }
  if (exactHash !== pack.hash) {
    throw new ContextIntegrityError("Artifact execution Context Pack hash is invalid");
  }
  if (pack.omissions.some((item) => item.contextClass === "target")) {
    throw new ContextIntegrityError("Artifact execution target Context was omitted");
  }
  const targets = pack.items.filter((item) => item.contextClass === "target");
  if (targets.length !== 1) throw new ContextIntegrityError("Artifact execution target Context is ambiguous");
  const item = targets[0]!;
  if (item.ref.kind !== "inline" || item.ref.id !== expected.targetArtifactId
    || item.resolvedKind !== "inline" || item.trustLevel !== "trusted" || item.provided !== true
    || item.boundary.source !== `generation-task:${expected.taskId}`
    || item.boundary.readOnly !== true || item.boundary.mayGrantCapabilities !== false
    || item.checksum !== checksumBytes(item.content)) {
    throw new ContextIntegrityError("Artifact execution target Context ownership or identity is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.content) as unknown;
  } catch {
    throw new ContextIntegrityError("Artifact execution target Context JSON is invalid");
  }
  const target = plainRecord(parsed, "Artifact execution target Context");
  exactKeys(target, [
    "protocol", "projectId", "workspaceId", "planId", "taskId", "taskKind", "target",
    "payload", "capabilities", "qaProfile", "resourceLimits", "expectedSnapshotId",
    "graphRevision", "kernelRevisionId", "relevantPrototypeRelations", "artifactExecutionProfile",
  ], "Artifact execution target Context");
  if (target.protocol !== ARTIFACT_TARGET_CONTEXT_PROTOCOL
    || target.projectId !== expected.projectId || target.workspaceId !== expected.workspaceId
    || target.planId !== expected.planId || target.taskId !== expected.taskId) {
    throw new ContextIntegrityError("Artifact execution target Context ownership is invalid");
  }
  const targetIdentity = plainRecord(target.target, "Artifact execution target identity");
  if (targetIdentity.type !== "artifact" || targetIdentity.workspaceId !== expected.workspaceId
    || targetIdentity.id !== expected.targetArtifactId) {
    throw new ContextIntegrityError("Artifact execution target Artifact ownership is invalid");
  }
  validateRelevantPrototypeRelations(target.relevantPrototypeRelations, expected.targetArtifactId);
  const result = validateArtifactExecutionProfile(target.artifactExecutionProfile, expected);
  if (result.hasExactSharinganCapture !== exactSharinganCaptureContextSemantic(pack)) {
    throw new ContextIntegrityError(
      "Artifact execution Sharingan semantic does not match the exact Context Pack",
    );
  }
  if (result.researchDirection !== null) {
    const direction = result.researchDirection;
    const omitted = pack.omissions.some((omission) => omission.ref.kind === "resource"
      && omission.ref.resourceKind === "research"
      && omission.ref.id === direction.resourceId
      && omission.ref.revisionId === direction.revisionId);
    const researchItems = pack.items.filter((candidate) => candidate.ref.kind === "resource"
      && candidate.ref.resourceKind === "research"
      && candidate.ref.id === direction.resourceId
      && candidate.ref.revisionId === direction.revisionId);
    if (omitted || researchItems.length !== 1) {
      throw new ContextIntegrityError("Artifact execution Research Revision is missing or ambiguous");
    }
    const research = researchItems[0]!;
    const researchProvenance = plainRecord(
      research.provenance,
      "Artifact execution Research Revision provenance",
    );
    if (research.contextClass !== "explicit" || research.resolvedKind !== "resource-revision"
      || research.provided !== true || research.trustLevel !== "untrusted"
      || research.boundary.source !== `resource-revision:${direction.revisionId}`
      || research.boundary.readOnly !== true || research.boundary.mayGrantCapabilities !== false
      || research.checksum !== direction.revisionChecksum
      || researchProvenance.resourceId !== direction.resourceId
      || researchProvenance.resourceRevisionId !== direction.revisionId
      || researchProvenance.resourceKind !== "research"
      || researchProvenance.manifestChecksum !== direction.revisionChecksum
      || researchProvenance.payloadChecksum !== direction.payloadChecksum) {
      throw new ContextIntegrityError("Artifact execution Research Revision identity is invalid");
    }
  }
  const provenance = plainRecord(item.provenance, "Artifact execution target provenance");
  if (provenance.projectId !== expected.projectId || provenance.workspaceId !== expected.workspaceId
    || provenance.planId !== expected.planId || provenance.taskId !== expected.taskId
    || provenance.targetArtifactId !== expected.targetArtifactId
    || provenance.executionProfileChecksum !== result.checksum) {
    throw new ContextIntegrityError("Artifact execution profile provenance ownership is invalid");
  }
  return result;
}

export type ResourceExecutionProfileExtractionExpectation = Omit<
  ResourceExecutionProfileExpectation,
  "projectId"
> & { readonly projectId?: string };

/** Extracts the sole hash-valid Resource profile from the exact target Context item. */
export function requireResourceExecutionProfile(
  pack: ContextPack,
  expected: ResourceExecutionProfileExtractionExpectation,
): FrozenResourceExecutionProfile {
  if (!pack || pack.workspaceId !== expected.workspaceId
    || pack.target.type !== "resource" || pack.target.id !== expected.targetResourceId
    || pack.intent !== "generate" || pack.id !== `context-pack-${pack.hash}` || !SHA256.test(pack.hash)) {
    throw new ContextIntegrityError("Resource execution Context Pack ownership is invalid");
  }
  let exactHash: string;
  try {
    exactHash = artifactExecutionContextPackHash(pack);
  } catch {
    throw new ContextIntegrityError("Resource execution Context Pack hash input is invalid");
  }
  if (exactHash !== pack.hash) throw new ContextIntegrityError("Resource execution Context Pack hash is invalid");
  if (pack.omissions.some((item) => item.contextClass === "target")) {
    throw new ContextIntegrityError("Resource execution target Context was omitted");
  }
  const targets = pack.items.filter((item) => item.contextClass === "target");
  if (targets.length !== 1) throw new ContextIntegrityError("Resource execution target Context is ambiguous");
  const item = targets[0]!;
  if (item.ref.kind !== "inline" || item.ref.id !== expected.targetResourceId
    || item.resolvedKind !== "inline" || item.trustLevel !== "trusted" || item.provided !== true
    || item.boundary.source !== `generation-task:${expected.taskId}`
    || item.boundary.readOnly !== true || item.boundary.mayGrantCapabilities !== false
    || item.checksum !== checksumBytes(item.content)) {
    throw new ContextIntegrityError("Resource execution target Context ownership or identity is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.content) as unknown;
  } catch {
    throw new ContextIntegrityError("Resource execution target Context JSON is invalid");
  }
  const target = plainRecord(parsed, "Resource execution target Context");
  exactKeys(target, [
    "protocol", "projectId", "workspaceId", "planId", "taskId", "taskKind", "target",
    "payload", "capabilities", "qaProfile", "resourceLimits", "expectedSnapshotId",
    "graphRevision", "kernelRevisionId", "resourceExecutionProfile",
  ], "Resource execution target Context");
  const projectId = nonEmptyString(target.projectId, "Resource execution target Project id");
  if (target.protocol !== RESOURCE_TARGET_CONTEXT_PROTOCOL
    || (expected.projectId !== undefined && projectId !== expected.projectId)
    || target.workspaceId !== expected.workspaceId || target.planId !== expected.planId
    || target.taskId !== expected.taskId || target.taskKind !== "resource") {
    throw new ContextIntegrityError("Resource execution target Context ownership is invalid");
  }
  const targetIdentity = plainRecord(target.target, "Resource execution target identity");
  if (targetIdentity.type !== "resource" || targetIdentity.workspaceId !== expected.workspaceId
    || targetIdentity.id !== expected.targetResourceId) {
    throw new ContextIntegrityError("Resource execution target Resource ownership is invalid");
  }
  const payload = plainRecord(target.payload, "Resource execution Task payload");
  const payloadAdapter = plainRecord(payload.adapter, "Resource execution Task adapter");
  exactKeys(payloadAdapter, ["id", "version", "kind"], "Resource execution Task adapter");
  const payloadOperation = plainRecord(payload.operation, "Resource execution Task operation");
  if (payload.version !== 2 || payloadOperation.resourceId !== expected.targetResourceId
    || payloadOperation.kind !== expected.resourceKind
    || payloadAdapter.id !== expected.adapter.id || payloadAdapter.version !== expected.adapter.version
    || payloadAdapter.kind !== expected.adapter.kind) {
    throw new ContextIntegrityError("Resource execution Task payload adapter or target is invalid");
  }
  const exactExpected: ResourceExecutionProfileExpectation = {
    projectId,
    workspaceId: expected.workspaceId,
    planId: expected.planId,
    taskId: expected.taskId,
    targetResourceId: expected.targetResourceId,
    resourceKind: expected.resourceKind,
    adapter: expected.adapter,
  };
  const result = validateResourceExecutionProfile(target.resourceExecutionProfile, exactExpected);
  const provenance = plainRecord(item.provenance, "Resource execution target provenance");
  if (provenance.projectId !== projectId || provenance.workspaceId !== expected.workspaceId
    || provenance.planId !== expected.planId || provenance.taskId !== expected.taskId
    || provenance.targetResourceId !== expected.targetResourceId
    || provenance.resourceExecutionProfileChecksum !== result.checksum) {
    throw new ContextIntegrityError("Resource execution profile provenance ownership is invalid");
  }
  return result;
}

export interface GenerationContextWorkspacePort {
  getWorkspace(projectId: string): Pick<
    ProjectWorkspace,
    "id" | "projectId" | "graphRevision" | "activeSnapshotId" | "activeKernelRevisionId"
  > | null;
  getSnapshotForProject(projectId: string, snapshotId: string): WorkspaceSnapshot | null;
  getGraphRevision(projectId: string, revision: number): WorkspaceGraph;
  getKernelRevision(revisionId: string): SharedDesignKernelRevision | null;
  getArtifact(artifactId: string): WorkspaceArtifactRecord | null;
  getArtifactRevision(revisionId: string): ArtifactRevisionRecord | null;
  isArtifactRevisionPublished(revisionId: string): boolean;
  getArtifactRevisionContextChecksum(revisionId: string): string | null;
  listArtifactRevisionDependencies(revisionId: string): ArtifactRevisionDependency[];
  listArtifactRevisionResourcePins(revisionId: string): ArtifactRevisionResourcePin[];
  getResourceForProject(projectId: string, resourceId: string): Resource | null;
  getResourceRevisionForProject(
    projectId: string,
    resourceId: string,
    revisionId: string,
  ): ResourceRevision | null;
}

export interface ExactResourceSnapshotRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly resourceKind: Resource["kind"];
  readonly resource: Resource;
  readonly revision: ResourceRevision;
}

export type ExactResourceSnapshotLoader = (
  input: ExactResourceSnapshotRequest,
  signal: AbortSignal,
) => Promise<ResourceRevisionSnapshot | null>;

export type ArtifactExecutionProfileLoader = (
  input: GenerationTaskContextRequest,
  signal: AbortSignal,
) => FrozenArtifactExecutionProfile | Promise<FrozenArtifactExecutionProfile>;

export type ResourceExecutionProfileLoader = (
  input: GenerationTaskContextRequest,
  signal: AbortSignal,
) => FrozenResourceExecutionProfile | Promise<FrozenResourceExecutionProfile>;

export interface ProductionGenerationTaskContextResolverOptions {
  readonly workspace: GenerationContextWorkspacePort;
  readonly packStore: ContextPackStore;
  readonly resourceStorageRoot: string;
  readonly loadResourceSnapshot: ExactResourceSnapshotLoader;
  readonly loadArtifactExecutionProfile?: ArtifactExecutionProfileLoader;
  readonly loadResourceExecutionProfile?: ResourceExecutionProfileLoader;
  /** Immutable source dispatch packs; required only for scoped Agent leaves. */
  readonly dispatchContextPacks?: Pick<ContextPackRepository, "get">;
  readonly adapters?: ResourceAdapterRegistry;
}

export interface ProductionGenerationTaskContextFactoryOptions {
  readonly store: Store;
  readonly dataDir: string;
  readonly designRegistry: DesignRegistry;
  readonly repositoryDirForWorkspace: (
    workspaceId: string,
    signal: AbortSignal,
  ) => string | Promise<string>;
  readonly manifestRoot?: string;
}

export interface ProductionArtifactExecutionProfileLoaderOptions {
  readonly store: Store;
  readonly dataDir: string;
  readonly designRegistry: DesignRegistry;
  readonly contextPacks?: Pick<ContextPackRepository, "get">;
  readonly repositoryDirForWorkspace: (
    workspaceId: string,
    signal: AbortSignal,
  ) => string | Promise<string>;
}

export interface ProductionResourceExecutionProfileLoaderOptions {
  readonly store: Store;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Context resolution aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidate(input: Omit<ContextCandidate, "tokenEstimate" | "provided">): ContextCandidate {
  return cloneAndFreeze({
    ...input,
    tokenEstimate: estimateContextTokens(input.content),
    provided: true,
  });
}

function exactRequest(input: GenerationTaskContextRequest): void {
  const { task, observation } = input;
  if (task.id !== observation.taskId || task.planId !== input.planId
    || observation.planId !== input.planId || task.workspaceId !== observation.workspaceId
    || task.target.workspaceId !== task.workspaceId
    || observation.target.workspaceId !== task.workspaceId
    || !isDeepStrictEqual(task.target, observation.target)
    || !isDeepStrictEqual(task.payload, observation.payload)) {
    throw new ContextIntegrityError("Generation Context request does not match one exact Task observation");
  }
}

function dispatchContextPackId(input: GenerationTaskContextRequest): string | null {
  let value: unknown;
  if (input.task.target.type === "artifact") {
    value = plainRecord(input.task.payload.artifactPlan, "Generation Artifact plan").dispatchContextPackId;
  } else if (input.task.target.type === "resource") {
    value = plainRecord(input.task.payload.operation, "Generation Resource operation").dispatchContextPackId;
  } else {
    return null;
  }
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^context-pack-[0-9a-f]{64}$/.test(value)) {
    throw new ContextIntegrityError("Generation Task dispatch Context Pack id is invalid");
  }
  return value;
}

function taskProposalRationale(input: GenerationTaskContextRequest): string {
  const brief = plainRecord(input.task.payload.brief, "Generation Task brief");
  return nonEmptyString(brief.proposalRationale, "Generation Task Proposal rationale");
}

function exactDispatchContextPack(input: {
  request: GenerationTaskContextRequest;
  repository: Pick<ContextPackRepository, "get"> | undefined;
  currentSnapshot: WorkspaceSnapshot;
  currentGraphRevision: number;
}): ContextPack | null {
  const id = dispatchContextPackId(input.request);
  if (id === null) return null;
  if (input.repository === undefined) {
    throw new ContextIntegrityError("Generation Task dispatch Context Pack repository is unavailable");
  }
  const pack = input.repository.get(input.request.task.workspaceId, id);
  let exactHash: string | null = null;
  try {
    exactHash = pack === null ? null : artifactExecutionContextPackHash(pack);
  } catch {
    exactHash = null;
  }
  if (!pack || pack.id !== id || pack.id !== `context-pack-${pack.hash}` || !SHA256.test(pack.hash)
    || exactHash !== pack.hash) {
    throw new ContextIntegrityError("Generation Task dispatch Context Pack is missing or hash-substituted");
  }
  const task = input.request.task;
  if (pack.workspaceId !== task.workspaceId
    || pack.target.type !== task.target.type || pack.target.id !== task.target.id
    || (pack.intent !== "generate" && pack.intent !== "edit" && pack.intent !== "repair")
    || pack.messageChecksum !== checksumBytes(taskProposalRationale(input.request))) {
    throw new ContextIntegrityError(
      "Generation Task dispatch Context Pack owner, target, intent, or message lineage is invalid",
    );
  }
  const targetItems = pack.items.filter((item) => item.contextClass === "target"
    && item.ref.id === task.target.id);
  const targetProvenance = targetItems[0]?.provenance;
  if (targetItems.length !== 1 || pack.omissions.some((omission) => omission.contextClass === "target")
    || !targetProvenance || targetProvenance.workspaceId !== task.workspaceId
    || targetProvenance.graphRevision !== pack.graphRevision
    || typeof targetProvenance.snapshotId !== "string" || targetProvenance.snapshotId.length === 0) {
    throw new ContextIntegrityError("Generation Task dispatch Context Pack graph anchor is invalid");
  }
  const latestContextRefresh = (task.currentAttempt ?? 0) > 0
    && task.pendingContextPolicy === "latest-context";
  if ((!latestContextRefresh && (pack.graphRevision !== input.currentGraphRevision
      || targetProvenance.snapshotId !== input.currentSnapshot.id))
    || (latestContextRefresh && pack.graphRevision > input.currentGraphRevision)) {
    throw new ContextIntegrityError("Generation Task dispatch Context Pack graph lineage is invalid");
  }
  if (pack.omissions.some((omission) => omission.contextClass === "selection"
    || omission.contextClass === "explicit")) {
    throw new ContextIntegrityError("Generation Task dispatch evidence was omitted");
  }
  return pack;
}

function contextItemKey(item: ContextPack["items"][number]): string {
  return stableStringify({
    contextClass: item.contextClass,
    resolvedKind: item.resolvedKind,
    ref: item.ref,
  });
}

function contextClassRefKey(input: {
  contextClass: ContextPack["items"][number]["contextClass"];
  ref: ContextPack["items"][number]["ref"];
}): string {
  return stableStringify({ contextClass: input.contextClass, ref: input.ref });
}

function contextItemValueKey(item: ContextPack["items"][number]): string {
  const { ordinal: _ordinal, ...value } = item;
  return stableStringify(value);
}

export function mergeDispatchEvidence(
  current: ContextPack,
  dispatch: ContextPack | null,
  packStore: ContextPackStore,
): ContextPack {
  if (dispatch === null) return current;
  const evidence = dispatch.items.filter((item) => item.contextClass === "selection"
    || item.contextClass === "explicit");
  const byIdentity = new Map<string, ContextPack["items"][number]>();
  for (const item of current.items) {
    const key = contextItemKey(item);
    if (byIdentity.has(key)) {
      throw new ContextIntegrityError("Current Generation Context contains duplicate provided identity");
    }
    byIdentity.set(key, item);
  }
  for (const item of evidence) {
    const key = contextItemKey(item);
    const existing = byIdentity.get(key);
    if (existing !== undefined) {
      if (contextItemValueKey(existing) !== contextItemValueKey(item)) {
        throw new ContextIntegrityError(
          `Generation dispatch evidence conflicts with current Context identity ${item.ref.id}`,
        );
      }
      continue;
    }
    byIdentity.set(key, item);
  }
  const priority = new Map(CONTEXT_PRIORITY.map((contextClass, ordinal) => [contextClass, ordinal]));
  const items = [...byIdentity.values()]
    .sort((left, right) => (priority.get(left.contextClass)! - priority.get(right.contextClass)!)
      || compareBinary(contextItemKey(left), contextItemKey(right)))
    .map((item, ordinal) => ({ ...structuredClone(item), ordinal }));
  const tokenEstimate = items.reduce((total, item) => total + item.tokenEstimate, 0);
  const providedClassRefs = new Set(items.map(contextClassRefKey));
  const omissions = current.omissions.filter(
    (omission) => !providedClassRefs.has(contextClassRefKey(omission)),
  );
  if (tokenEstimate > 64_000) {
    throw new BlockedContextError(
      evidence.map((item) => item.ref.id),
      "Scoped dispatch evidence and current Generation context exceed the Context budget",
    );
  }
  return packStore.persist({
    workspaceId: current.workspaceId,
    graphRevision: current.graphRevision,
    target: current.target,
    intent: "generate",
    messageChecksum: current.messageChecksum,
    items,
    omissions,
    tokenEstimate,
  });
}

function exactSnapshot(
  workspace: GenerationContextWorkspacePort,
  input: GenerationTaskContextRequest,
): { snapshot: WorkspaceSnapshot; graph: WorkspaceGraph; kernel: SharedDesignKernelRevision } {
  const owner = workspace.getWorkspace(input.projectId);
  if (!owner || owner.id !== input.task.workspaceId || owner.projectId !== input.projectId) {
    throw new ContextIntegrityError("Generation Context Workspace ownership is invalid");
  }
  const snapshot = workspace.getSnapshotForProject(
    input.projectId,
    input.observation.expectedSnapshotId,
  );
  if (snapshot === null) {
    throw new BlockedContextError(
      [input.observation.expectedSnapshotId],
      "Generation Context expected Snapshot is unavailable",
    );
  }
  if (snapshot.workspaceId !== owner.id
    || snapshot.kernelRevisionId !== input.observation.kernelRevisionId) {
    throw new ContextIntegrityError("Generation Context Snapshot does not match its immutable observation");
  }
  const graph = workspace.getGraphRevision(input.projectId, snapshot.graphRevision);
  if (graph.workspaceId !== owner.id || graph.revision !== snapshot.graphRevision
    || !isDeepStrictEqual(graph, snapshot.graph)) {
    throw new ContextIntegrityError("Generation Context Snapshot graph is not the exact immutable graph Revision");
  }
  const kernel = workspace.getKernelRevision(input.observation.kernelRevisionId);
  if (!kernel || kernel.id !== input.observation.kernelRevisionId
    || kernel.workspaceId !== owner.id || !SHA256.test(kernel.checksum)) {
    throw new BlockedContextError(
      [input.observation.kernelRevisionId],
      "Generation Context Kernel Revision is unavailable or foreign",
    );
  }
  return { snapshot, graph, kernel };
}

export interface RelevantPrototypeRelation {
  readonly edgeId: string;
  readonly source: {
    readonly nodeId: string;
    readonly artifactId: string;
    readonly kind: "page" | "component";
    readonly name: string;
    readonly revisionId: string | null;
  };
  readonly target: {
    readonly nodeId: string;
    readonly artifactId: string;
    readonly kind: "page" | "component";
    readonly name: string;
    readonly revisionId: string | null;
  };
  readonly targetArtifactRole: "source" | "target" | "both";
  readonly status: "planned" | "interactive" | "broken";
  readonly binding: {
    readonly sourceArtifactId: string;
    readonly sourceRevisionId: string;
    readonly sourceLocator: {
      readonly designNodeId: string;
      readonly sourcePath: string | null;
      readonly selector: string | null;
    };
    readonly trigger: "click" | "submit";
    readonly targetArtifactId: string;
    readonly targetState: string | null;
  } | null;
  readonly transition: {
    readonly type: "none" | "fade" | "slide";
    readonly durationMs: number;
    readonly easing: string | null;
  } | null;
  readonly brokenReason: string | null;
}

/**
 * Projects exact frozen prototype semantics into Agent Context. Stored graph
 * labels are intentionally not authoritative: the same Core resolver used by
 * the Viewer derives stale revisions, missing states, and locator collisions.
 */
export function buildRelevantPrototypeRelations(input: {
  readonly graph: WorkspaceGraph;
  readonly snapshot: Pick<WorkspaceSnapshot, "artifactRevisions">;
  readonly targetArtifactId: string;
  readonly getArtifactRevision: (revisionId: string) => ArtifactRevisionRecord | null;
}): readonly RelevantPrototypeRelation[] {
  const targetNodes = input.graph.nodes.filter(
    (node) => node.kind !== "resource" && node.artifactId === input.targetArtifactId,
  );
  if (targetNodes.length === 0) return [];
  if (targetNodes.length !== 1) {
    throw new ContextIntegrityError("Generation target Artifact has ambiguous Workspace graph nodes");
  }
  const targetNode = targetNodes[0]!;
  const artifactNodes = input.graph.nodes.filter(
    (node): node is Extract<typeof node, { kind: "page" | "component" }> => node.kind !== "resource",
  );
  const endpoints = artifactNodes.map((node) => {
    const revisionId = input.snapshot.artifactRevisions[node.artifactId] ?? null;
    const revision = revisionId === null ? null : input.getArtifactRevision(revisionId);
    const frames = revision !== null
      && revision.id === revisionId
      && revision.workspaceId === input.graph.workspaceId
      && revision.artifactId === node.artifactId
      ? readFrozenPrototypeRenderFrames(revision.renderSpec)
      : null;
    return {
      nodeId: node.id,
      artifactId: node.artifactId,
      revisionId,
      targetStates: frames === null
        ? null
        : frames.flatMap((frame) => frame.initialState === undefined ? [] : [frame.initialState]),
    };
  });
  const prototypeEdges = input.graph.edges.filter(
    (edge): edge is Extract<typeof edge, { kind: "prototype" }> => edge.kind === "prototype",
  );
  const resolutions = resolveFrozenPrototypeRelations({ endpoints, edges: prototypeEdges });
  const nodesById = new Map(artifactNodes.map((node) => [node.id, node]));
  return prototypeEdges
    .filter((edge) => edge.sourceNodeId === targetNode.id || edge.targetNodeId === targetNode.id)
    .sort((left, right) => compareBinary(left.id, right.id))
    .map((edge): RelevantPrototypeRelation => {
      const sourceNode = nodesById.get(edge.sourceNodeId);
      const destinationNode = nodesById.get(edge.targetNodeId);
      const resolution = resolutions.get(edge.id);
      if (sourceNode === undefined || destinationNode === undefined || resolution === undefined) {
        throw new ContextIntegrityError(
          `Generation target prototype relation ${edge.id} has a missing or non-Artifact endpoint`,
        );
      }
      const sourceIsTarget = sourceNode.id === targetNode.id;
      const destinationIsTarget = destinationNode.id === targetNode.id;
      const resolvedBinding = resolution.binding;
      const binding = resolvedBinding === null ? null : {
        sourceArtifactId: resolvedBinding.sourceArtifactId,
        sourceRevisionId: resolvedBinding.sourceRevisionId,
        sourceLocator: {
          designNodeId: resolvedBinding.sourceLocator.designNodeId,
          sourcePath: resolvedBinding.sourceLocator.sourcePath ?? null,
          selector: resolvedBinding.sourceLocator.selector ?? null,
        },
        trigger: resolvedBinding.trigger,
        targetArtifactId: resolvedBinding.targetArtifactId,
        targetState: resolvedBinding.targetState ?? null,
      };
      const transition = resolution.transition === null ? null : {
        type: resolution.transition.type,
        durationMs: resolution.transition.durationMs,
        easing: resolution.transition.easing ?? null,
      };
      return {
        edgeId: edge.id,
        source: {
          nodeId: sourceNode.id,
          artifactId: sourceNode.artifactId,
          kind: sourceNode.kind,
          name: sourceNode.name,
          revisionId: input.snapshot.artifactRevisions[sourceNode.artifactId] ?? null,
        },
        target: {
          nodeId: destinationNode.id,
          artifactId: destinationNode.artifactId,
          kind: destinationNode.kind,
          name: destinationNode.name,
          revisionId: input.snapshot.artifactRevisions[destinationNode.artifactId] ?? null,
        },
        targetArtifactRole: sourceIsTarget && destinationIsTarget
          ? "both"
          : sourceIsTarget
            ? "source"
            : "target",
        status: resolution.status,
        binding,
        transition,
        brokenReason: resolution.status === "broken" ? resolution.detail : null,
      };
    });
}

class FrozenTaskContextSource implements ContextCandidateSource {
  readonly #workspace: GenerationContextWorkspacePort;
  readonly #loadResourceSnapshot: ExactResourceSnapshotLoader;
  readonly #input: GenerationTaskContextRequest;
  readonly #snapshot: WorkspaceSnapshot;
  readonly #graph: WorkspaceGraph;
  readonly #kernel: SharedDesignKernelRevision;
  readonly #artifactExecutionProfile: FrozenArtifactExecutionProfile | null;
  readonly #resourceExecutionProfile: FrozenResourceExecutionProfile | null;
  readonly #signal: AbortSignal;

  constructor(input: {
    workspace: GenerationContextWorkspacePort;
    loadResourceSnapshot: ExactResourceSnapshotLoader;
    request: GenerationTaskContextRequest;
    snapshot: WorkspaceSnapshot;
    graph: WorkspaceGraph;
    kernel: SharedDesignKernelRevision;
    artifactExecutionProfile: FrozenArtifactExecutionProfile | null;
    resourceExecutionProfile?: FrozenResourceExecutionProfile | null;
    signal: AbortSignal;
  }) {
    this.#workspace = input.workspace;
    this.#loadResourceSnapshot = input.loadResourceSnapshot;
    this.#input = input.request;
    this.#snapshot = input.snapshot;
    this.#graph = input.graph;
    this.#kernel = input.kernel;
    this.#artifactExecutionProfile = input.artifactExecutionProfile;
    this.#resourceExecutionProfile = input.resourceExecutionProfile ?? null;
    this.#signal = input.signal;
  }

  async collect(
    _request: AgentTurnRequest,
    contextClass: Exclude<ContextItemClass, "explicit">,
  ): Promise<readonly ContextCandidate[]> {
    checkAbort(this.#signal);
    if (contextClass === "system-kernel") return [this.#kernelCandidate()];
    if (contextClass === "target") return [this.#targetCandidate()];
    if (contextClass === "prototype-neighbor") return this.#prototypeNeighbors();
    return [];
  }

  async resolveExplicit(
    _request: AgentTurnRequest,
    ref: ContextItemRef,
  ): Promise<ExplicitContextResolution> {
    checkAbort(this.#signal);
    if (ref.kind === "artifact") {
      if (ref.revisionId === undefined) return null;
      return this.#artifactCandidate(ref.id, ref.revisionId, "explicit", "exact Task Artifact dependency");
    }
    if (ref.kind === "resource") {
      if (ref.revisionId === undefined) return null;
      const resource = this.#workspace.getResourceForProject(this.#input.projectId, ref.id);
      const revision = resource
        ? this.#workspace.getResourceRevisionForProject(this.#input.projectId, ref.id, ref.revisionId)
        : null;
      if (!resource || !revision || resource.workspaceId !== this.#input.task.workspaceId
        || resource.kind !== ref.resourceKind || revision.workspaceId !== resource.workspaceId
        || revision.resourceId !== resource.id || revision.id !== ref.revisionId
        || revision.checksum.length !== 64) {
        return null;
      }
      const snapshot = await this.#loadResourceSnapshot({
        projectId: this.#input.projectId,
        workspaceId: this.#input.task.workspaceId,
        resourceId: resource.id,
        revisionId: revision.id,
        resourceKind: resource.kind,
        resource,
        revision,
      }, this.#signal);
      checkAbort(this.#signal);
      if (!snapshot || snapshot.id !== revision.id || snapshot.workspaceId !== revision.workspaceId
        || snapshot.resourceId !== revision.resourceId || snapshot.kind !== resource.kind
        || snapshot.checksum !== revision.checksum) {
        throw new ContextIntegrityError(`Resource Revision ${revision.id} snapshot identity changed during resolution`);
      }
      return snapshot;
    }
    if (ref.kind === "kernel" && ref.revisionId === this.#kernel.id && ref.id === this.#kernel.id) {
      return this.#kernelCandidate();
    }
    return null;
  }

  #kernelCandidate(): ContextCandidate {
    const content = stableStringify({
      protocol: "dezin.generation-kernel-context.v1",
      revision: this.#kernel,
    });
    return candidate({
      contextClass: "system-kernel",
      ref: { kind: "kernel", id: this.#kernel.id, revisionId: this.#kernel.id },
      resolvedKind: "kernel-revision",
      content,
      checksum: this.#kernel.checksum,
      reason: "exact immutable Shared Design Kernel Revision",
      trustLevel: "system",
      capabilities: [],
      boundary: {
        source: `kernel-revision:${this.#kernel.id}`,
        readOnly: true,
        mayGrantCapabilities: false,
      },
      provenance: {
        workspaceId: this.#kernel.workspaceId,
        kernelRevisionId: this.#kernel.id,
        snapshotId: this.#snapshot.id,
      },
    });
  }

  #targetCandidate(): ContextCandidate {
    const task = this.#input.task;
    const content = stableStringify({
      protocol: this.#artifactExecutionProfile !== null
        ? ARTIFACT_TARGET_CONTEXT_PROTOCOL
        : this.#resourceExecutionProfile !== null
          ? RESOURCE_TARGET_CONTEXT_PROTOCOL
          : "dezin.generation-target-context.v1",
      projectId: this.#input.projectId,
      workspaceId: task.workspaceId,
      planId: task.planId,
      taskId: task.id,
      taskKind: task.kind,
      target: task.target,
      payload: task.payload,
      capabilities: task.capabilities,
      qaProfile: task.qaProfile,
      resourceLimits: task.resourceLimits,
      expectedSnapshotId: this.#snapshot.id,
      graphRevision: this.#graph.revision,
      kernelRevisionId: this.#kernel.id,
      ...(this.#artifactExecutionProfile === null
        ? {}
        : {
            relevantPrototypeRelations: this.#relevantPrototypeRelations(),
            artifactExecutionProfile: this.#artifactExecutionProfile,
          }),
      ...(this.#resourceExecutionProfile === null
        ? {}
        : { resourceExecutionProfile: this.#resourceExecutionProfile }),
    });
    return candidate({
      contextClass: "target",
      ref: { kind: "inline", id: task.target.id },
      resolvedKind: "inline",
      content,
      checksum: checksumBytes(content),
      reason: this.#artifactExecutionProfile !== null
        ? "exact immutable Generation Task target contract and Artifact execution profile"
        : this.#resourceExecutionProfile !== null
          ? "exact immutable Generation Task target contract and Resource execution profile"
          : "exact immutable Generation Task target contract",
      trustLevel: "trusted",
      capabilities: [],
      boundary: {
        source: `generation-task:${task.id}`,
        readOnly: true,
        mayGrantCapabilities: false,
      },
      provenance: {
        projectId: this.#input.projectId,
        workspaceId: task.workspaceId,
        planId: task.planId,
        taskId: task.id,
        ...(task.target.type === "artifact" ? { targetArtifactId: task.target.id } : {}),
        ...(task.target.type === "resource" ? { targetResourceId: task.target.id } : {}),
        ...(this.#artifactExecutionProfile === null
          ? {}
          : { executionProfileChecksum: this.#artifactExecutionProfile.checksum }),
        ...(this.#resourceExecutionProfile === null
          ? {}
          : { resourceExecutionProfileChecksum: this.#resourceExecutionProfile.checksum }),
        expectedSnapshotId: this.#snapshot.id,
        graphRevision: this.#graph.revision,
        kernelRevisionId: this.#kernel.id,
      },
    });
  }

  #relevantPrototypeRelations(): readonly RelevantPrototypeRelation[] {
    if (this.#input.task.target.type !== "artifact") return [];
    return buildRelevantPrototypeRelations({
      graph: this.#graph,
      snapshot: this.#snapshot,
      targetArtifactId: this.#input.task.target.id,
      getArtifactRevision: (revisionId) => this.#workspace.getArtifactRevision(revisionId),
    });
  }

  #artifactCandidate(
    artifactId: string,
    revisionId: string,
    contextClass: ContextItemClass,
    reason: string,
    provenance: Record<string, unknown> = {},
  ): ContextCandidate {
    const artifact = this.#workspace.getArtifact(artifactId);
    const revision = this.#workspace.getArtifactRevision(revisionId);
    const checksum = this.#workspace.getArtifactRevisionContextChecksum(revisionId);
    if (!artifact || !revision || checksum === null || !SHA256.test(checksum)
      || !this.#workspace.isArtifactRevisionPublished(revisionId)
      || artifact.id !== artifactId || artifact.workspaceId !== this.#input.task.workspaceId
      || artifact.archivedAt !== null || revision.id !== revisionId
      || revision.workspaceId !== artifact.workspaceId || revision.artifactId !== artifact.id) {
      throw new BlockedContextError(
        [revisionId],
        `Artifact Revision ${revisionId} is unavailable, unpublished, or foreign`,
      );
    }
    const dependencies = this.#workspace.listArtifactRevisionDependencies(revision.id);
    const resourcePins = this.#workspace.listArtifactRevisionResourcePins(revision.id);
    const content = stableStringify({
      protocol: "dezin.artifact-revision-context.v1",
      artifact,
      revision,
      dependencies,
      resourcePins,
    });
    return candidate({
      contextClass,
      ref: { kind: "artifact", id: artifact.id, revisionId: revision.id },
      resolvedKind: "artifact-revision",
      content,
      checksum,
      reason,
      trustLevel: "trusted",
      capabilities: [],
      boundary: {
        source: `artifact-revision:${revision.id}`,
        readOnly: true,
        mayGrantCapabilities: false,
      },
      provenance: {
        artifactId: artifact.id,
        artifactRevisionId: revision.id,
        sourceCommitHash: revision.sourceCommitHash,
        sourceTreeHash: revision.sourceTreeHash,
        ...provenance,
      },
    });
  }

  #prototypeNeighbors(): ContextCandidate[] {
    if (this.#input.task.target.type !== "artifact") return [];
    const targetNode = this.#graph.nodes.find(
      (node) => node.kind !== "resource" && node.artifactId === this.#input.task.target.id,
    );
    if (!targetNode) return [];
    const byRevision = new Map<string, {
      artifactId: string;
      edgeIds: Set<string>;
    }>();
    for (const edge of this.#graph.edges) {
      if (edge.kind !== "prototype"
        || (edge.sourceNodeId !== targetNode.id && edge.targetNodeId !== targetNode.id)) continue;
      const neighborNodeId = edge.sourceNodeId === targetNode.id ? edge.targetNodeId : edge.sourceNodeId;
      const neighbor = this.#graph.nodes.find((node) => node.id === neighborNodeId);
      if (!neighbor || neighbor.kind === "resource") continue;
      const revisionId = this.#snapshot.artifactRevisions[neighbor.artifactId];
      if (!revisionId) continue;
      const existing = byRevision.get(revisionId);
      if (existing !== undefined && existing.artifactId !== neighbor.artifactId) {
        throw new ContextIntegrityError("Prototype-neighbor Revision resolves to multiple Artifacts");
      }
      if (existing === undefined) {
        byRevision.set(revisionId, { artifactId: neighbor.artifactId, edgeIds: new Set([edge.id]) });
      } else {
        existing.edgeIds.add(edge.id);
      }
    }
    return [...byRevision.entries()]
      .map(([revisionId, neighbor]) => this.#artifactCandidate(
        neighbor.artifactId,
        revisionId,
        "prototype-neighbor",
        "exact prototype-neighbor Artifact Revision",
        {
          prototypeEdgeIds: [...neighbor.edgeIds].sort(compareBinary),
          targetArtifactId: this.#input.task.target.id,
        },
      ))
      .sort((left, right) => compareBinary(left.ref.id, right.ref.id));
  }
}

function explicitRefs(
  workspace: GenerationContextWorkspacePort,
  input: GenerationTaskContextRequest,
): ContextItemRef[] {
  const refs: ContextItemRef[] = [];
  const { observation, task } = input;
  if (observation.baseRevisionId !== null) {
    if (task.target.type === "artifact") {
      refs.push({ kind: "artifact", id: task.target.id, revisionId: observation.baseRevisionId });
    } else if (task.target.type === "resource") {
      const resource = workspace.getResourceForProject(input.projectId, task.target.id);
      if (!resource || resource.workspaceId !== task.workspaceId) {
        throw new BlockedContextError([task.target.id], "Generation target Resource is unavailable or foreign");
      }
      refs.push({
        kind: "resource",
        id: resource.id,
        resourceKind: resource.kind,
        revisionId: observation.baseRevisionId,
      });
    }
  }
  for (const pin of observation.resourcePins) {
    const resource = workspace.getResourceForProject(input.projectId, pin.resourceId);
    if (!resource || resource.workspaceId !== task.workspaceId) {
      throw new BlockedContextError([pin.resourceId], "Pinned Resource is unavailable or foreign");
    }
    refs.push({
      kind: "resource",
      id: resource.id,
      resourceKind: resource.kind,
      revisionId: pin.revisionId,
    });
  }
  for (const pin of observation.componentPins) {
    refs.push({
      kind: "artifact",
      id: pin.componentArtifactId,
      revisionId: pin.revisionId,
    });
  }
  const byIdentity = new Map<string, ContextItemRef>();
  for (const ref of refs) byIdentity.set(stableStringify(ref), ref);
  return [...byIdentity.values()].sort((left, right) => compareBinary(stableStringify(left), stableStringify(right)));
}

function exactSharinganCaptureRefSemantic(refs: readonly ContextItemRef[]): boolean {
  const captures = refs.filter((ref) => ref.kind === "resource"
    && ref.resourceKind === "sharingan-capture");
  if (captures.length > 1) {
    throw new ContextIntegrityError("Generation Task pins multiple Sharingan Capture Revisions");
  }
  return captures.length === 1;
}

function providerIdentity(command: string): string {
  const provider = getProvider(command);
  if (provider) return provider.id;
  const executable = basename(command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").trim();
  return executable || "custom-cli";
}

function resolvedDesignSystem(
  project: Project,
  settings: Settings,
  registry: DesignRegistry,
  hasExactSharinganCapture: boolean,
): { requestedId: string | null; resolvedId: string; content: DesignSystem } | null {
  if (hasExactSharinganCapture) return null;
  const requestedId = (project.designSystemId ?? settings.defaultDesignSystemId) || null;
  const resolved = requestedId ? (registry.get(requestedId) ?? registry.default()) : registry.default();
  if (!resolved) throw new ContextIntegrityError("Artifact execution design system is unavailable");
  return {
    requestedId,
    resolvedId: resolved.id,
    content: structuredClone(resolved),
  };
}

interface FrozenSharinganCaptureTaskSemantic {
  readonly hasExactSharinganCapture: boolean;
  readonly expectedRequestedUrl: string | null;
}

/**
 * Resolves reconstruction mode from this Task's immutable observation, never
 * from the mutable Project-level Sharingan flag. Reading and decoding the
 * pinned payload here also freezes the exact requested URL used by visual QA.
 */
async function frozenSharinganCaptureTaskSemantic(input: {
  request: GenerationTaskContextRequest;
  store: Store;
  dataDir: string;
  signal: AbortSignal;
}): Promise<FrozenSharinganCaptureTaskSemantic> {
  checkAbort(input.signal);
  const pinned = input.request.observation.resourcePins.flatMap((pin) => {
    const resource = input.store.workspace.getResourceForProject(input.request.projectId, pin.resourceId);
    if (!resource || resource.workspaceId !== input.request.task.workspaceId
      || resource.kind !== "sharingan-capture") return [];
    const revision = input.store.workspace.getResourceRevisionForProject(
      input.request.projectId,
      resource.id,
      pin.revisionId,
    );
    if (!revision || revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id
      || revision.id !== pin.revisionId || !SHA256.test(revision.checksum)) {
      throw new ContextIntegrityError("Artifact execution Sharingan Capture Revision ownership is invalid");
    }
    return [{ resource, revision }];
  });
  if (pinned.length === 0) {
    return Object.freeze({ hasExactSharinganCapture: false, expectedRequestedUrl: null });
  }
  if (pinned.length !== 1) {
    throw new ContextIntegrityError("Artifact execution requires at most one exact Sharingan Capture Revision");
  }
  const exact = pinned[0]!;
  let descriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store: input.store,
      dataDir: input.dataDir,
      workspaceId: input.request.task.workspaceId,
      resourceRevisionId: exact.revision.id,
      expectedResourceId: exact.resource.id,
    });
  } catch {
    throw new ContextIntegrityError("Artifact execution Sharingan Capture Revision payload is unavailable or invalid");
  }
  if (descriptor.resourceKind !== "sharingan-capture" || descriptor.mimeType !== "application/json"
    || descriptor.resourceRevisionId !== exact.revision.id
    || descriptor.resourceId !== exact.resource.id
    || descriptor.workspaceId !== input.request.task.workspaceId
    || descriptor.manifestPath !== exact.revision.manifestPath
    || descriptor.manifestChecksum !== exact.revision.checksum
    || !SHA256.test(descriptor.payloadChecksum)) {
    throw new ContextIntegrityError("Artifact execution Sharingan Capture Revision payload identity is invalid");
  }
  const materializationRoot = await mkdtemp(join(input.dataDir, ".artifact-execution-profile-sharingan-"));
  const destination = join(materializationRoot, "capture.json");
  try {
    await verifyResourceRevisionPayload(input.dataDir, descriptor, {
      destination,
      signal: input.signal,
    });
    checkAbort(input.signal);
    const decoded = decodeSharinganCaptureResourceBundle(await readFile(destination));
    await validateSharinganCaptureResourceBundleSemantics({
      source: decoded.source,
      files: decoded.files,
      signal: input.signal,
    });
    if (decoded.scope.workspaceId !== input.request.task.workspaceId
      || decoded.scope.resourceId !== exact.resource.id
      || decoded.scope.resourceKind !== "sharingan-capture") {
      throw new ContextIntegrityError("Artifact execution Sharingan Capture bundle scope is invalid");
    }
    return Object.freeze({
      hasExactSharinganCapture: true,
      expectedRequestedUrl: decoded.source.requestedUrl,
    });
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof ContextIntegrityError) throw error;
    throw new ContextIntegrityError("Artifact execution Sharingan Capture Revision changed or is invalid");
  } finally {
    await rm(materializationRoot, { recursive: true, force: true }).catch(() => {});
  }
}

interface ImmutableResearchDirectionSelection {
  readonly protocol: "dezin.research-direction-selection.v1";
  readonly version: 1;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly directionId: string;
}

function immutableResearchDirectionSelection(
  request: GenerationTaskContextRequest,
): ImmutableResearchDirectionSelection | null {
  const payload = plainRecord(request.task.payload, "Artifact execution Task payload");
  if (payload.artifactPlan === undefined) return null;
  const plan = plainRecord(payload.artifactPlan, "Artifact execution plan");
  if (plan.researchDirectionSelection === undefined) return null;
  const selection = plainRecord(
    plan.researchDirectionSelection,
    "Artifact execution Research direction selection",
  );
  exactKeys(selection, [
    "protocol", "version", "resourceId", "revisionId", "directionId",
  ], "Artifact execution Research direction selection");
  if (selection.protocol !== "dezin.research-direction-selection.v1" || selection.version !== 1) {
    throw new ContextIntegrityError("Artifact execution Research direction selection protocol is invalid");
  }
  return {
    protocol: selection.protocol,
    version: selection.version,
    resourceId: nonEmptyString(
      selection.resourceId,
      "Artifact execution Research direction selection Resource id",
    ),
    revisionId: nonEmptyString(
      selection.revisionId,
      "Artifact execution Research direction selection Revision id",
    ),
    directionId: nonEmptyString(
      selection.directionId,
      "Artifact execution Research direction selection direction id",
    ),
  };
}

async function frozenResearchDirection(input: {
  request: GenerationTaskContextRequest;
  store: Store;
  dataDir: string;
  contextPacks: Pick<ContextPackRepository, "get">;
  signal: AbortSignal;
}): Promise<FreezeArtifactExecutionProfileInput["researchDirection"]> {
  checkAbort(input.signal);
  const selection = immutableResearchDirectionSelection(input.request);
  if (selection === null) {
    const unselectedResearchRefs = input.request.observation.resourcePins.flatMap((pin) => {
      const resource = input.store.workspace.getResourceForProject(input.request.projectId, pin.resourceId);
      return resource?.workspaceId === input.request.task.workspaceId && resource.kind === "research"
        ? [`research:${pin.resourceId}@${pin.revisionId}:direction-selection`]
        : [];
    }).sort(compareBinary);
    if (unselectedResearchRefs.length === 0) return null;
    throw new BlockedContextError(
      unselectedResearchRefs,
      "Artifact generation is blocked because an explicit immutable Research direction selection is required; the selection must be captured in the approved immutable Plan before this Artifact can run",
    );
  }
  const pinned = input.request.observation.resourcePins.flatMap((pin) => {
    if (pin.resourceId !== selection.resourceId || pin.revisionId !== selection.revisionId) return [];
    const resource = input.store.workspace.getResourceForProject(input.request.projectId, pin.resourceId);
    if (!resource || resource.workspaceId !== input.request.task.workspaceId || resource.kind !== "research") return [];
    const revision = input.store.workspace.getResourceRevisionForProject(
      input.request.projectId,
      resource.id,
      pin.revisionId,
    );
    if (!revision || revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id
      || revision.id !== pin.revisionId || !SHA256.test(revision.checksum)) {
      throw new ContextIntegrityError("Artifact execution Research Revision ownership is invalid");
    }
    return [{ resource, revision }];
  });
  if (pinned.length !== 1) {
    throw new ContextIntegrityError("Chosen Artifact Research direction selection is not pinned by this exact Attempt");
  }
  const exact = pinned[0]!;
  let descriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store: input.store,
      dataDir: input.dataDir,
      workspaceId: input.request.task.workspaceId,
      resourceRevisionId: exact.revision.id,
      expectedResourceId: exact.resource.id,
    });
  } catch {
    throw new ContextIntegrityError("Artifact execution Research Revision payload is unavailable or invalid");
  }
  if (descriptor.resourceKind !== "research" || descriptor.mimeType !== "application/json"
    || descriptor.manifestPath !== exact.revision.manifestPath
    || descriptor.manifestChecksum !== exact.revision.checksum
    || !SHA256.test(descriptor.payloadChecksum)) {
    throw new ContextIntegrityError("Artifact execution Research Revision payload identity is invalid");
  }
  const materializationRoot = await mkdtemp(join(input.dataDir, ".artifact-execution-profile-"));
  const destination = join(materializationRoot, "research.json");
  let content: string;
  try {
    await verifyResourceRevisionPayload(input.dataDir, descriptor, {
      destination,
      signal: input.signal,
    });
    checkAbort(input.signal);
    const contextPackId = researchRevisionContextPackId(exact.revision.provenance);
    const contextPack = contextPackId === null
      ? null
      : input.contextPacks.get(input.request.task.workspaceId, contextPackId);
    const direction = selectResearchRevisionDirection({
      bytes: await readFile(destination),
      directionId: selection.directionId,
      workspaceId: input.request.task.workspaceId,
      resourceId: exact.resource.id,
      parentRevisionId: exact.revision.parentRevisionId,
      revisionMetadata: exact.revision.metadata,
      revisionProvenance: exact.revision.provenance,
      contextPack,
    });
    content = stableStringify(direction);
  } catch (error) {
    if (input.signal.aborted) throw abortReason(input.signal);
    if (error instanceof ContextIntegrityError) throw error;
    if (error instanceof ResearchResourceRevisionError) {
      throw new ContextIntegrityError(`Artifact execution Research Revision is invalid: ${error.message}`);
    }
    throw new ContextIntegrityError("Artifact execution Research Revision payload changed or is invalid");
  } finally {
    await rm(materializationRoot, { recursive: true, force: true }).catch(() => {});
  }
  checkAbort(input.signal);
  if (!isDeepStrictEqual(immutableResearchDirectionSelection(input.request), selection)) {
    throw new ContextIntegrityError("Artifact execution Research direction selection changed during materialization");
  }
  return {
    directionId: selection.directionId,
    content,
    resourceId: exact.resource.id,
    revisionId: exact.revision.id,
    revisionChecksum: exact.revision.checksum,
    payloadChecksum: descriptor.payloadChecksum,
  };
}

/** Production loader that observes mutable Resource Agent settings exactly once. */
export function createProductionResourceExecutionProfileLoader(
  options: ProductionResourceExecutionProfileLoaderOptions,
): ResourceExecutionProfileLoader {
  return (request, signal) => {
    checkAbort(signal);
    if (request.task.kind !== "resource" || request.task.target.type !== "resource") {
      throw new ContextIntegrityError("Resource execution profile requires one Resource Task");
    }
    const project = options.store.getProject(request.projectId);
    const workspace = options.store.workspace.getWorkspace(request.projectId);
    const resource = options.store.workspace.getResourceForProject(
      request.projectId,
      request.task.target.id,
    );
    if (!project || project.archivedAt !== null || !workspace
      || workspace.id !== request.task.workspaceId || workspace.projectId !== project.id
      || !resource || resource.id !== request.task.target.id
      || resource.workspaceId !== workspace.id || resource.archivedAt !== null) {
      throw new ContextIntegrityError("Resource execution Project/Workspace/Resource ownership is invalid");
    }
    const payload = plainRecord(request.task.payload, "Resource execution Task payload");
    const frozenTaskAgent = taskAgentSelection(payload, "Resource execution Task Agent selection");
    const operation = plainRecord(payload.operation, "Resource execution Task operation");
    const adapterRecord = plainRecord(payload.adapter, "Resource execution Task adapter");
    exactKeys(adapterRecord, ["id", "version", "kind"], "Resource execution Task adapter");
    if (payload.version !== 2 || operation.resourceId !== resource.id || operation.kind !== resource.kind
      || adapterRecord.id !== `dezin.resource-adapter.${resource.kind}`
      || adapterRecord.version !== 1 || adapterRecord.kind !== resource.kind) {
      throw new ContextIntegrityError("Resource execution Task adapter or target identity is invalid");
    }
    const settingsSnapshot = options.store.getSettings();
    const executionSettingsSnapshot = settingsForFrozenTaskAgent(settingsSnapshot, frozenTaskAgent);
    checkAbort(signal);
    return freezeResourceExecutionProfile({
      ownership: {
        projectId: project.id,
        workspaceId: workspace.id,
        planId: request.planId,
        taskId: request.task.id,
        targetResourceId: resource.id,
      },
      resourceKind: resource.kind,
      adapter: {
        id: adapterRecord.id as string,
        version: 1,
        kind: resource.kind,
      },
      settings: executionSettingsSnapshot,
    });
  };
}

/** Production loader that snapshots mutable Project/runtime semantics once. */
export function createProductionArtifactExecutionProfileLoader(
  options: ProductionArtifactExecutionProfileLoaderOptions,
): ArtifactExecutionProfileLoader {
  const contextPacks = options.contextPacks ?? createWorkspaceContextPackRepository(
    options.store.workspace,
    { manifestRoot: options.dataDir },
  );
  return async (request, signal) => {
    checkAbort(signal);
    if (request.task.target.type !== "artifact"
      || (request.task.kind !== "page" && request.task.kind !== "component")) {
      throw new ContextIntegrityError("Artifact execution profile requires one Page or Component Task");
    }
    const project = options.store.getProject(request.projectId);
    const workspace = options.store.workspace.getWorkspace(request.projectId);
    if (!project || project.archivedAt !== null || !workspace
      || workspace.id !== request.task.workspaceId || workspace.projectId !== project.id) {
      throw new ContextIntegrityError("Artifact execution Project ownership is invalid");
    }
    const projectSnapshot = structuredClone(project);
    const payload = plainRecord(request.task.payload, "Artifact execution Task payload");
    const frozenTaskAgent = taskAgentSelection(payload, "Artifact execution Task Agent selection");
    const settingsSnapshot = options.store.getSettings();
    const command = frozenTaskAgent?.command ?? (settingsSnapshot.agentCommand || "claude");
    const model = frozenTaskAgent === null ? settingsSnapshot.model || null : frozenTaskAgent.model;
    const providerId = frozenTaskAgent?.providerId ?? providerIdentity(command);
    const executionSettingsSnapshot = settingsForFrozenTaskAgent(settingsSnapshot, frozenTaskAgent);
    const ignoresSnapshot = options.store.listQualityIgnores(project.id)
      .map((entry) => ({ ruleId: entry.ruleId, selector: entry.selector }))
      .sort((left, right) => compareBinary(
        `${left.ruleId}\0${left.selector ?? ""}`,
        `${right.ruleId}\0${right.selector ?? ""}`,
      ));
    const sharinganTaskSemantic = await frozenSharinganCaptureTaskSemantic({
      request,
      store: options.store,
      dataDir: options.dataDir,
      signal,
    });
    const { hasExactSharinganCapture } = sharinganTaskSemantic;
    const designSnapshot = resolvedDesignSystem(
      projectSnapshot,
      settingsSnapshot,
      options.designRegistry,
      hasExactSharinganCapture,
    );
    const direction = await frozenResearchDirection({
      request,
      store: options.store,
      dataDir: options.dataDir,
      contextPacks,
      signal,
    });

    // Any durable or registry drift across asynchronous filesystem reads blocks
    // this materialization instead of producing a mixed execution profile.
    const projectAfter = options.store.getProject(request.projectId);
    const settingsAfter = options.store.getSettings();
    const ignoresAfter = options.store.listQualityIgnores(project.id)
      .map((entry) => ({ ruleId: entry.ruleId, selector: entry.selector }))
      .sort((left, right) => compareBinary(
        `${left.ruleId}\0${left.selector ?? ""}`,
        `${right.ruleId}\0${right.selector ?? ""}`,
      ));
    const designAfter = projectAfter
      ? resolvedDesignSystem(
          projectAfter,
          settingsAfter,
          options.designRegistry,
          hasExactSharinganCapture,
        )
      : null;
    if (!isDeepStrictEqual(projectAfter, projectSnapshot)
      || !isDeepStrictEqual(settingsAfter, settingsSnapshot)
      || !isDeepStrictEqual(ignoresAfter, ignoresSnapshot)
      || !isDeepStrictEqual(designAfter, designSnapshot)) {
      throw new ContextIntegrityError("Artifact execution semantics changed during materialization");
    }

    const briefRecord = payload.brief && typeof payload.brief === "object" && !Array.isArray(payload.brief)
      ? payload.brief as Record<string, unknown>
      : undefined;
    const brief = typeof briefRecord?.proposalRationale === "string"
      ? briefRecord.proposalRationale
      : projectSnapshot.name;
    const imageGenerationEnabled = artifactImageGenerationEnabled(executionSettingsSnapshot);
    const promptRegistry = designSnapshot === null
      ? options.designRegistry
      : new DesignRegistry([designSnapshot.content]);
    const promptResult = buildProjectAgentPrompt({
      project: projectSnapshot,
      settings: sanitizedSettings(executionSettingsSnapshot),
      brief,
      designRegistry: promptRegistry,
      imageGenerationEnabled,
      hasExactSharinganCapture,
    });
    const frozenSkill = hasExactSharinganCapture || promptResult.skill === null ? null : {
      id: promptResult.skill.id,
      content: structuredClone(promptResult.skill),
    };
    const skillSupplement = hasExactSharinganCapture ? "" : [
      "For this immutable Generation Task, the earlier Available skills filesystem paths are disabled. Do not read any SKILL.md from disk or substitute skill content that is not embedded below.",
      frozenSkill === null
        ? "No skill revision is selected for this Task; use only the already-frozen design, craft, and prompt rules."
        : [
            "Use the frozen selected skill revision below as the sole authoritative skill revision for this Task.",
            stableStringify({
              protocol: "dezin.frozen-selected-skill.v1",
              id: frozenSkill.id,
              revision: checksumBytes(stableStringify(frozenSkill.content)),
              content: frozenSkill.content,
            }),
          ].join("\n\n"),
    ].join("\n\n");
    const sharinganSidecarContract = hasExactSharinganCapture ? [
      "The exact immutable Sharingan capture roots are `.sharingan` and `public/_assets`. Both are read-only reference sidecars excluded from candidate fingerprinting, commits, and restore operations.",
      "Use only offline probe reads. Consume the bounded measured JSON from `node .sharingan/probe.mjs source-scaffold --stdout`; it must perform no writes. Never use live navigate, capture, click, scroll, read-dom, styles, or links commands for this immutable Revision.",
      "If the final implementation reuses a captured source asset, copy its bytes into a candidate-owned path in the project and reference that owned copy. Never mutate, delete, rename, or generate files inside either pinned capture root.",
    ].join("\n\n") : "";
    const reviewerCommand = reviewerAgentCommand(executionSettingsSnapshot, command);
    const reviewerModelId = reviewerModel(executionSettingsSnapshot, model ?? undefined, command) ?? null;
    return freezeArtifactExecutionProfile({
      ownership: {
        projectId: projectSnapshot.id,
        workspaceId: request.task.workspaceId,
        planId: request.planId,
        taskId: request.task.id,
        targetArtifactId: request.task.target.id,
      },
      hasExactSharinganCapture,
      project: {
        id: projectSnapshot.id,
        name: projectSnapshot.name,
        skillId: projectSnapshot.skillId,
        designSystemId: projectSnapshot.designSystemId,
        mode: projectSnapshot.mode,
        sharingan: projectSnapshot.sharingan,
        sourceUrl: projectSnapshot.sourceUrl ?? null,
      },
      settings: executionSettingsSnapshot,
      agent: { command, providerId, model },
      designSystem: designSnapshot,
      skill: frozenSkill,
      researchDirection: direction,
      prompt: {
        rendererProtocol: "dezin.project-agent-prompt.v1",
        rendererVersion: 1,
        systemPrompt: [promptResult.systemPrompt, skillSupplement, sharinganSidecarContract]
          .filter(Boolean)
          .join("\n\n"),
      },
      quality: {
        visualQaEnabled: executionSettingsSnapshot.visualQaEnabled
          || request.task.qaProfile.requireVisualReview
          || hasExactSharinganCapture,
        reviewer: {
          command: reviewerCommand,
          providerId: providerIdentity(reviewerCommand),
          model: reviewerModelId,
        },
        expectedSharinganRequestedUrl: sharinganTaskSemantic.expectedRequestedUrl,
        ignores: ignoresSnapshot,
      },
      imageGenerationEnabled,
    });
  };
}

/** Materializes one immutable Context Pack for one observed Generation Task. */
export class ProductionGenerationTaskContextResolver implements GenerationTaskContextResolver {
  readonly #options: ProductionGenerationTaskContextResolverOptions;

  constructor(options: ProductionGenerationTaskContextResolverOptions) {
    this.#options = options;
  }

  async resolve(input: GenerationTaskContextRequest, signal: AbortSignal): Promise<ContextPack> {
    checkAbort(signal);
    exactRequest(input);
    const frozen = exactSnapshot(this.#options.workspace, input);
    const dispatchPack = exactDispatchContextPack({
      request: input,
      repository: this.#options.dispatchContextPacks,
      currentSnapshot: frozen.snapshot,
      currentGraphRevision: frozen.graph.revision,
    });
    const refs = explicitRefs(this.#options.workspace, input);
    const hasExactSharinganCapture = input.task.target.type === "artifact"
      ? exactSharinganCaptureRefSemantic(refs)
      : false;
    let artifactExecutionProfile: FrozenArtifactExecutionProfile | null = null;
    let resourceExecutionProfile: FrozenResourceExecutionProfile | null = null;
    if (input.task.target.type === "artifact") {
      if (this.#options.loadArtifactExecutionProfile === undefined) {
        throw new ContextIntegrityError("Artifact execution profile loader is unavailable");
      }
      artifactExecutionProfile = validateArtifactExecutionProfile(
        await this.#options.loadArtifactExecutionProfile(input, signal),
        {
          projectId: input.projectId,
          workspaceId: input.task.workspaceId,
          planId: input.planId,
          taskId: input.task.id,
          targetArtifactId: input.task.target.id,
        },
      );
      if (artifactExecutionProfile.hasExactSharinganCapture !== hasExactSharinganCapture) {
        throw new ContextIntegrityError(
          "Artifact execution Sharingan semantic does not match the frozen Task observation",
        );
      }
      checkAbort(signal);
    }
    if (input.task.target.type === "resource") {
      if (this.#options.loadResourceExecutionProfile === undefined) {
        throw new ContextIntegrityError("Resource execution profile loader is unavailable");
      }
      const resourcePayload = input.task.payload as {
        operation?: { kind?: Resource["kind"] };
        adapter?: FrozenResourceExecutionProfile["adapter"];
      };
      resourceExecutionProfile = validateResourceExecutionProfile(
        await this.#options.loadResourceExecutionProfile(input, signal),
        {
          projectId: input.projectId,
          workspaceId: input.task.workspaceId,
          planId: input.planId,
          taskId: input.task.id,
          targetResourceId: input.task.target.id,
          resourceKind: resourcePayload.operation?.kind as Resource["kind"],
          adapter: resourcePayload.adapter as FrozenResourceExecutionProfile["adapter"],
        },
      );
      checkAbort(signal);
    }
    const taskAgent = taskAgentSelection(
      input.task.payload as Record<string, unknown>,
      "Generation Task payload Agent",
    );
    const profileAgent = artifactExecutionProfile?.agent ?? resourceExecutionProfile?.agent;
    const contextAgent: WorkspaceGenerationAgentSelection = taskAgent
      ?? (profileAgent?.command === "codebuddy" && profileAgent.providerId === "codebuddy"
        ? {
            providerId: "codebuddy",
            command: "codebuddy",
            model: profileAgent.model,
          }
        : profileAgent?.command === "claude" && profileAgent.providerId === "claude"
          ? {
              providerId: "claude",
              command: "claude",
              model: profileAgent.model,
            }
          : {
              // Historical Tasks may predate the durable Agent field. Their exact
              // payload remains in the message hash; this canonical selection is
              // only the internal Context request boundary for those records.
              providerId: "claude",
              command: "claude",
              model: null,
            });
    const source = new FrozenTaskContextSource({
      workspace: this.#options.workspace,
      loadResourceSnapshot: this.#options.loadResourceSnapshot,
      request: input,
      ...frozen,
      artifactExecutionProfile,
      resourceExecutionProfile,
      signal,
    });
    const resolver = new ContextResolver({
      packStore: this.#options.packStore,
      adapters: this.#options.adapters ?? resourceAdapters,
      resourceStorageRoot: this.#options.resourceStorageRoot,
      source,
    });
    const pack = await resolver.resolve({
      scope: {
        type: input.task.target.type,
        workspaceId: input.task.workspaceId,
        id: input.task.target.id,
      },
      intent: "generate",
      agent: contextAgent,
      message: stableStringify({
        protocol: "dezin.generation-context-request.v1",
        projectId: input.projectId,
        planId: input.planId,
        taskId: input.task.id,
        target: input.task.target,
        payload: input.task.payload,
        expectedSnapshotId: input.observation.expectedSnapshotId,
        kernelRevisionId: input.observation.kernelRevisionId,
        resourcePins: input.observation.resourcePins,
        componentPins: input.observation.componentPins,
      }),
      explicitContext: refs,
      graphRevision: frozen.graph.revision,
      baseRevisionId: input.observation.baseRevisionId ?? undefined,
    });
    checkAbort(signal);
    return mergeDispatchEvidence(pack, dispatchPack, this.#options.packStore);
  }
}

/** Production composition for Store.workspace + immutable payload storage. */
export function createProductionGenerationTaskContextResolver(
  options: ProductionGenerationTaskContextFactoryOptions,
): ProductionGenerationTaskContextResolver {
  const manifestRoot = options.manifestRoot ?? options.dataDir;
  const repository = createWorkspaceContextPackRepository(options.store.workspace, { manifestRoot });
  const packStore = new ContextPackStore({ manifestRoot, repository });
  return new ProductionGenerationTaskContextResolver({
    workspace: options.store.workspace,
    packStore,
    dispatchContextPacks: repository,
    resourceStorageRoot: options.dataDir,
    loadArtifactExecutionProfile: createProductionArtifactExecutionProfileLoader({
      store: options.store,
      dataDir: options.dataDir,
      designRegistry: options.designRegistry,
      contextPacks: repository,
      repositoryDirForWorkspace: options.repositoryDirForWorkspace,
    }),
    loadResourceExecutionProfile: createProductionResourceExecutionProfileLoader({
      store: options.store,
    }),
    async loadResourceSnapshot({ workspaceId, resource, revision }, signal) {
      checkAbort(signal);
      const descriptor = resolveResourceRevisionPayloadDescriptor({
        store: options.store,
        dataDir: options.dataDir,
        workspaceId,
        resourceRevisionId: revision.id,
        expectedResourceId: resource.id,
      });
      checkAbort(signal);
      if (descriptor.resourceKind !== resource.kind
        || descriptor.manifestPath !== revision.manifestPath
        || descriptor.manifestChecksum !== revision.checksum) {
        throw new ContextIntegrityError("Resource Revision payload descriptor changed from its durable identity");
      }
      return cloneAndFreeze({
        id: revision.id,
        workspaceId,
        resourceId: resource.id,
        kind: resource.kind,
        checksum: descriptor.manifestChecksum,
        payloadChecksum: descriptor.payloadChecksum,
        byteSize: descriptor.byteLength,
        mimeType: descriptor.mimeType,
        manifestPath: descriptor.manifestPath,
        snapshotPath: descriptor.payloadPath,
        storageState: "existing",
        content: stableStringify({
          summary: revision.summary,
          manifestPath: descriptor.manifestPath,
          mimeType: descriptor.mimeType,
          byteLength: descriptor.byteLength,
          payloadChecksum: descriptor.payloadChecksum,
        }),
        provenance: {
          ...structuredClone(revision.provenance),
          protocol: descriptor.protocol,
          manifestPath: descriptor.manifestPath,
          payloadChecksum: descriptor.payloadChecksum,
        },
        createdAt: revision.createdAt,
      } satisfies ResourceRevisionSnapshot);
    },
  });
}
