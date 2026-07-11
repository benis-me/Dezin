import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { abortError, type AgentRunner } from "../../../packages/agent/src/index.ts";
import { createApp, createRuntimeSupervisor, matchPath, safeJoin } from "../src/index.ts";
import type { AppDeps } from "../src/index.ts";
import { buildMoodboardAgentContext, buildMoodboardAgentPrompt, parseMoodboardAgentOutput } from "../src/moodboard-agent.ts";
import { injectSelectBridge } from "../src/serve-static.ts";
import * as extensionAuth from "../src/extension-auth.ts";
import { ensureProbeSession, sharinganCaptureRegistrySizeForTests } from "../src/sharingan-handler.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
}

type BudgetedMoodboardAgentContext = {
  board: { name: string };
  latestUserRequest: string;
  summary: { nodeCount: number; messageCount: number };
  relevantNodes: Array<{ id?: string }>;
  nodeIndex: unknown[];
  recentMessages: unknown[];
  omitted: { relevantNodes: number; messages: number };
  nodes?: unknown;
  messages?: unknown;
};

async function withServer(fn: (ctx: Ctx) => Promise<void>, extraDeps: Partial<AppDeps> = {}): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-test-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = extraDeps.runtimeSupervisor ?? createRuntimeSupervisor({ dataDir, store });
  const server = createApp({ ...extraDeps, store, dataDir, version: extraDeps.version ?? "9.9.9", runtimeSupervisor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

async function rawRequest(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  const url = new URL(path, base);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const DAEMON_TOKEN = "test-daemon-token";
const EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function createPairCode(base: string): Promise<{ code: string; expiresAt: number }> {
  const response = await fetch(`${base}/api/extension/pairing-code`, {
    method: "POST",
    headers: { "x-dezin-daemon-token": DAEMON_TOKEN },
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { code: string; expiresAt: number };
}

async function exchangePairCode(base: string, code: string, origin = EXTENSION_ORIGIN): Promise<Response> {
  return fetch(`${base}/api/extension/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code }),
  });
}

test("GET /api/health", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, version: "9.9.9" });
  });
});

test("daemon rejects non-local Host headers", async () => {
  await withServer(async ({ base }) => {
    const res = await rawRequest(base, "/api/health", { headers: { host: "evil.test" } });
    assert.equal(res.status, 403);
  });
});

test("daemon rejects non-local Origin headers on API requests", async () => {
  await withServer(async ({ base }) => {
    const res = await rawRequest(base, "/api/projects", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Drive by" }),
    });
    assert.equal(res.status, 403);
  });
});

test("daemon enforces token when configured", async () => {
  await withServer(
    async ({ base }) => {
      const missing = await fetch(`${base}/api/health`);
      assert.equal(missing.status, 401);

      const accepted = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer test-token" } });
      assert.equal(accepted.status, 200);
    },
    { security: { token: "test-token" } } as Partial<AppDeps>,
  );
});

test("extension credentials are authorized only for their scoped POST route", async () => {
  const cases = [
    ["capture:write", "POST", "/api/capture", 200],
    ["capture:write", "POST", "/api/analyze-image", 403],
    ["image:analyze", "POST", "/api/analyze-image", 200],
    ["image:analyze", "POST", "/api/capture", 403],
    ["capture:write", "GET", "/api/settings", 403],
  ] as const;

  await withServer(
    async ({ base, store }) => {
      for (const [scope, method, path, expected] of cases) {
        const token = `dezin_ext_${scope}_${method}_${path}`;
        store.createExtensionCredential({
          tokenHash: createHash("sha256").update(token).digest("hex"),
          extensionId: EXTENSION_ID,
          scopes: [scope],
        });
        const body = path === "/api/capture"
          ? JSON.stringify({ images: [{ name: "shot.png", base64: "YWJjZA==" }], source: "extension" })
          : path === "/api/analyze-image"
            ? JSON.stringify({ image: "YWJjZA==" })
            : undefined;
        const response = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            origin: EXTENSION_ORIGIN,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body,
        });
        assert.equal(response.status, expected, `${scope} ${method} ${path}`);
      }
    },
    {
      security: { token: DAEMON_TOKEN },
      imageAnalyzer: async () => "A concise recreation brief.",
    } as Partial<AppDeps>,
  );
});

test("extension pair codes expire and are consumed before concurrent exchanges complete", async () => {
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    await withServer(
      async ({ base }) => {
        const singleUse = await createPairCode(base);
        const raced = await Promise.all([
          exchangePairCode(base, singleUse.code),
          exchangePairCode(base, singleUse.code),
        ]);
        assert.deepEqual(raced.map((response) => response.status).sort((a, b) => a - b), [200, 400]);

        const expiring = await createPairCode(base);
        assert.equal(expiring.expiresAt, now + 5 * 60_000);
        now = expiring.expiresAt;
        const expired = await exchangePairCode(base, expiring.code);
        assert.equal(expired.status, 400);
      },
      { security: { token: DAEMON_TOKEN } } as Partial<AppDeps>,
    );
  } finally {
    Date.now = realNow;
  }
});

test("extension pairing throttles concurrent guesses globally across chrome-extension origins", async () => {
  const globalLimit = extensionAuth.EXTENSION_PAIR_ATTEMPTS_GLOBAL ?? 32;
  await withServer(async ({ base }) => {
    const responses = await Promise.all(
      Array.from({ length: globalLimit + 4 }, (_, index) => {
        const originId = String.fromCharCode(97 + (index % 16)).repeat(32);
        return exchangePairCode(base, "000000", `chrome-extension://${originId}`);
      }),
    );
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 400).length, globalLimit);
    assert.equal(statuses.filter((status) => status === 429).length, 4);
    const invalidMessages = await Promise.all(
      responses
        .filter((response) => response.status === 400)
        .map(async (response) => ((await response.json()) as { error: string }).error),
    );
    assert.deepEqual(new Set(invalidMessages), new Set(["invalid or expired pairing code"]));
  });
});

