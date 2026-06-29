/**
 * @dezin/daemon — the local HTTP server.
 */

export { createApp, type AppDeps } from "./app.ts";
export { matchPath, contentTypeFor } from "./http-util.ts";
export { projectDir, safeJoin } from "./serve-static.ts";
