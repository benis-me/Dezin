import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp, matchPath, safeJoin } from "../src/index.ts";
import type { AppDeps } from "../src/index.ts";
import { buildMoodboardAgentContext, buildMoodboardAgentPrompt, parseMoodboardAgentOutput } from "../src/moodboard-agent.ts";
import { injectSelectBridge } from "../src/serve-static.ts";

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
  const server = createApp({ ...extraDeps, store, dataDir, version: extraDeps.version ?? "9.9.9" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
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
  assert.match(html, /hoverBox/);
  assert.match(html, /selectedBox/);
  assert.match(html, /#f97316/);
});