test("extension pairing binds origin, lists redacted credentials, and revokes access", async () => {
  await withServer(
    async ({ base }) => {
      const pairCode = await createPairCode(base);
      const paired = await exchangePairCode(base, pairCode.code);
      assert.equal(paired.status, 200);
      const payload = (await paired.json()) as {
        token: string;
        credential: { id: string; extensionId: string; scopes: string[]; tokenHash?: string };
      };
      assert.equal(payload.credential.extensionId, EXTENSION_ID);
      assert.deepEqual(payload.credential.scopes, ["capture:write", "image:analyze"]);
      assert.equal(payload.credential.tokenHash, undefined);

      const wrongOrigin = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${payload.token}`,
          origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "content-type": "application/json",
        },
        body: JSON.stringify({ images: [{ name: "shot.png", base64: "YWJjZA==" }] }),
      });
      assert.equal(wrongOrigin.status, 403);

      const listed = await fetch(`${base}/api/extension/credentials`, {
        headers: { "x-dezin-daemon-token": DAEMON_TOKEN },
      });
      assert.equal(listed.status, 200);
      const credentials = (await listed.json()) as Array<{ id: string; tokenHash?: string }>;
      assert.equal(credentials.length, 1);
      assert.equal(credentials[0]?.tokenHash, undefined);

      const revoked = await fetch(`${base}/api/extension/credentials/${payload.credential.id}`, {
        method: "DELETE",
        headers: { "x-dezin-daemon-token": DAEMON_TOKEN },
      });
      assert.equal(revoked.status, 200);

      const afterRevoke = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${payload.token}`,
          origin: EXTENSION_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ images: [{ name: "shot.png", base64: "YWJjZA==" }] }),
      });
      assert.equal(afterRevoke.status, 401);
    },
    { security: { token: DAEMON_TOKEN } } as Partial<AppDeps>,
  );
});

test("pairing rejects non-extension origins and malformed credentials while daemon token keeps full access", async () => {
  await withServer(
    async ({ base }) => {
      const pairCode = await createPairCode(base);
      const wrongOrigin = await exchangePairCode(base, pairCode.code, "http://127.0.0.1:7457");
      assert.equal(wrongOrigin.status, 403);

      const malformed = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: {
          authorization: "Bearer malformed-extension-credential",
          origin: EXTENSION_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ images: [{ name: "shot.png", base64: "YWJjZA==" }] }),
      });
      assert.equal(malformed.status, 401);

      const daemonHeaders = {
        authorization: `Bearer ${DAEMON_TOKEN}`,
        "content-type": "application/json",
      };
      const capture = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: daemonHeaders,
        body: JSON.stringify({ images: [{ name: "shot.png", base64: "YWJjZA==" }] }),
      });
      assert.equal(capture.status, 200);
      const analyze = await fetch(`${base}/api/analyze-image`, {
        method: "POST",
        headers: daemonHeaders,
        body: JSON.stringify({ image: "YWJjZA==" }),
      });
      assert.equal(analyze.status, 200);
      const settings = await fetch(`${base}/api/settings`, {
        headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
      });
      assert.equal(settings.status, 200);
    },
    {
      security: { token: DAEMON_TOKEN },
      imageAnalyzer: async () => "A concise recreation brief.",
    } as Partial<AppDeps>,
  );
});

test("daemon serves the web shell without a token but injects the daemon token", async () => {
  const webDir = mkdtempSync(join(tmpdir(), "dezin-web-shell-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
  try {
    await withServer(
      async ({ base }) => {
        const shell = await fetch(`${base}/`);
        assert.equal(shell.status, 200);
        const html = await shell.text();
        assert.match(html, /window\.__DEZIN_DAEMON_TOKEN__/);
        assert.match(html, /test-token/);

        const api = await fetch(`${base}/api/projects`);
        assert.equal(api.status, 401);
      },
      { security: { token: "test-token" }, webDir } as Partial<AppDeps>,
    );
  } finally {
    rmSync(webDir, { recursive: true, force: true });
  }
});

test("daemon allows static preview reads without a token while protecting APIs", async () => {
  await withServer(
    async ({ base, dataDir }) => {
      const id = "proj-1";
      mkdirSync(join(dataDir, "projects", id), { recursive: true });
      writeFileSync(join(dataDir, "projects", id, "index.html"), "<h1>preview</h1>");

      const preview = await fetch(`${base}/projects/${id}/preview/index.html`);
      assert.equal(preview.status, 200);
      assert.match(await preview.text(), /preview/);

      const api = await fetch(`${base}/api/settings`);
      assert.equal(api.status, 401);
    },
    { security: { token: "test-token" } } as Partial<AppDeps>,
  );
});

test("JSON API routes reject non-JSON content types", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "Plain text JSON" }),
    });
    assert.equal(res.status, 415);
  });
});

