/**
 * @dezin/daemon — the local HTTP server.
 */

export { createApp, createRuntimeSupervisor, type AppDeps } from "./app.ts";
export { RuntimeSupervisor, RuntimeScopeUnavailableError, type RuntimeScope, type RegisteredRun } from "./runtime-supervisor.ts";
export { matchPath, contentTypeFor } from "./http-util.ts";
export { projectDir, safeJoin } from "./serve-static.ts";
export {
  StoreExtensionPairingService,
  type ExtensionPairingService,
  type RequestPrincipal,
} from "./extension-auth.ts";
