/** @dezin/core — shared app domains plus the isolated Sharingan store. */

export {
  SHARINGAN_BOOTSTRAP_STATE_PROTOCOL,
  SharinganBootstrapStateError,
  normalizeSharinganBootstrapState,
} from "./sharingan-bootstrap.ts";
export type { SharinganBootstrapState } from "./sharingan-bootstrap.ts";

export type {
  CreateEffectInput,
  CreateMoodboardInput,
  CreateProjectInput,
  Effect,
  EffectOrigin,
  EffectParamDefinition,
  EffectParamKind,
  EffectParamOption,
  EffectParamValue,
  EffectPreset,
  ExtensionCredential,
  ExtensionCredentialRecord,
  ExtensionScope,
  MessageRole,
  Moodboard,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardMessage,
  MoodboardNode,
  MoodboardNodeType,
  Project,
  SaveMoodboardNodeInput,
  Settings,
  UpdateEffectInput,
} from "./types.ts";

export type {
  CreateSharinganResourceInput,
  CreateSharinganResourceResult,
  CreateSharinganResourceRevisionCandidateInput,
  Resource,
  ResourceRevision,
  SharinganResource,
  SharinganResourceKind,
  SharinganResourcePinPolicy,
  SharinganResourcePublicationExpectation,
  SharinganResourceRevision,
  SharinganResourceRevisionViewFacts,
  SharinganWorkspace,
  SharinganWorkspaceGraph,
  SharinganWorkspaceResourceNode,
  SharinganWorkspaceSnapshot,
  SharinganWorkspaceSnapshotProvenance,
} from "./sharingan-workspace-types.ts";

export {
  SharinganWorkspaceStore,
  WorkspaceGraphValidationError,
  WorkspacePointerConflictError,
  WorkspaceResourceNotFoundError,
  WorkspaceResourceOwnershipError,
  WorkspaceRevisionConflictError,
} from "./sharingan-workspace-store.ts";

export { Store, type StoreClock, type StoreOptions } from "./store.ts";
export {
  SecretCipherError,
  createSecretCipher,
  isEncryptedSecret,
  secretCipherFromEnv,
  type SecretCipher,
} from "./secret-cipher.ts";