test("project CRUD over HTTP", async () => {
  await withServer(async ({ base, dataDir }) => {
    // empty list
    assert.deepEqual(await (await fetch(`${base}/api/projects`)).json(), []);

    // create
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Landing", designSystemId: "modern-minimal" }),
    });
    assert.equal(created.status, 201);
    const project = (await created.json()) as { id: string; name: string; designSystemId: string };
    assert.equal(project.name, "Landing");
    assert.equal(project.designSystemId, "modern-minimal");

    // get
    const got = await fetch(`${base}/api/projects/${project.id}`);
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { id: string }).id, project.id);

    // patch
    const patched = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Landing v2", skillId: "frontend-design" }),
    });
    const pj = (await patched.json()) as { name: string; skillId: string };
    assert.equal(pj.name, "Landing v2");
    assert.equal(pj.skillId, "frontend-design");

    // list has one
    assert.equal(((await (await fetch(`${base}/api/projects`)).json()) as unknown[]).length, 1);

    const diskDir = join(dataDir, "projects", project.id);
    mkdirSync(diskDir, { recursive: true });
    writeFileSync(join(diskDir, "index.html"), "<h1>delete me</h1>");
    assert.equal(existsSync(diskDir), true);

    // delete (idempotent 204)
    const del = await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.equal((await fetch(`${base}/api/projects/${project.id}`)).status, 404);
    assert.equal(existsSync(diskDir), false);
  });
});

test("project deletion aborts its active Run before removing every daemon-owned resource", async () => {
  let entered!: () => void;
  const runEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let abortObserved = false;
  const runner: AgentRunner = {
    id: "blocked-project-delete",
    async runTurn(input) {
      entered();
      return await new Promise((resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("blocked runner test fallback")), 500);
        input.signal?.addEventListener("abort", () => {
          abortObserved = true;
          clearTimeout(fallback);
          setTimeout(() => {
            if (existsSync(input.projectDir)) writeFileSync(join(input.projectDir, "post-abort.txt"), "late write");
          }, 5);
          setTimeout(() => reject(abortError()), 15);
        }, { once: true });
      });
    },
  };

  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Delete while running" });
    const projectPath = join(dataDir, "projects", project.id);
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "index.html"), "<main>working</main>");
    let sharinganClosed = 0;
    await ensureProbeSession(
      project.id,
      dataDir,
      async () => ({ close: async () => { sharinganClosed += 1; } }) as unknown as import("../src/sharingan-browser.ts").SharinganSession,
    );

    const runResponsePromise = fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, brief: "stay blocked" }),
    });
    await runEntered;
    const run = store.listRuns(project.id)[0]!;
    const ownedPaths = [
      join(dataDir, ".runs", `${run.id}.jsonl`),
      join(dataDir, ".runs", run.id, "bundle.txt"),
      join(dataDir, "worktrees", project.id, "branch", "artifact.txt"),
      join(dataDir, "version-worktrees", project.id, run.id, "artifact.txt"),
      projectPath,
    ];
    for (const path of ownedPaths.slice(1, -1)) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "owned");
    }

    const deleted = await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" });
    const runResponse = await runResponsePromise;
    await runResponse.text();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(deleted.status, 204);
    assert.equal(abortObserved, true, "the active Run observes abort before DELETE resolves");
    assert.equal(sharinganClosed, 1, "the project Sharingan session closes before DELETE resolves");
    assert.equal(store.getProject(project.id), null);
    assert.equal(store.getRun(run.id), null);
    assert.ok(ownedPaths.every((path) => !existsSync(path)), "project paths, Run logs, and worktrees stay absent");
    assert.equal(existsSync(join(projectPath, "post-abort.txt")), false, "no write lands after deletion");
  }, { runner, visualQa: async () => [] });
});

test("project deletion owns in-flight setup and rejects concurrent preview and variant acquisition", async () => {
  let setupEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    setupEntered = resolve;
  });
  let finishSetup!: () => void;
  const finish = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  let setupFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    setupFinished = resolve;
  });
  let abortObserved!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abortObserved = resolve;
  });
  let setupSawAbort = false;
  let previewCalls = 0;

  await withServer(
    async ({ base, dataDir }) => {
      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Setup race", mode: "standard" }),
      });
      assert.equal(created.status, 201);
      const project = (await created.json()) as { id: string };
      const projectPath = join(dataDir, "projects", project.id);
      await entered;

      let deletionFinished = false;
      const deleting = fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }).then((response) => {
        deletionFinished = true;
        return response;
      });
      await Promise.race([aborted, new Promise((resolve) => setTimeout(resolve, 50))]);

      const [preview, variant] = await Promise.all([
        fetch(`${base}/api/projects/${project.id}/devserver`),
        fetch(`${base}/api/projects/${project.id}/variants`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Too late" }),
        }),
      ]);
      const deletionWasPending = !deletionFinished;
      finishSetup();
      await finished;
      const deleted = await deleting;
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(setupSawAbort, true, "deletion aborts tracked setup work");
      assert.equal(deletionWasPending, true, "204 waits for the setup operation to settle");
      assert.equal(preview.status, 409, "preview acquisition is rejected once deletion starts");
      assert.equal(variant.status, 409, "variant resource creation is rejected once deletion starts");
      assert.equal(previewCalls, 0, "the preview resource hook is never entered");
      assert.equal(deleted.status, 204);
      assert.equal(existsSync(projectPath), false, "late setup writes are removed before 204");
    },
    {
      standardProjectSetup: async (_projectId, projectPath, signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => {
          setupSawAbort = true;
          abortObserved();
        }, { once: true });
        setupEntered();
        await finish;
        mkdirSync(projectPath, { recursive: true });
        writeFileSync(join(projectPath, "late-setup.txt"), "late");
        setupFinished();
      },
      ensureDevServer: async () => {
        previewCalls += 1;
        return { url: "http://127.0.0.1:65530/" };
      },
    },
  );
});

