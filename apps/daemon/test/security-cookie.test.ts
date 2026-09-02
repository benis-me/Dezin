import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { DAEMON_TOKEN_COOKIE, isTrustedHost, requireDaemonRequest } from "../src/security.ts";
import { daemonTokenCookie } from "../src/serve-web.ts";
import { HttpError } from "../src/http-util.ts";

const TOKEN = "tok_secret";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function status(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
}

test("a request without a Host header is not trusted", () => {
  assert.equal(isTrustedHost(undefined), false);
  assert.equal(isTrustedHost(""), false);
  assert.equal(isTrustedHost("127.0.0.1:7457"), true);
  assert.equal(status(() => requireDaemonRequest(request({}), { token: TOKEN })), 403);
});

test("the HttpOnly cookie authenticates same-origin fetches from the served Web app", () => {
  const cookie = daemonTokenCookie(TOKEN);
  assert.match(cookie, /^dezin_daemon_token=tok_secret; Path=\/; HttpOnly; SameSite=Strict$/);
  const principal = requireDaemonRequest(
    request({ host: "127.0.0.1:7457", cookie: `${DAEMON_TOKEN_COOKIE}=${TOKEN}`, "sec-fetch-site": "same-origin" }),
    { token: TOKEN },
  );
  assert.deepEqual(principal, { kind: "daemon" });
  // Top-level navigations (no Sec-Fetch-Site: cross-site) also count.
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "127.0.0.1:7457", cookie: `${DAEMON_TOKEN_COOKIE}=${TOKEN}`, "sec-fetch-site": "none" }),
    { token: TOKEN },
  )), null);
});

test("the cookie is ignored for same-site but cross-origin requests", () => {
  // Another local dev server (localhost:5173) is the same *site*, so SameSite
  // alone would let it ride the cookie; the daemon requires same-origin.
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "127.0.0.1:7457", cookie: `${DAEMON_TOKEN_COOKIE}=${TOKEN}`, "sec-fetch-site": "same-site", origin: "http://localhost:5173" }),
    { token: TOKEN },
  )), 401);
  // Cross-site: the cookie is ignored, so the request has no credential at all (401).
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "127.0.0.1:7457", cookie: `${DAEMON_TOKEN_COOKIE}=${TOKEN}`, "sec-fetch-site": "cross-site", origin: "https://evil.example" }),
    { token: TOKEN },
  )), 401);
  // Without Sec-Fetch-Site, the Origin must match the Host exactly.
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "127.0.0.1:7457", cookie: `${DAEMON_TOKEN_COOKIE}=${TOKEN}`, origin: "http://localhost:5173" }),
    { token: TOKEN },
  )), 401);
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "127.0.0.1:7457", cookie: `${DAEMON_TOKEN_COOKIE}=${TOKEN}`, origin: "http://127.0.0.1:7457" }),
    { token: TOKEN },
  )), null);
});

test("explicit header tokens keep working and a wrong cookie fails closed", () => {
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "localhost:7457", "x-dezin-daemon-token": TOKEN }),
    { token: TOKEN },
  )), null);
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "localhost:7457", cookie: `${DAEMON_TOKEN_COOKIE}=nope`, "sec-fetch-site": "same-origin" }),
    { token: TOKEN },
  )), 401);
  assert.equal(status(() => requireDaemonRequest(
    request({ host: "localhost:7457", cookie: `other=1; ${DAEMON_TOKEN_COOKIE}=${encodeURIComponent(TOKEN)}; more=2`, "sec-fetch-site": "same-origin" }),
    { token: TOKEN },
  )), null);
});
