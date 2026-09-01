import { expect, test, vi } from "vitest";
import type { DesignCanvas, DesignJob } from "../design-canvas/types.ts";
import { createApiClient, type FetchLike } from "./api.ts";
import { createDesignCanvasApi } from "./design-canvas-api.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonBody<T>(init: RequestInit | undefined): T {
  if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
  return JSON.parse(init.body) as T;
}

function requestMethod(init: RequestInit | undefined): string {
  return init?.method ?? "GET";
}

async function readBlobText(blob: Blob): Promise<string> {
  const withArrayBuffer = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof withArrayBuffer.arrayBuffer === "function") {
    return new TextDecoder().decode(await withArrayBuffer.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Blob read failed")), { once: true });
    reader.readAsText(blob);
  });
}

function emptyCanvas(revision: number, projectId = "project /1"): DesignCanvas {
  return {
    schemaVersion: 2,
    projectId,
    revision,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: [],
    nodes: [],
    undoDepth: 0,
    redoDepth: 0,
    createdAt: 1,
    updatedAt: revision + 1,
  };
}

function designJob(overrides: Partial<DesignJob> = {}): DesignJob {
  return {
    schemaVersion: 2,
    id: "job-1",
    kind: "node-generation",
    runnerId: "fixture",
    model: null,
    status: "queued",
    nodeId: null,
    parentJobId: null,
    contextHash: null,
    canvasRevision: null,
    expectedHeadVersionId: null,
    versionId: null,
    exportId: null,
    error: null,
    cancelRequested: false,
    activity: [],
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    ...overrides,
  };
}

test("local images stay inline while videos stream before the atomic material-Node batch", async () => {
  const importUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/import";
  const uploadUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/uploads";
  const canvasUrl = "http://d/api/projects/project%20%2F1/design-canvas";
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") return jsonResponse(emptyCanvas(4));
    if (url === uploadUrl && method === "POST") return jsonResponse({ uploadedFileId: ".refs/design-upload-00000000-0000-4000-8000-000000000000", bytes: 2 }, 201);
    if (url === importUrl && method === "POST") return jsonResponse(emptyCanvas(5));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));

  await expect(api.importLocalFiles("project /1", [
    new File([new Uint8Array([1, 2, 3])], "hero.png", { type: "image/png" }),
    new File([new Uint8Array([4, 5])], "demo.mp4", { type: "video/mp4" }),
  ], { x: 100, y: 200 })).resolves.toEqual(emptyCanvas(5));

  expect(fetchImpl.mock.calls.map(([, init]) => requestMethod(init))).toEqual([
    "POST",
    "GET",
    "POST",
  ]);
  const request = jsonBody<{
    expectedRevision: number;
    items: Array<{ asset: unknown; binding: { type: "create-node"; node: { id: string } } }>;
  }>(
    fetchImpl.mock.calls[2]![1],
  );
  expect(request).toEqual({
    expectedRevision: 4,
    items: [
      {
        asset: { name: "hero.png", mimeType: "image/png", base64: "AQID" },
        binding: {
          type: "create-node",
          node: {
            id: expect.stringMatching(/^node-/),
            kind: "image",
            name: "hero.png",
            geometry: { x: 100, y: 200, width: 360, height: 260 },
          },
        },
      },
      {
        asset: {
          name: "demo.mp4",
          mimeType: "video/mp4",
          uploadedFileId: ".refs/design-upload-00000000-0000-4000-8000-000000000000",
        },
        binding: {
          type: "create-node",
          node: {
            id: expect.stringMatching(/^node-/),
            kind: "video",
            name: "demo.mp4",
            geometry: { x: 128, y: 228, width: 440, height: 280 },
          },
        },
      },
    ],
  });
});