test("project deletion invalidates a delayed Sharingan open and closes the late session", async () => {
  let openEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    openEntered = resolve;
  });
  let resolveOpen!: (session: import("../src/sharingan-browser.ts").SharinganSession) => void;
  const delayedOpen = new Promise<import("../src/sharingan-browser.ts").SharinganSession>((resolve) => {
    resolveOpen = resolve;
  });
  let openCalls = 0;
  let closeCalls = 0;

  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({
        name: "Sharingan open race",
        mode: "standard",
        sharingan: true,
        sourceUrl: "https://example.test/",
      });
      const projectPath = join(dataDir, "projects", project.id);
      mkdirSync(projectPath, { recursive: true });

      const started = await fetch(`${base}/api/sharingan/${project.id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.test/" }),
      });
      assert.equal(started.status, 200);
      await entered;

      let deletionSettled = false;
      const deleting = fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }).then((response) => {
        deletionSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const restarted = await fetch(`${base}/api/sharingan/${project.id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.test/again" }),
      });
      const deletionWaitedForOpen = !deletionSettled;
      resolveOpen({ close: async () => { closeCalls += 1; } } as unknown as import("../src/sharingan-browser.ts").SharinganSession);
      const deleted = await deleting;

      assert.equal(deletionWaitedForOpen, true, "DELETE waits for the synchronously retained open promise");
      assert.equal(restarted.status, 409, "a blocked project cannot start a second browser session");
      assert.equal(openCalls, 1, "only the admitted start reaches the browser opener");
      assert.equal(closeCalls, 1, "the session resolving after release is closed exactly once");
      assert.equal(deleted.status, 204);
      assert.equal(existsSync(projectPath), false);
    },
    {
      sharinganOpen: async () => {
        openCalls += 1;
        openEntered();
        return delayedOpen;
      },
    },
  );
});

test("Sharingan status returns 404 after project deletion without recreating capture ownership", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({
      name: "Deleted Sharingan status",
      mode: "standard",
      sharingan: true,
      sourceUrl: "https://example.test/",
    });
    mkdirSync(join(dataDir, "projects", project.id), { recursive: true });
    const before = sharinganCaptureRegistrySizeForTests();
    let closes = 0;
    await ensureProbeSession(
      project.id,
      dataDir,
      async () => ({
        close: async () => {
          closes += 1;
          if (closes > 1) throw new Error("session close is not idempotent");
        },
      }) as unknown as import("../src/sharingan-browser.ts").SharinganSession,
    );
    assert.equal(sharinganCaptureRegistrySizeForTests(), before + 1);

    const deleted = await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(closes, 1);
    assert.equal(sharinganCaptureRegistrySizeForTests(), before, "deletion releases capture ownership");

    const status = await fetch(`${base}/api/sharingan/${project.id}/status`);
    assert.equal(status.status, 404, "status respects Store deletion instead of reporting a phantom idle project");
    assert.equal(
      sharinganCaptureRegistrySizeForTests(),
      before,
      "polling a deleted project must not recreate capture ownership",
    );
  });
});

test("project deletion waits for an admitted Sharingan cancel and removes its cancelled tombstone", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({
      name: "Sharingan cancel deletion race",
      mode: "standard",
      sharingan: true,
      sourceUrl: "https://example.test/",
    });
    mkdirSync(join(dataDir, "projects", project.id), { recursive: true });
    const registryBefore = sharinganCaptureRegistrySizeForTests();
    let closeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { closeEntered = resolve; });
    let finishClose!: () => void;
    const closeFinished = new Promise<void>((resolve) => { finishClose = resolve; });
    await ensureProbeSession(
      project.id,
      dataDir,
      async () => ({
        close: async () => {
          closeEntered();
          await closeFinished;
        },
      }) as unknown as import("../src/sharingan-browser.ts").SharinganSession,
    );

    const cancelling = fetch(`${base}/api/sharingan/${project.id}/cancel`, { method: "POST" });
    await entered;
    let deletionSettled = false;
    const deleting = fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }).then((response) => {
      deletionSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const deletionWaitedForCancel = !deletionSettled;
    finishClose();

    const [cancelled, deleted] = await Promise.all([cancelling, deleting]);
    assert.equal(deletionWaitedForCancel, true, "DELETE waits for the admitted cancel operation to settle");
    assert.equal(cancelled.status, 200);
    assert.equal(deleted.status, 204);
    assert.equal(
      sharinganCaptureRegistrySizeForTests(),
      registryBefore,
      "project cleanup releases the cancelled tombstone instead of letting cancel recreate it",
    );
  });
});

