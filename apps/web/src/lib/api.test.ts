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

test("non-ok responses throw ApiError with the status", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response("nope", { status: 404 }));
  const api = createApiClient({ fetchImpl });
  await expect(api.getProject("x")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  await expect(api.getProject("x")).rejects.toBeInstanceOf(ApiError);
});

test("previewUrl and exportUrl build the right paths", () => {
  const api = createApiClient({ baseUrl: "http://d" });
  expect(api.previewUrl("p1")).toBe("http://d/projects/p1/preview/");
  expect(api.exportUrl("p1")).toBe("http://d/api/projects/p1/export");
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
        visualQaEnabled: false,
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
        visualQaEnabled: false,
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

test("listRuns GETs the runs endpoint", async () => {
  const runs = [{ id: "r1", status: "succeeded", score: 92, repairRounds: 1, lintPassed: true, createdAt: 1, finishedAt: 2 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(runs));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listRuns("p1")).toEqual(runs);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/runs", undefined);
});

test("getFileText fetches the static preview file as text", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response("<h1>hi</h1>", { status: 200 }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.getFileText("p1", "assets/x.css")).toBe("<h1>hi</h1>");
  expect(fetchImpl).toHaveBeenCalledWith("http://d/projects/p1/preview/assets/x.css");
});