test("image imports infer a missing MIME type and preserve portrait proportions in the Node frame", async () => {
  const importUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/import";
  const canvasUrl = "http://d/api/projects/project%20%2F1/design-canvas";
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1728, height: 2304, close })));
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") return jsonResponse(emptyCanvas(2));
    if (url === importUrl && method === "POST") return jsonResponse(emptyCanvas(3));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  try {
    const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));
    await api.importLocalFiles("project /1", [new File([new Uint8Array([1, 2, 3])], "portrait.webp")], { x: 40, y: 60 });

    const request = jsonBody<{
      items: Array<{ asset: { mimeType: string }; binding: { node: { geometry: unknown } } }>;
    }>(fetchImpl.mock.calls[1]![1]);
    expect(request.items[0]).toEqual(expect.objectContaining({
      asset: expect.objectContaining({ mimeType: "image/webp" }),
      binding: expect.objectContaining({
        node: expect.objectContaining({ geometry: { x: 40, y: 60, width: 270, height: 360 } }),
      }),
    }));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("extreme image imports preserve every storage-representable ratio without unbounded geometry", async () => {
  const importUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/import";
  const canvasUrl = "http://d/api/projects/project%20%2F1/design-canvas";
  const close = vi.fn();
  const sizes = new Map([
    ["wide.png", { width: 2_000, height: 100 }],
    ["tall.png", { width: 100, height: 2_000 }],
    ["impossible.png", { width: 10_000, height: 100 }],
  ]);
  vi.stubGlobal("createImageBitmap", vi.fn(async (file: File) => ({ ...sizes.get(file.name)!, close })));
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") return jsonResponse(emptyCanvas(2));
    if (url === importUrl && method === "POST") return jsonResponse(emptyCanvas(3));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  try {
    const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));
    await api.importLocalFiles("project /1", [
      new File([new Uint8Array([1])], "wide.png", { type: "image/png" }),
      new File([new Uint8Array([2])], "tall.png", { type: "image/png" }),
      new File([new Uint8Array([3])], "impossible.png", { type: "image/png" }),
    ], { x: 10, y: 20 });

    const request = jsonBody<{
      items: Array<{ binding: { node: { geometry: { width: number; height: number } } } }>;
    }>(fetchImpl.mock.calls[1]![1]);
    expect(request.items.map((item) => item.binding.node.geometry)).toEqual([
      expect.objectContaining({ width: 1_600, height: 80 }),
      expect.objectContaining({ width: 120, height: 2_400 }),
      expect.objectContaining({ width: 4_096, height: 80 }),
    ]);
    expect(request.items[0]!.binding.node.geometry.width / request.items[0]!.binding.node.geometry.height).toBe(20);
    expect(request.items[1]!.binding.node.geometry.width / request.items[1]!.binding.node.geometry.height).toBe(1 / 20);
    expect(close).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("an atomic local import retries only the conflicting batch with stable Node identity", async () => {
  const importUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/import";
  const canvasUrl = "http://d/api/projects/project%20%2F1/design-canvas";
  let canvasRead = 0;
  let imported = 0;
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") {
      const revision = canvasRead === 0 ? 7 : 8;
      canvasRead += 1;
      return jsonResponse(emptyCanvas(revision));
    }
    if (url === importUrl && method === "POST") {
      imported += 1;
      if (imported === 1) return jsonResponse({ error: "Canvas revision conflict" }, 409);
      return jsonResponse(emptyCanvas(9));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));

  await expect(api.importLocalFiles("project /1", [
    new File([new Uint8Array([0xff, 0xd8, 0xff])], "portrait.jpg", { type: "image/jpeg" }),
  ], { x: 24, y: 32 })).resolves.toEqual(emptyCanvas(9));

  expect(fetchImpl.mock.calls.map(([, init]) => requestMethod(init))).toEqual([
    "GET",
    "POST",
    "GET",
    "POST",
  ]);
  const importBodies = fetchImpl.mock.calls
    .filter(([input, init]) => String(input) === importUrl && requestMethod(init) === "POST")
    .map(([, init]) => jsonBody(init));
  expect(importBodies).toHaveLength(2);
  expect(importBodies[0]).toEqual(expect.objectContaining({ expectedRevision: 7 }));
  expect(importBodies[1]).toEqual(expect.objectContaining({ expectedRevision: 8 }));
  expect((importBodies[0] as { items: Array<{ binding: { node: { id: string } } }> }).items[0]!.binding.node.id)
    .toBe((importBodies[1] as { items: Array<{ binding: { node: { id: string } } }> }).items[0]!.binding.node.id);
});

test("adding a material revision imports one file against the latest Canvas head without creating another Node", async () => {
  const importUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/import";
  const canvasUrl = "http://d/api/projects/project%20%2F1/design-canvas";
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") return jsonResponse(emptyCanvas(8));
    if (url === importUrl && method === "POST") return jsonResponse(emptyCanvas(9));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));
  const replacement = new File([new Uint8Array([9, 8, 7])], "hero-final.png", { type: "image/png" });

  await expect(api.appendMaterialVersion("project /1", "image /1", replacement))
    .resolves.toEqual(emptyCanvas(9));

  expect(jsonBody(fetchImpl.mock.calls[1]![1])).toEqual({
    expectedRevision: 8,
    items: [{
      asset: { name: "hero-final.png", mimeType: "image/png", base64: "CQgH" },
      binding: { type: "append-version", nodeId: "image /1" },
    }],
  });
});