test("project deletion aborts a partial reference upload before it can recreate .refs", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Slow reference upload" });
    const root = join(dataDir, "projects", project.id);
    mkdirSync(root, { recursive: true });

    const url = new URL(`/api/projects/${project.id}/refs`, base);
    let uploadStatus = 0;
    const uploadDone = new Promise<void>((resolve) => {
      const upload = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (response) => {
          uploadStatus = response.statusCode ?? 0;
          response.resume();
          response.on("end", resolve);
        },
      );
      upload.on("error", () => resolve());
      upload.write('{"name":"late.txt","contentBase64":"');
      setTimeout(() => upload.end(`${Buffer.from("late").toString("base64")}\"}`), 100);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const deleted = await Promise.race([
      fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.notEqual(deleted, "timeout", "DELETE must not wait for the client to finish its body");
    assert.equal((deleted as Response).status, 204);
    await uploadDone;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.notEqual(uploadStatus, 200, "the cancelled upload is not accepted");
    assert.equal(existsSync(root), false, "the partial upload cannot recreate the deleted project tree");
  });
});

test("project deletion aborts and settles a partial direct-cover upload before returning", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Slow direct cover upload" });
    const root = join(dataDir, "projects", project.id);
    mkdirSync(root, { recursive: true });

    const url = new URL(`/api/projects/${project.id}/cover`, base);
    let uploadSettled = false;
    let uploadStatus = 0;
    let upload!: ReturnType<typeof http.request>;
    const uploadDone = new Promise<void>((resolve) => {
      upload = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (response) => {
          uploadStatus = response.statusCode ?? 0;
          response.resume();
          response.once("end", () => {
            uploadSettled = true;
            resolve();
          });
        },
      );
      upload.once("error", () => {
        uploadSettled = true;
        resolve();
      });
      upload.write('{"dataUrl":"data:image/png;base64,');
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const deleted = await Promise.race([
      fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.notEqual(deleted, "timeout", "DELETE is bounded while the client withholds the body tail");
    assert.equal((deleted as Response).status, 204);
    const uploadOutcome = await Promise.race([
      uploadDone.then(() => "settled" as const),
      new Promise<"still-open">((resolve) => setTimeout(() => resolve("still-open"), 50)),
    ]);
    if (uploadOutcome === "still-open") upload.destroy();

    assert.equal(uploadSettled, true, "the owned body reader is gone when DELETE returns");
    assert.notEqual(uploadStatus, 200, "the cancelled upload is not accepted");
    assert.equal(existsSync(join(root, ".cover.png")), false);
    assert.equal(existsSync(root), false);
  });
});

