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