test("local import rejects oversized browser-held files before reading or sending them", async () => {
  const fetchImpl = vi.fn<FetchLike>();
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));
  const oversized = {
    name: "too-large.psd",
    type: "application/octet-stream",
    size: 32 * 1024 * 1024 + 1,
  } as File;

  await expect(api.importLocalFiles("project /1", [oversized], { x: 0, y: 0 }))
    .rejects.toThrow("must be between 1 byte and 32 MiB");
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("a resumed project-version import recognizes its deterministic Node and does not add a duplicate", async () => {
  const importUrl = "http://d/api/projects/project%20%2F1/design-canvas/assets/import";
  const canvasUrl = "http://d/api/projects/project%20%2F1/design-canvas";
  let resumed: DesignCanvas | null = null;
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") return jsonResponse(resumed ?? emptyCanvas(3));
    if (url === importUrl && method === "POST") {
      const request = jsonBody<{ items: Array<{ binding: { type: "create-node"; node: { id: string; kind: "document"; name: string; geometry: DesignCanvas["nodes"][number]["geometry"] } } }> }>(init);
      const imported = request.items[0]!.binding.node;
      resumed = emptyCanvas(4);
      resumed.nodeOrder = [imported.id];
      resumed.nodes = [{
        id: imported.id,
        kind: imported.kind,
        name: imported.name,
        geometry: imported.geometry,
        state: "ready",
        currentVersionId: null,
        selectedVersionId: null,
        versionCount: 0,
        assetId: "asset-project-version",
        activeJobId: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      }];
      return jsonResponse(resumed);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));
  const context = {
    kind: "project-version",
    title: "Source page",
    sourceProjectId: "source-project",
    sourceNodeId: "source-node",
    sourceVersionId: "source-version",
  } as const;

  const first = await api.importProjectVersion("project /1", context, { x: 24, y: 32 });
  expect(first).toEqual(resumed);
  await expect(api.importProjectVersion("project /1", context, { x: 24, y: 32 })).resolves.toEqual(resumed);

  expect(fetchImpl.mock.calls.map(([, init]) => requestMethod(init))).toEqual(["GET", "POST", "GET"]);
});

test("a project version becomes an isolated UTF-8 descriptor and one document node", async () => {
  const importUrl = "http://d/api/projects/target%20%2Fproject/design-canvas/assets/import";
  const canvasUrl = "http://d/api/projects/target%20%2Fproject/design-canvas";
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input);
    const method = requestMethod(init);
    if (url === canvasUrl && method === "GET") return jsonResponse(emptyCanvas(3, "target /project"));
    if (url === importUrl && method === "POST") return jsonResponse(emptyCanvas(4, "target /project"));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));
  const context = {
    kind: "project-version",
    title: "结账 Café",
    sourceProjectId: "source-project",
    sourceNodeId: "source-node",
    sourceVersionId: "source-version",
  } as const;

  await expect(api.importProjectVersion("target /project", context, { x: 64, y: 96 }))
    .resolves.toEqual(emptyCanvas(4, "target /project"));

  const importCalls = fetchImpl.mock.calls
    .filter(([input, init]) => String(input) === importUrl && requestMethod(init) === "POST");
  expect(importCalls).toHaveLength(1);
  expect(jsonBody(importCalls[0]![1])).toEqual({
    expectedRevision: 3,
    items: [{
      asset: {
        name: "结账 Café.html",
        mimeType: "text/html",
        sourceVersion: {
          projectId: "source-project",
          nodeId: "source-node",
          versionId: "source-version",
        },
      },
      binding: {
        type: "create-node",
        node: {
          id: expect.stringMatching(/^node-context-version-[a-f0-9]{16}$/),
          kind: "document",
          name: "结账 Café",
          geometry: { x: 64, y: 96, width: 320, height: 190 },
        },
      },
    }],
  });
});