test("moodboard CRUD, nodes, and uploaded assets over HTTP", async () => {
  await withServer(async ({ base, dataDir }) => {
    assert.deepEqual(await (await fetch(`${base}/api/moodboards`)).json(), []);

    const created = await fetch(`${base}/api/moodboards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "References" }),
    });
    assert.equal(created.status, 201);
    const board = (await created.json()) as { id: string; name: string };
    assert.equal(board.name, "References");

    const upload = await fetch(`${base}/api/moodboards/${board.id}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shot.png", mimeType: "image/png", contentBase64: Buffer.from("png").toString("base64") }),
    });
    assert.equal(upload.status, 201);
    const asset = (await upload.json()) as { id: string; url: string };
    assert.ok(asset.url.includes(asset.id));

    const assetRes = await fetch(`${base}${asset.url}`);
    assert.equal(assetRes.status, 200);
    assert.equal(await assetRes.text(), "png");

    const nodesRes = await fetch(`${base}/api/moodboards/${board.id}/nodes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes: [
          {
            type: "image-generator",
            x: 10,
            y: 20,
            width: 360,
            height: 240,
            data: { generatorPrompt: "Soft studio references", generatorStatus: "ready" },
          },
          { type: "image", x: 400, y: 20, width: 320, height: 240, data: { assetId: asset.id, url: asset.url } },
        ],
      }),
    });
    assert.equal(nodesRes.status, 200);
    const nodes = (await nodesRes.json()) as Array<{ type: string; data: { assetId?: string; generatorStatus?: string } }>;
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]?.type, "image-generator");
    assert.equal(nodes[0]?.data.generatorStatus, "ready");
    assert.equal(nodes[1]?.data.assetId, asset.id);

    const message = await fetch(`${base}/api/moodboards/${board.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Use calmer references" }),
    });
    assert.equal(message.status, 201);
    const messageBody = (await message.json()) as { messages: Array<{ role: string; content: string }> };
    assert.equal(messageBody.messages[1]?.role, "assistant");
    assert.match(messageBody.messages[1]?.content ?? "", /Canvas context: 2 items/);
    assert.match(messageBody.messages[1]?.content ?? "", /image-generator/);
    assert.match(messageBody.messages[1]?.content ?? "", /Soft studio references/);
    const detail = (await (await fetch(`${base}/api/moodboards/${board.id}`)).json()) as {
      nodes: Array<{ type: string }>;
      messages: unknown[];
      coverUrl: string | null;
    };
    assert.equal(detail.nodes.length, 2);
    assert.equal(detail.nodes[0]?.type, "image-generator");
    assert.equal(detail.messages.length, 2);
    assert.ok(detail.coverUrl);

    const diskDir = join(dataDir, "moodboards", board.id);
    assert.equal(existsSync(diskDir), true);
    const del = await fetch(`${base}/api/moodboards/${board.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.equal(existsSync(diskDir), false);
  });
});

test("effect registry exposes built-ins and persists custom effects over HTTP", async () => {
  await withServer(async ({ base }) => {
    const list = (await (await fetch(`${base}/api/effects`)).json()) as Array<{ id: string; name: string; origin: string; previewUrl?: string }>;
    assert.ok(
      list.some(
        (effect) =>
          effect.id === "paper-texture" && effect.origin === "built-in" && effect.previewUrl === "/effects/previews/paper-texture.jpg",
      ),
    );

    const builtIn = await fetch(`${base}/api/effects/paper-texture`);
    assert.equal(builtIn.status, 200);
    const detail = (await builtIn.json()) as { id: string; code: string; parameters: unknown[]; previewUrl?: string };
    assert.equal(detail.id, "paper-texture");
    assert.equal(detail.code, "@paper-design/shaders-react:paper-texture");
    assert.equal(detail.previewUrl, "/effects/previews/paper-texture.jpg");
    assert.ok(detail.parameters.length > 0);

    const created = await fetch(`${base}/api/effects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Glass ribbon" }),
    });
    assert.equal(created.status, 201);
    const custom = (await created.json()) as { id: string; name: string; origin: string; code: string };
    assert.equal(custom.name, "Glass ribbon");
    assert.equal(custom.origin, "custom");
    assert.ok(custom.code.includes("#version 300 es"));

    const patched = await fetch(`${base}/api/effects/${custom.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Glass ribbon v2", presets: [{ id: "default", name: "Default", values: { intensity: 0.7 } }] }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { name: string }).name, "Glass ribbon v2");
  });
});

test("moodboard agent structured context is budgeted instead of a raw full-canvas dump", () => {
  const board = { id: "b1", name: "Large board", createdAt: 1, updatedAt: 2, archivedAt: null, coverAssetId: null };
  const nodes = Array.from({ length: 80 }, (_, index) => ({
    id: `n${index}`,
    boardId: board.id,
    type: index % 5 === 0 ? ("image-generator" as const) : ("note" as const),
    x: index * 12,
    y: index * 8,
    width: 240,
    height: 160,
    rotation: 0,
    zIndex: index,
    data: {
      content: `Long note ${index} ${"warm editorial material ".repeat(80)}`,
      generatorPrompt: index % 5 === 0 ? `Generate warm editorial still life ${index}` : "",
      name: `Reference ${index}`,
    },
    createdAt: index + 1,
    updatedAt: index + 2,
  }));
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index}`,
    boardId: board.id,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${index} ${"context ".repeat(500)}`,
    createdAt: index + 1,
  }));

  const context = buildMoodboardAgentContext({
    board,
    nodes,
    assets: [],
    messages,
    content: "Use the hero editorial generator and warm material notes",
  }) as BudgetedMoodboardAgentContext;

  assert.equal(context.summary.nodeCount, 80);
  assert.equal(context.summary.messageCount, 40);
  assert.ok(context.relevantNodes.length <= 36);
  assert.ok(context.nodeIndex.length <= 240);
  assert.ok(context.recentMessages.length <= 24);
  assert.equal(context.nodes, undefined);
  assert.equal(context.messages, undefined);
  assert.ok(JSON.stringify(context).length < 80_000);
  assert.ok(context.omitted.relevantNodes > 0);
  assert.ok(context.omitted.messages > 0);
});

test("moodboard messages invoke the selected agent with canvas context", async () => {
  const captures: Array<Parameters<NonNullable<AppDeps["moodboardAgentText"]>>[0]> = [];
  await withServer(
    async ({ base, store }) => {
      const board = store.createMoodboard({ name: "Editorial references" });
      const asset = store.createMoodboardAsset(board.id, {
        kind: "image",
        fileName: "hero.png",
        mimeType: "image/png",
        width: 1024,
        height: 768,
        source: "upload",
      });
      store.replaceMoodboardNodes(board.id, [
        {
          type: "image-generator",
          x: 10,
          y: 20,
          width: 360,
          height: 240,
          data: { generatorPrompt: "Soft shadows, editorial still life", generatorStatus: "ready" },
        },
        {
          type: "image",
          x: 400,
          y: 20,
          width: 320,
          height: 240,
          data: { assetId: asset.id, fileName: asset.fileName },
        },
      ]);
      store.addMoodboardMessage(board.id, "user", "Previous direction: calm, tactile, warm neutrals.");

      const res = await fetch(`${base}/api/moodboards/${board.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Use warmer references", agentCommand: "codex", model: "gpt-5" }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
      assert.equal(body.messages[1]?.content, "Agent saw the current canvas.");
    },
    {
      moodboardAgentText: async (input) => {
        captures.push(input);
        return "Agent saw the current canvas.";
      },
    },
  );
  const captured = captures[0];
  assert.ok(captured);
  assert.equal(captured.agentCommand, "codex");
  assert.equal(captured.model, "gpt-5");
  assert.equal(captured.nodes.length, 2);
  assert.equal(captured.assets.length, 1);
  assert.match(captured.prompt, /Editorial references/);
  assert.match(captured.prompt, /Soft shadows, editorial still life/);
  assert.match(captured.prompt, /hero\.png/);
  assert.match(captured.prompt, /Previous direction/);
  assert.match(captured.prompt, /Latest user request:\nUse warmer references/);
  assert.equal((captured.prompt.match(/Use warmer references/g) ?? []).length, 1);
  assert.match(captured.prompt, /Budgeted structured context file:/);
  const context = JSON.parse(readFileSync(join(captured.cwd, "moodboard-context.json"), "utf8")) as BudgetedMoodboardAgentContext;
  assert.equal(context.board.name, "Editorial references");
  assert.equal(context.latestUserRequest, "Use warmer references");
  assert.equal(context.summary.nodeCount, 2);
  assert.equal(context.nodes, undefined);
  assert.equal(context.messages, undefined);
  assert.ok(Array.isArray(context.relevantNodes));
  assert.ok(Array.isArray(context.nodeIndex));
  assert.ok(context.relevantNodes.some((node) => node.id));
});

