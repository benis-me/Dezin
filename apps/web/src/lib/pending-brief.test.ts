import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  setPendingDesignWorkspaceTurn,
  takePendingDesignWorkspaceTurn,
} from "./pending-brief.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

test("a pending Design Workspace turn is project-scoped and consumed once", () => {
  const pending = {
    projectId: "project-new",
    brief: "Build a complete music workspace",
    agentCommand: "codebuddy",
    model: "hunyuan",
  };
  setPendingDesignWorkspaceTurn(pending);

  expect(takePendingDesignWorkspaceTurn("project-unrelated")).toBeNull();
  expect(takePendingDesignWorkspaceTurn("project-new")).toEqual(pending);
  expect(takePendingDesignWorkspaceTurn("project-new")).toBeNull();
});

test("a pending Design Workspace turn survives a renderer reload and is still consumed once", async () => {
  const pending = {
    projectId: "project-reload",
    brief: "Build a complete editorial workspace",
    agentCommand: "codebuddy",
    model: "gpt-5.6-sol",
  };
  const beforeReload = await import("./pending-brief.ts");
  beforeReload.setPendingDesignWorkspaceTurn(pending);

  vi.resetModules();
  const afterReload = await import("./pending-brief.ts");

  expect(afterReload.takePendingDesignWorkspaceTurn("project-unrelated")).toBeNull();
  expect(afterReload.takePendingDesignWorkspaceTurn("project-reload")).toEqual(pending);

  vi.resetModules();
  const afterConsumptionReload = await import("./pending-brief.ts");
  expect(afterConsumptionReload.takePendingDesignWorkspaceTurn("project-reload")).toBeNull();
});
