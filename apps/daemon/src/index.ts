/**
 * @dezin/daemon — the local HTTP server.
 */

export { createApp, createRuntimeSupervisor, type AppDeps } from "./app.ts";
export { RuntimeSupervisor, RuntimeScopeUnavailableError, type RuntimeScope, type RegisteredRun } from "./runtime-supervisor.ts";
export { matchPath, contentTypeFor } from "./http-util.ts";
export { projectDir, safeJoin } from "./serve-static.ts";
export {
  ensureStandardProjectWorkspace,
  type EnsureStandardProjectWorkspaceResult,
  type WorkspaceMigrationDeps,
  type WorkspaceMigrationOptions,
} from "./workspace-migration.ts";
export {
  StoreExtensionPairingService,
  type ExtensionPairingService,
  type RequestPrincipal,
} from "./extension-auth.ts";
export {
  acquirePreviewTargetLease,
  parsePreviewTarget,
  parseResolvedPreviewTarget,
  resolvePreviewTarget,
  revalidateResolvedPreviewTarget,
  PreviewTargetConflictError,
  PreviewTargetNotFoundError,
  PreviewTargetValidationError,
  type PreviewTarget,
  type PreviewTargetLease,
  type ResolvedPreviewTarget,
} from "./preview-target.ts";
export {
  buildRenderAssembly,
  materializeRenderAssembly,
  stablePreviewHash,
  RenderAssemblyError,
  type RenderAssembly,
  type RenderAssemblyTarget,
  type BuildRenderAssemblyOptions,
} from "./render-assembly.ts";
export {
  MAX_RENDER_ASSEMBLY_RESOURCE_BYTES,
  MAX_RENDER_ASSEMBLY_RESOURCES,
  MAX_RESOURCE_MANIFEST_BYTES,
  MAX_RESOURCE_PAYLOAD_BYTES,
  RESOURCE_REVISION_PAYLOAD_PROTOCOL,
  ResourceRevisionPayloadError,
  resourceRevisionManifestRelativePath,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
  type ResourceRevisionPayloadManifest,
} from "./resource-revision-payload.ts";