test("moodboard agent output parser strips canvas operation blocks", () => {
  const parsed = parseMoodboardAgentOutput(`Added a note.

\`\`\`dezin_moodboard_ops
[{"type":"add_note","content":"Warm material cue","x":120,"y":140}]
\`\`\``);

  assert.equal(parsed.text, "Added a note.");
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0]?.type, "add_note");
  assert.equal(parsed.operations[0]?.content, "Warm material cue");
  assert.equal(parsed.operations[0]?.x, 120);
  assert.equal(parsed.operations[0]?.y, 140);
});

test("moodboard messages apply agent canvas operations", async () => {
  await withServer(
    async ({ base, store }) => {
      const board = store.createMoodboard({ name: "Material board" });
      const res = await fetch(`${base}/api/moodboards/${board.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Add a material cue", agentCommand: "codex" }),
      });

      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        messages: Array<{ role: string; content: string }>;
        nodes?: Array<{ type: string; x: number; y: number; data: Record<string, unknown> }>;
      };
      assert.equal(body.messages[1]?.content, "Added a note.");
      assert.doesNotMatch(body.messages[1]?.content ?? "", /dezin_moodboard_ops/);
      assert.equal(body.nodes?.length, 2);
      assert.equal(body.nodes?.[0]?.type, "note");
      assert.equal(body.nodes?.[0]?.x, 120);
      assert.equal(body.nodes?.[0]?.y, 140);
      assert.equal(body.nodes?.[0]?.data.content, "Warm material cue");
      assert.equal(body.nodes?.[1]?.type, "image-generator");
      assert.equal(body.nodes?.[1]?.data.generatorPrompt, "Layered glass product shot");
      assert.equal(typeof body.nodes?.[1]?.data.agentConversationId, "string");
      assert.ok(body.nodes?.[1]?.data.agentConversationId);
      assert.equal(store.listMoodboardNodes(board.id).length, 2);
    },
    {
      moodboardAgentText: async () => `Added a note.

\`\`\`dezin_moodboard_ops
[{"type":"add_note","content":"Warm material cue","x":120,"y":140},{"type":"add_image_generator","prompt":"Layered glass product shot","x":380,"y":140}]
\`\`\``,
    },
  );
});

test("moodboard conversations isolate agent messages", async () => {
  await withServer(async ({ base, store }) => {
    const board = store.createMoodboard({ name: "Material board" });

    const detail = (await (await fetch(`${base}/api/moodboards/${board.id}`)).json()) as {
      activeConversationId: string;
      conversations: Array<{ id: string; title: string; turns: number }>;
      messages: unknown[];
    };
    assert.equal(detail.conversations.length, 1);
    assert.equal(detail.conversations[0]?.title, "Conversation 1");
    assert.equal(detail.messages.length, 0);

    const created = (await (
      await fetch(`${base}/api/moodboards/${board.id}/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Alternate direction" }),
      })
    ).json()) as { id: string; title: string };
    assert.equal(created.title, "Alternate direction");

    const posted = await fetch(`${base}/api/moodboards/${board.id}/conversations/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Explore cooler references" }),
    });
    assert.equal(posted.status, 201);

    const firstMessages = (await (await fetch(`${base}/api/moodboards/${board.id}/conversations/${detail.activeConversationId}/messages`)).json()) as unknown[];
    const secondMessages = (await (await fetch(`${base}/api/moodboards/${board.id}/conversations/${created.id}/messages`)).json()) as Array<{
      role: string;
      content: string;
      conversationId: string;
    }>;

    assert.equal(firstMessages.length, 0);
    assert.equal(secondMessages.length, 2);
    assert.equal(secondMessages[0]?.conversationId, created.id);
    assert.equal(secondMessages[0]?.content, "Explore cooler references");

    const conversations = (await (await fetch(`${base}/api/moodboards/${board.id}/conversations`)).json()) as Array<{ id: string; turns: number }>;
    assert.equal(conversations.find((conversation) => conversation.id === created.id)?.turns, 1);
  });
});

test("moodboard agent prompt uses a budgeted working set with a budgeted context path", () => {
  const now = Date.now();
  const nodes = Array.from({ length: 36 }, (_, index) => ({
    id: `n${index}`,
    boardId: "b1",
    type: "note" as const,
    x: index * 24,
    y: index * 12,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: index,
    data: { content: index === 35 ? "warm hero reference with tactile material" : `quiet reference ${index}` },
    createdAt: now + index,
    updatedAt: now + index,
  }));

  const prompt = buildMoodboardAgentPrompt({
    board: { id: "b1", name: "Large board", createdAt: now, updatedAt: now, archivedAt: null, coverAssetId: null },
    nodes,
    assets: [],
    messages: [],
    content: "Find the warm hero direction",
    contextPath: "/tmp/dezin/moodboard-context.json",
  });

  assert.match(prompt, /budgeted working set/);
  assert.match(prompt, /Budgeted structured context file: \/tmp\/dezin\/moodboard-context\.json/);
  assert.match(prompt, /warm hero reference/);
  assert.match(prompt, /more canvas nodes omitted/);
});

test("POST /api/projects/:id/title updates a project name with a generated title", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-title-test-"));
  const store = new Store(":memory:");
  const server = createApp({
    store,
    dataDir,
    titleGenerator: async (input) => (input.brief.includes("pricing") ? "Pricing Control Room" : "Untitled"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const project = store.createProject({ name: "A dashboard for pricing experiments" });
    const res = await fetch(`${base}/api/projects/${project.id}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "A dashboard for pricing experiments" }),
    });

    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { name: string }).name, "Pricing Control Room");
    assert.equal(store.getProject(project.id)?.name, "Pricing Control Room");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("conversations under a project", async () => {
  await withServer(async ({ base }) => {
    const project = (await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "P" }),
      })
    ).json()) as { id: string };

    const conv = await fetch(`${base}/api/projects/${project.id}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Chat" }),
    });
    assert.equal(conv.status, 201);
    const list = (await (await fetch(`${base}/api/projects/${project.id}/conversations`)).json()) as unknown[];
    assert.equal(list.length, 1);

    // conversations for unknown project → 404
    assert.equal((await fetch(`${base}/api/projects/nope/conversations`)).status, 404);
  });
});

test("validation + routing errors", async () => {
  await withServer(async ({ base }) => {
    // missing name → 400
    const bad = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    const malformed = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    // unknown route → 404
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    // wrong method on a known path → 405
    assert.equal((await fetch(`${base}/api/health`, { method: "POST" })).status, 405);
  });
});

test("capture handoff is only cleared by explicit consume", async () => {
  await withServer(async ({ base }) => {
    const post = await fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ name: "shot.png", base64: "abcd" }], note: "brief", source: "extension" }),
    });
    assert.equal(post.status, 200);

    const peek1 = (await (await fetch(`${base}/api/capture`)).json()) as { images: unknown[]; note: string };
    const peek2 = (await (await fetch(`${base}/api/capture`)).json()) as { images: unknown[]; note: string };
    assert.equal(peek1.images.length, 1);
    assert.equal(peek2.images.length, 1);

    const consumed = (await (
      await fetch(`${base}/api/capture/consume`, { method: "POST" })
    ).json()) as { images: unknown[]; note: string };
    assert.equal(consumed.images.length, 1);
    assert.equal(consumed.note, "brief");

    const empty = (await (
      await fetch(`${base}/api/capture/consume`, { method: "POST" })
    ).json()) as { images: unknown[] };
    assert.equal(empty.images.length, 0);
  });
});

