/**
 * Node honours `NODE_USE_ENV_PROXY=1` for the global `fetch`: every request,
 * including one to 127.0.0.1, is sent through the proxy named in `HTTP(S)_PROXY`
 * unless `NO_PROXY` excludes the host. Developers behind a system proxy (Surge,
 * Clash, ...) rarely list loopback there. For the daemon that means its own
 * loopback calls take a detour through the proxy; for the test suite it means
 * the proxy's keep-alive socket keeps every test process alive after the last
 * test, which is how a 10-minute suite "timeout" is born. Loopback never needs a
 * proxy, so add it to NO_PROXY once at startup. undici re-reads NO_PROXY per
 * request, so this takes effect even after the agent was created at bootstrap.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

export function ensureLoopbackBypassesEnvProxy(env: NodeJS.ProcessEnv = process.env): string {
  const current = new Set(
    [env.NO_PROXY, env.no_proxy]
      .flatMap((value) => (value ?? "").split(","))
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const host of LOOPBACK_HOSTS) current.add(host);
  const merged = [...current].join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;
  return merged;
}
