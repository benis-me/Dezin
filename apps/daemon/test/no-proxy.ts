// Preloaded by the daemon test scripts (`--import`). Runs in the `node --test`
// parent before it spawns per-file processes, so every test process inherits a
// NO_PROXY that excludes loopback. See src/loopback-no-proxy.ts for why.
import { ensureLoopbackBypassesEnvProxy } from "../src/loopback-no-proxy.ts";

ensureLoopbackBypassesEnvProxy();