test("static artifact serving from the project dir", async () => {
  await withServer(async ({ base, dataDir }) => {
    const id = "proj-1";
    mkdirSync(join(dataDir, "projects", id), { recursive: true });
    writeFileSync(join(dataDir, "projects", id, "index.html"), "<h1>hello</h1>");

    // explicit file — served HTML includes the original markup + the picker bridge
    const r1 = await fetch(`${base}/projects/${id}/preview/index.html`);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get("content-type") ?? "", /text\/html/);
    const body1 = await r1.text();
    assert.ok(body1.includes("<h1>hello</h1>"));
    assert.ok(body1.includes("data-dezin-bridge"), "preview HTML should carry the element-picker bridge");

    // empty rest → index.html
    const r2 = await fetch(`${base}/projects/${id}/preview/`);
    assert.equal(r2.status, 200);
    assert.ok((await r2.text()).includes("<h1>hello</h1>"));

    // missing file → 404
    assert.equal((await fetch(`${base}/projects/${id}/preview/missing.html`)).status, 404);
  });
});

test("matchPath: params and trailing wildcard", () => {
  assert.deepEqual(matchPath("/api/projects/:id", "/api/projects/abc"), { params: { id: "abc" } });
  assert.equal(matchPath("/api/projects/:id", "/api/projects/abc/x"), null);
  assert.deepEqual(matchPath("/projects/:id/preview/*rest", "/projects/p/preview/a/b.html"), {
    params: { id: "p", rest: "a/b.html" },
  });
  assert.deepEqual(matchPath("/projects/:id/preview/*rest", "/projects/p/preview/"), {
    params: { id: "p", rest: "" },
  });
});

test("safeJoin blocks path traversal", () => {
  const root = "/data/projects/p";
  assert.equal(safeJoin(root, "index.html"), "/data/projects/p/index.html");
  assert.equal(safeJoin(root, "../../etc/passwd"), null);
  assert.equal(safeJoin(root, "a/../b.css"), "/data/projects/p/b.css");
});

test("picker bridge reports stable precise selectors", () => {
  const html = injectSelectBridge("<body><section data-dezin-id=\"hero\"><h1>Title</h1></section></body>");
  assert.match(html, /data-dezin-id/);
  assert.match(html, /nth-of-type/);
  assert.match(html, /styles:styles\(el\)/);
  assert.match(html, /attrs:attrs\(el\)/);
  assert.match(html, /borderWidth:s\.borderWidth/);
  assert.match(html, /gridTemplateColumns:s\.gridTemplateColumns/);
  assert.match(html, /focus-target/);
  assert.match(html, /sync-scroll/);
  assert.match(html, /type:'scroll'/);
  assert.match(html, /__dezinScrollSync/);
  assert.match(html, /installPicker=!window\.__dezinSelect/);
  assert.doesNotMatch(html, /if\(window\.__dezinSelect\)return/);
  assert.match(html, /hoverBox/);
  assert.match(html, /selectedBox/);
  assert.match(html, /#f97316/);
});