test("Agent turns map prompt and selection onto the exact node-scoped wire contract", async () => {
  const result = {
    thread: {
      id: "thread-1",
      scope: { type: "node" as const, nodeId: "node /1" },
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
    job: designJob({ nodeId: "node /1" }),
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(result, 202));
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));

  await expect(api.submitAgentTurn("project /1", { type: "node", nodeId: "node /1" }, {
    prompt: "Refine the hierarchy",
    context: { nodeIds: ["context /1", "context-2"] },
    agentCommand: "codex",
    model: "gpt-5",
  })).resolves.toEqual(result);

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]![0]).toBe(
    "http://d/api/projects/project%20%2F1/design-canvas/nodes/node%20%2F1/agent/turns",
  );
  expect(requestMethod(fetchImpl.mock.calls[0]![1])).toBe("POST");
  expect(jsonBody(fetchImpl.mock.calls[0]![1])).toEqual({
    message: "Refine the hierarchy",
    context: { nodeIds: ["context /1", "context-2"] },
    agentCommand: "codex",
    model: "gpt-5",
  });
});

test("Agent turns preserve an explicit provider-default model on the wire", async () => {
  const result = {
    thread: {
      id: "thread-1",
      scope: { type: "main" as const },
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
    job: designJob({ nodeId: null, kind: "main-agent" }),
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(result, 202));
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));

  await api.submitAgentTurn("project-1", { type: "main" }, {
    prompt: "Use the provider default",
    context: { nodeIds: [] },
    agentCommand: "codebuddy",
    model: null,
  });

  expect(jsonBody(fetchImpl.mock.calls[0]![1])).toEqual({
    message: "Use the provider default",
    context: { nodeIds: [] },
    agentCommand: "codebuddy",
    model: null,
  });
});

test("exact preview identities and implementation export revisions are never replaced by latest state", async () => {
  const exportResult = {
    exportId: "export-42",
    job: designJob({
      id: "job-export",
      kind: "implementation-export",
      exportId: "export-42",
    }),
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(exportResult, 202));
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));

  await expect(api.getExactVersionPreview("project /1", "node /1", "version /9")).resolves.toEqual({
    nodeId: "node /1",
    versionId: "version /9",
    url: "http://d/api/projects/project%20%2F1/design-canvas/nodes/node%20%2F1/versions/version%20%2F9/preview/",
  });
  expect(fetchImpl).not.toHaveBeenCalled();

  await expect(api.startImplementationExport("project /1", 42, {
    agentCommand: "claude",
    model: "sonnet",
  })).resolves.toEqual(exportResult);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]![0]).toBe(
    "http://d/api/projects/project%20%2F1/design-canvas/exports",
  );
  expect(requestMethod(fetchImpl.mock.calls[0]![1])).toBe("POST");
  expect(jsonBody(fetchImpl.mock.calls[0]![1])).toEqual({
    canvasRevision: 42,
    agentCommand: "claude",
    model: "sonnet",
  });
});

test("portable exact-version HTML is downloaded as daemon-authored bytes with authenticated failure semantics", async () => {
  const portable = "<!doctype html><html><body><img src=\"data:image/png;base64,AQID\"></body></html>";
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    expect(String(input)).toBe(
      "http://d/api/projects/project%20%2F1/design-canvas/nodes/node%20%2F1/versions/version%20%2F9/preview/download",
    );
    expect(init?.headers).toMatchObject({ "x-dezin-daemon-token": "secret" });
    return new Response(portable, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "secret" }));

  const downloaded = await api.downloadExactVersionHtml("project /1", "node /1", "version /9");

  expect(downloaded.type).toBe("text/html;charset=utf-8");
  expect(await readBlobText(downloaded)).toBe(portable);
});

test("failed Design Jobs retry through their immutable daemon identity without rebuilding the prompt in Web", async () => {
  const retryResult = {
    retryOfJobId: "job-failed",
    job: designJob({ id: "job-retry", status: "queued" }),
    thread: { id: "thread-1", scope: { type: "main" as const }, messages: [], createdAt: 1, updatedAt: 2 },
    canvas: emptyCanvas(8, "project /1"),
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(retryResult, 202));
  const api = createDesignCanvasApi(createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "" }));

  await expect(api.retryJob("project /1", "job /failed")).resolves.toEqual(retryResult);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]![0]).toBe(
    "http://d/api/projects/project%20%2F1/design-canvas/jobs/job%20%2Ffailed/retry",
  );
  expect(requestMethod(fetchImpl.mock.calls[0]![1])).toBe("POST");
  expect(jsonBody(fetchImpl.mock.calls[0]![1])).toEqual({});
});
