import { test, expect, vi } from "vitest";
import { createApiClient, ApiError, parseSseBlock, type FetchLike } from "./api.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

const PROJECT = {
  id: "p1",
  name: "P",
  skillId: null,
  designSystemId: "modern-minimal",
  createdAt: 1,
  updatedAt: 1,
};

test("createProject posts JSON and returns the project", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(PROJECT, 201));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const got = await api.createProject({ name: "P", designSystemId: "modern-minimal" });
  expect(got).toEqual(PROJECT);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects",
    expect.objectContaining({ method: "POST" }),
  );
});

test("createApiClient sends the daemon token header on JSON requests", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([PROJECT]));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "tok_123" });

  await api.listProjects();

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects",
    expect.objectContaining({ headers: { "x-dezin-daemon-token": "tok_123" } }),
  );
});

test("createApiClient reads the daemon token from the injected page global by default", async () => {
  const g = globalThis as typeof globalThis & { __DEZIN_DAEMON_TOKEN__?: string };
  const previous = g.__DEZIN_DAEMON_TOKEN__;
  g.__DEZIN_DAEMON_TOKEN__ = "tok_global";
  try {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([PROJECT]));
    const api = createApiClient({ baseUrl: "http://d", fetchImpl });

    await api.listProjects();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://d/api/projects",
      expect.objectContaining({ headers: { "x-dezin-daemon-token": "tok_global" } }),
    );
  } finally {
    g.__DEZIN_DAEMON_TOKEN__ = previous;
  }
});

test("createApiClient preserves existing headers when adding the daemon token", async () => {
  const imported = { ...PROJECT, id: "p2", name: "Imported" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(imported, 201));
  const api = createApiClient({ fetchImpl, daemonToken: "tok_123" });
  const file = new Blob(["zip"], { type: "application/zip" });

  await api.importProject(file);

  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/projects/import",
    expect.objectContaining({
      headers: { "content-type": "application/zip", "x-dezin-daemon-token": "tok_123" },
    }),
  );
});

test("createApiClient sends the daemon token header on SSE requests", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(sseStream([`data: {"type":"run-done"}\n\n`]), { status: 200 }));
  const api = createApiClient({ fetchImpl, daemonToken: "tok_123" });

  for await (const _ of api.streamRun({ projectId: "p1", brief: "make a hero" })) {
    // consume stream
  }

  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/runs",
    expect.objectContaining({ headers: { "content-type": "application/json", "x-dezin-daemon-token": "tok_123" } }),
  );
});

test("generateProjectTitle POSTs the background title endpoint", async () => {
  const titled = { ...PROJECT, name: "Pricing Control Room" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(titled));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.generateProjectTitle("p1", "A dashboard for pricing experiments")).resolves.toEqual(titled);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/title",
    expect.objectContaining({ method: "POST" }),
  );
});

test("optimizePrompt POSTs the selected prompt optimizer context", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ prompt: "Create a finished Awwwards-level brief." }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(
    api.optimizePrompt({
      prompt: "make it cool",
      agentCommand: "codebuddy",
      model: "hunyuan",
      mode: "standard",
      skillId: "frontend-design",
      designSystemId: "modern-minimal",
    }),
  ).resolves.toEqual({ prompt: "Create a finished Awwwards-level brief." });

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/prompts/optimize",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "make it cool",
        agentCommand: "codebuddy",
        model: "hunyuan",
        mode: "standard",
        skillId: "frontend-design",
        designSystemId: "modern-minimal",
      }),
    }),
  );
});

test("listProjects GETs the collection", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([PROJECT]));
  const api = createApiClient({ fetchImpl });
  expect(await api.listProjects()).toEqual([PROJECT]);
  expect(fetchImpl).toHaveBeenCalledWith("/api/projects", undefined);
});

test("deleteProject handles 204 No Content", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
  const api = createApiClient({ fetchImpl });
  await expect(api.deleteProject("p1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/projects/p1",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("releaseDevServer DELETEs the project devserver lease", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ released: true }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.releaseDevServer("p1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/devserver",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("captureProjectCover POSTs the cover capture endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ captured: true }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.captureProjectCover("p1")).resolves.toEqual({ captured: true });
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/cover/capture",
    expect.objectContaining({ method: "POST" }),
  );
});

test("setVersionCover POSTs the version cover endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ captured: true }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.setVersionCover("p1", "r1")).resolves.toEqual({ captured: true });
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/versions/r1/cover",
    expect.objectContaining({ method: "POST" }),
  );
});

test("getVersionDiff GETs the version diff endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([{ t: "add", text: "new line" }]));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.getVersionDiff("p1", "r1")).resolves.toEqual([{ t: "add", text: "new line" }]);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/versions/r1/diff", undefined);
});

