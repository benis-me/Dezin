import { expect, test, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  parseSseBlock,
  type FetchLike,
} from "./api.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(blocks: readonly string[]): Response {
  return new Response(`${blocks.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

const PROJECT = {
  id: "project-1",
  name: "Canvas project",
  createdAt: 1,
  updatedAt: 1,
};

test("project creation uses the current empty-canvas defaults", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(PROJECT, 201));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });

  await expect(api.createProject({
    name: "Canvas project",
  })).resolves.toEqual(PROJECT);

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/projects",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Canvas project",
      }),
    }),
  );
});

test("Home bootstrap posts one durable Project request", async () => {
  const bootstrap = {
    project: PROJECT,
    bootstrap: {
      job: {
        schemaVersion: 1 as const,
        id: "bootstrap-1",
        projectId: PROJECT.id,
        requestHash: "a".repeat(64),
        status: "ready" as const,
        completedPhase: "ready" as const,
        mainJobId: "job-main",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
      reused: false,
    },
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(bootstrap, 201));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "home-web-0001",
    name: "Canvas project",
    prompt: "Create the page",
    items: [],
  };

  await expect(api.bootstrapDesignProject(input)).resolves.toEqual(bootstrap);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/projects/bootstrap",
    expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
  );
});

test("Figma import posts only the frozen import DTO and supports cancellation", async () => {
  const result = { project: PROJECT, import: { manifest: { importId: "figma-1" }, reused: false } };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(result, 201));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const controller = new AbortController();
  const input = {
    schemaVersion: 1 as const,
    idempotencyKey: "figma-web-0001",
    url: "https://www.figma.com/design/AbCdEf123456/Checkout?node-id=12-34",
    nodeIds: ["12:34"],
    rightsAcknowledged: true as const,
  };

  await expect(api.importFigmaProject(input, controller.signal)).resolves.toEqual(result);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/projects/imports/figma",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(input),
      signal: controller.signal,
    }),
  );
});

test("Figma credential lifecycle keeps the PAT on its dedicated local-daemon endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (_input, init) => jsonResponse({
    configured: init?.method !== "DELETE",
    source: init?.method === "DELETE" ? null : "local",
  }));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const controller = new AbortController();

  await api.getFigmaCredential(controller.signal);
  await api.setFigmaCredential({ token: "figd_secret" }, controller.signal);
  await api.forgetFigmaCredential(controller.signal);

  expect(fetchImpl.mock.calls).toEqual([
    ["http://daemon/api/figma/credential", expect.objectContaining({ signal: controller.signal })],
    ["http://daemon/api/figma/credential", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ token: "figd_secret" }),
      signal: controller.signal,
    })],
    ["http://daemon/api/figma/credential", expect.objectContaining({ method: "DELETE", signal: controller.signal })],
  ]);
});

test("current project lifecycle endpoints encode project ids", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (_input, init) =>
    init?.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(PROJECT));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });

  await api.getProject("project /1");
  await api.patchProject("project /1", { name: "Renamed" });
  await api.deleteProject("project /1");

  expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
    "http://daemon/api/projects/project%20%2F1",
    "http://daemon/api/projects/project%20%2F1",
    "http://daemon/api/projects/project%20%2F1",
  ]);
  expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
    method: "PATCH",
    body: JSON.stringify({ name: "Renamed" }),
  }));
  expect(fetchImpl.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
});

test("Design Canvas source-version assets use only project, node, and version identity", async () => {
  const asset = {
    id: "asset-source-version",
    name: "Checkout.html",
    mimeType: "text/html",
    checksum: "a".repeat(64),
    bytes: 42,
    createdAt: 1,
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(asset, 201));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });

  await expect(api.createDesignCanvasAsset("target /project", {
    name: "Checkout.html",
    mimeType: "text/html",
    sourceVersion: {
      projectId: "source-project",
      nodeId: "node-checkout",
      versionId: "version-4",
    },
  })).resolves.toEqual(asset);

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/projects/target%20%2Fproject/design-canvas/assets",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Checkout.html",
        mimeType: "text/html",
        sourceVersion: {
          projectId: "source-project",
          nodeId: "node-checkout",
          versionId: "version-4",
        },
      }),
    }),
  );
});

test("daemon token is attached to authenticated current endpoints", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([]));
  const api = createApiClient({
    baseUrl: "http://daemon",
    fetchImpl,
    daemonToken: "tok_canvas",
  });

  await api.listProjects();

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/projects",
    expect.objectContaining({ headers: expect.objectContaining({ "x-dezin-daemon-token": "tok_canvas" }) }),
  );
});

test("JSON API errors retain status and structured details", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({
    error: "Canvas revision conflict",
    expectedRevision: 4,
  }, 409));
  const api = createApiClient({ fetchImpl });

  const error = await api.getDesignCanvas("project-1").catch((value: unknown) => value);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 409,
    message: "Canvas revision conflict",
    details: { expectedRevision: 4 },
  });
});

test("parseSseBlock joins multiline JSON data and ignores malformed payloads", () => {
  expect(parseSseBlock<{ type: string }>('event: status\ndata: {"type":\ndata: "ready"}')).toEqual({
    type: "ready",
  });
  expect(parseSseBlock("data: {not-json")).toBeNull();
});

test("Design invalidation fetch streams authenticate and resume with Last-Event-ID", async () => {
  const reset = {
    type: "reset",
    cursor: "epoch-a:4",
    epoch: "epoch-a",
    sequence: 4,
    reason: "initial",
  } as const;
  const invalidation = {
    type: "invalidate",
    cursor: "epoch-a:5",
    epoch: "epoch-a",
    sequence: 5,
    topics: ["canvas", "jobs"],
  } as const;
  const fetchImpl = vi.fn<FetchLike>()
    .mockResolvedValueOnce(sseResponse([
      `id: ${reset.cursor}\nevent: reset\ndata: ${JSON.stringify(reset)}`,
    ]))
    .mockResolvedValueOnce(sseResponse([
      `id: ${invalidation.cursor}\nevent: invalidate\ndata: ${JSON.stringify(invalidation)}`,
    ]));
  const api = createApiClient({
    baseUrl: "http://daemon",
    daemonToken: "canvas-token",
    fetchImpl,
  });
  const controller = new AbortController();
  const stream = api.streamDesignCanvasInvalidations("project /1", controller.signal);

  await expect(stream.next()).resolves.toEqual({ done: false, value: reset });
  await expect(stream.next()).resolves.toEqual({ done: false, value: invalidation });
  controller.abort();
  await stream.return(undefined);

  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[0]).toEqual([
    "http://daemon/api/projects/project%20%2F1/design-canvas/events",
    expect.objectContaining({
      signal: controller.signal,
      headers: expect.objectContaining({ "x-dezin-daemon-token": "canvas-token" }),
    }),
  ]);
  expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
    headers: expect.objectContaining({
      "x-dezin-daemon-token": "canvas-token",
      "Last-Event-ID": reset.cursor,
    }),
  }));
});

test("Design invalidation streams retain their cursor across a transient fetch disconnect", async () => {
  const reset = {
    type: "reset",
    cursor: "epoch-b:2",
    epoch: "epoch-b",
    sequence: 2,
    reason: "initial",
  } as const;
  const invalidation = {
    type: "invalidate",
    cursor: "epoch-b:3",
    epoch: "epoch-b",
    sequence: 3,
    topics: ["thread:main"],
  } as const;
  const fetchImpl = vi.fn<FetchLike>()
    .mockResolvedValueOnce(sseResponse([
      `id: ${reset.cursor}\nevent: reset\ndata: ${JSON.stringify(reset)}`,
    ]))
    .mockRejectedValueOnce(new TypeError("socket reset"))
    .mockResolvedValueOnce(sseResponse([
      `id: ${invalidation.cursor}\nevent: invalidate\ndata: ${JSON.stringify(invalidation)}`,
    ]));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const controller = new AbortController();
  const stream = api.streamDesignCanvasInvalidations("project-1", controller.signal);

  expect((await stream.next()).value).toEqual(reset);
  expect((await stream.next()).value).toEqual(invalidation);
  controller.abort();
  await stream.return(undefined);

  expect(fetchImpl).toHaveBeenCalledTimes(3);
  for (const call of fetchImpl.mock.calls.slice(1)) {
    expect(call[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "Last-Event-ID": reset.cursor }),
    }));
  }
});

test("Design invalidation streams discard non-canonical cursors, topics, duplicates, and fields", async () => {
  const malformed = [
    {
      type: "invalidate",
      cursor: "epoch-c:99",
      epoch: "epoch-c",
      sequence: 1,
      topics: ["canvas"],
    },
    {
      type: "invalidate",
      cursor: "epoch c:2",
      epoch: "epoch c",
      sequence: 2,
      topics: ["jobs"],
    },
    {
      type: "invalidate",
      cursor: "epoch-c:3",
      epoch: "epoch-c",
      sequence: 3,
      topics: ["thread:node:../../escape"],
    },
    {
      type: "invalidate",
      cursor: "epoch-c:4",
      epoch: "epoch-c",
      sequence: 4,
      topics: ["canvas"],
      unexpected: true,
    },
    {
      type: "invalidate",
      cursor: "epoch-c:5",
      epoch: "epoch-c",
      sequence: 5,
      topics: ["canvas", "canvas"],
    },
  ];
  const valid = {
    type: "invalidate",
    cursor: "epoch-c:6",
    epoch: "epoch-c",
    sequence: 6,
    topics: ["thread:node:node-safe_1", "jobs"],
  } as const;
  const blocks = [
    ...malformed.map((message) => (
      `id: ${message.cursor}\nevent: invalidate\ndata: ${JSON.stringify(message)}`
    )),
    `id: ${valid.cursor}\nevent: invalidate\ndata: ${JSON.stringify(valid)}`,
  ];
  const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(sseResponse(blocks));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const controller = new AbortController();
  const stream = api.streamDesignCanvasInvalidations("project-1", controller.signal);

  const first = await stream.next();
  controller.abort();
  await stream.return(undefined);

  expect(first).toEqual({ done: false, value: valid });
});

test("prompt optimization carries only the selected Agent fields supplied by Home", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ prompt: "Sharper prompt" }));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });

  await expect(api.optimizePrompt({
    prompt: "Draft",
    agentCommand: "codex",
    model: "gpt-5",
  })).resolves.toEqual({ prompt: "Sharper prompt" });

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/prompts/optimize",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ prompt: "Draft", agentCommand: "codex", model: "gpt-5" }),
    }),
  );
});