test("forkMessage POSTs the message fork endpoint", async () => {
  const payload = { conversationId: "c2", variantId: "v2", variants: [] };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(payload));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.forkMessage("p1", "m1")).resolves.toEqual(payload);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/messages/m1/fork",
    expect.objectContaining({ method: "POST" }),
  );
});

test("non-ok responses throw ApiError with the status", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response("nope", { status: 404 }));
  const api = createApiClient({ fetchImpl });
  await expect(api.getProject("x")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  await expect(api.getProject("x")).rejects.toBeInstanceOf(ApiError);
});

test("non-ok JSON responses throw ApiError with the daemon error message", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ error: "OpenAI rejected credentials." }, 401));
  const api = createApiClient({ fetchImpl });
  await expect(api.testModelProvider("openai")).rejects.toMatchObject({
    name: "ApiError",
    status: 401,
    message: "OpenAI rejected credentials.",
  });
});

test("previewUrl and exportUrl build the right paths", () => {
  const api = createApiClient({ baseUrl: "http://d" });
  expect(api.previewUrl("p1")).toBe("http://d/projects/p1/preview/");
  expect(api.exportUrl("p1")).toBe("http://d/api/projects/p1/export");
  expect(api.exportUrl("p1", "full")).toBe("http://d/api/projects/p1/export?scope=full");
});

test("importProject posts a zip file and returns the created project", async () => {
  const imported = { ...PROJECT, id: "p2", name: "Imported" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(imported, 201));
  const api = createApiClient({ fetchImpl });
  const file = new Blob(["zip"], { type: "application/zip" });
  await expect(api.importProject(file)).resolves.toEqual(imported);
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/projects/import",
    expect.objectContaining({
      method: "POST",
      body: file,
      headers: { "content-type": "application/zip" },
    }),
  );
});

test("streamRun yields SSE events, including one split across chunks", async () => {
  const chunks = [
    `data: {"type":"run-start","runId":"r1","conversationId":"c1"}\n\n`,
    `data: {"type":"turn-start","round":0,"isRepair":fal`, // split mid-JSON
    `se}\n\ndata: {"type":"run-done","runId":"r1","passed":true,"rounds":0,"previewUrl":"/projects/p1/preview/","findings":[]}\n\n`,
  ];
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(sseStream(chunks), { status: 200 }));
  const api = createApiClient({ fetchImpl });

  const events = [];
  for await (const ev of api.streamRun({ projectId: "p1", brief: "make a hero" })) {
    events.push(ev);
  }

  expect(events.map((e) => e.type)).toEqual(["run-start", "turn-start", "run-done"]);
  expect(events[1]).toMatchObject({ round: 0, isRepair: false });
  expect(events[2]).toMatchObject({ passed: true, previewUrl: "/projects/p1/preview/" });
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/runs",
    expect.objectContaining({ method: "POST" }),
  );
});

test("reattachRun can request events after a sequence cursor", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () =>
    new Response(sseStream([`data: {"type":"run-done","seq":3}\n\n`]), { status: 200 }),
  );
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const events = [];
  for await (const ev of api.reattachRun("r1", undefined, { afterSeq: 2 })) events.push(ev);

  expect(events).toEqual([{ type: "run-done", seq: 3 }]);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/runs/r1/stream?after=2", { signal: undefined });
});

test("listDesignSystems and listSkills GET the catalog", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (url) =>
    url.endsWith("/api/design-systems")
      ? jsonResponse([{ id: "modern-minimal", name: "Modern Minimal", category: "Modern & Minimal", summary: "x" }])
      : jsonResponse([{ id: "frontend-design", name: "Frontend design", description: "d", mode: "prototype", triggers: [], designSystem: true }]),
  );
  const api = createApiClient({ fetchImpl });
  const ds = await api.listDesignSystems();
  assert.equal(ds[0]?.id, "modern-minimal");
  const sk = await api.listSkills();
  assert.equal(sk[0]?.mode, "prototype");
  assert.ok(fetchImpl.mock.calls.some(([u]) => u === "/api/design-systems"));
  assert.ok(fetchImpl.mock.calls.some(([u]) => u === "/api/skills"));
});

test("settings + agents + health endpoints", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith("/api/settings") && init?.method === "PUT") {
      return jsonResponse({
        agentCommand: "codex",
        model: "o3",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: false,
        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: true,
        autoImproveMaxRounds: 8,
      });
    }
    if (url.endsWith("/api/settings")) {
      return jsonResponse({
        agentCommand: "claude",
        model: "",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: false,
        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: true,
        autoImproveMaxRounds: 8,
      });
    }
    if (url.endsWith("/api/agents")) return jsonResponse([{ id: "claude", command: "claude", available: true, version: "1.2.3" }]);
    return jsonResponse({ ok: true, version: "0.0.0" });
  });
  const api = createApiClient({ fetchImpl });
  assert.equal((await api.getSettings()).agentCommand, "claude");
  assert.equal((await api.updateSettings({ agentCommand: "codex", model: "o3" })).model, "o3");
  assert.equal((await api.listAgents())[0]?.available, true);
  assert.equal((await api.getHealth()).version, "0.0.0");
});

test("moodboard client methods hit first-class board endpoints", async () => {
  const board = { id: "b1", name: "Refs", createdAt: 1, updatedAt: 2, archivedAt: null, coverAssetId: null, coverUrl: null };
  const node = {
    id: "n1",
    boardId: "b1",
    type: "note" as const,
    x: 0,
    y: 0,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "x" },
    createdAt: 1,
    updatedAt: 1,
  };
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith("/api/moodboards") && init?.method === "POST") return jsonResponse(board, 201);
    if (url.endsWith("/api/moodboards")) return jsonResponse([board]);
    if (url.endsWith("/api/moodboards/b1/nodes") && init?.method === "PUT") return jsonResponse([node]);
    if (url.endsWith("/api/moodboards/b1/messages") && init?.method === "POST") return jsonResponse({ messages: [] }, 201);
    if (url.endsWith("/api/moodboards/b1/generate-image")) {
      return jsonResponse({ asset: { id: "a1", boardId: "b1", kind: "image", fileName: "generated.png", mimeType: "image/png", width: 1024, height: 1024, source: "generated", createdAt: 1, url: "/asset" }, nodes: [node], messages: [] }, 201);
    }
    return jsonResponse({ ...board, assets: [], nodes: [node], messages: [] });
  });
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.listMoodboards()).resolves.toEqual([board]);
  await expect(api.createMoodboard({ name: "Refs" })).resolves.toEqual(board);
  await expect(api.getMoodboard("b1")).resolves.toMatchObject({ id: "b1", nodes: [node] });
  await expect(api.saveMoodboardNodes("b1", [node])).resolves.toEqual([node]);
  await expect(api.postMoodboardMessage("b1", "read the board", { agentCommand: "codex", model: "gpt-5" })).resolves.toEqual({ messages: [] });
  await expect(api.generateMoodboardImage("b1", "soft glass")).resolves.toMatchObject({ nodes: [node] });
  await expect(api.generateMoodboardImage("b1", "make it warmer", { sourceAssetId: "asset-1", model: "gpt-image-2" })).resolves.toMatchObject({
    nodes: [node],
  });

  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/moodboards", undefined);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/moodboards/b1/nodes", expect.objectContaining({ method: "PUT" }));
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/moodboards/b1/messages",
    expect.objectContaining({ body: JSON.stringify({ content: "read the board", agentCommand: "codex", model: "gpt-5" }) }),
  );
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/moodboards/b1/generate-image", expect.objectContaining({ method: "POST" }));
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/moodboards/b1/generate-image",
    expect.objectContaining({
      body: JSON.stringify({ prompt: "make it warmer", sourceAssetId: "asset-1", model: "gpt-image-2" }),
    }),
  );
});

test("parseSseBlock ignores non-data noise", () => {
  expect(parseSseBlock(": keep-alive")).toBeNull();
  expect(parseSseBlock("data: not json")).toBeNull();
  expect(parseSseBlock(`data: {"type":"x"}`)).toEqual({ type: "x" });
});

test("getDesignSystem GETs the detail endpoint", async () => {
  const detail = { id: "modern-minimal", name: "Modern Minimal", category: "c", summary: "s", swatch: { bg: "#fff", surface: "#eee", fg: "#111", accent: "#36f" }, designMd: "## 1.", tokensCss: "--accent:#36f" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(detail));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.getDesignSystem("modern-minimal")).toEqual(detail);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/design-systems/modern-minimal", undefined);
});

test("listFiles GETs the files endpoint", async () => {
  const files = [{ path: "index.html", size: 12 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(files));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listFiles("p1")).toEqual(files);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/files", undefined);
});

test("listRuns GETs the active-branch runs endpoint by default", async () => {
  const runs = [{ id: "r1", variantId: "v1", status: "succeeded", score: 92, repairRounds: 1, lintPassed: true, createdAt: 1, finishedAt: 2 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(runs));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listRuns("p1")).toEqual(runs);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/runs", undefined);
});

test("listRuns can request all branch runs", async () => {
  const runs = [{ id: "r1", variantId: "v1", status: "succeeded", score: 92, repairRounds: 1, lintPassed: true, createdAt: 1, finishedAt: 2 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(runs));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listRuns("p1", { all: true })).toEqual(runs);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/runs?all=1", undefined);
});

test("getFileText fetches the static preview file as text", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response("<h1>hi</h1>", { status: 200 }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.getFileText("p1", "assets/x.css")).toBe("<h1>hi</h1>");
  expect(fetchImpl).toHaveBeenCalledWith("http://d/projects/p1/preview/assets/x.css");
});
