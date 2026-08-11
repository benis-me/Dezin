import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import type { FigmaImportAnchor, FigmaImportInput } from "../design-canvas/types.ts";
import { ApiError } from "../lib/api.ts";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { FigmaImportDialog } from "./FigmaImportDialog.tsx";

const FIGMA_URL = "https://www.figma.com/design/AbCdEf123456/Checkout?node-id=12-34";
const PENDING_KEY = "dezin:figma-import-intent:v1";

afterEach(() => {
  cleanup();
  localStorage.removeItem(PENDING_KEY);
});

async function fillImportForm(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Figma file URL" }), FIGMA_URL);
  await user.click(screen.getByRole("checkbox", {
    name: "I have permission to import and use this Figma file",
  }));
  await user.click(screen.getByRole("button", { name: "Import into canvas" }));
}

test("a failed project-scoped import preserves the Figma URL and frozen rounded anchor", async () => {
  const anchor = { x: 321, y: 260 };
  const importFigmaProject = vi.fn(async (_projectId: string, _input: FigmaImportInput, _signal?: AbortSignal) => {
    throw new Error("connection lost");
  });
  render(
    <ApiProvider client={makeFakeApi({ importFigmaProject })}>
      <FigmaImportDialog
        open
        projectId="project-a"
        anchor={anchor}
        onClose={() => undefined}
        onImported={() => undefined}
      />
    </ApiProvider>,
  );

  await fillImportForm();

  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't import this Figma file");
  expect(screen.getByRole("textbox", { name: "Figma file URL" })).toHaveValue(FIGMA_URL);
  expect(screen.getByRole("checkbox", {
    name: "I have permission to import and use this Figma file",
  })).toBeChecked();
  expect(importFigmaProject).toHaveBeenCalledWith(
    "project-a",
    expect.objectContaining({
      anchor,
      nodeIds: ["12:34"],
      rightsAcknowledged: true,
    }),
    expect.any(AbortSignal),
  );
});

test("pending Figma idempotency is reused only for the same project and anchor", async () => {
  const importFigmaProject = vi.fn(async (_projectId: string, _input: FigmaImportInput, _signal?: AbortSignal) => {
    throw new Error("response lost");
  });
  const submit = async (projectId: string, anchor: FigmaImportAnchor): Promise<string> => {
    const view = render(
      <ApiProvider client={makeFakeApi({ importFigmaProject })}>
        <FigmaImportDialog
          open
          projectId={projectId}
          anchor={anchor}
          onClose={() => undefined}
          onImported={() => undefined}
        />
      </ApiProvider>,
    );
    await fillImportForm();
    await screen.findByRole("alert");
    const key = importFigmaProject.mock.calls.at(-1)?.[1].idempotencyKey;
    view.unmount();
    if (!key) throw new Error("Expected a pending Figma key");
    return key;
  };

  const first = await submit("project-a", { x: 321, y: 260 });
  const restarted = await submit("project-a", { x: 321, y: 260 });
  const otherProject = await submit("project-b", { x: 321, y: 260 });
  const otherAnchor = await submit("project-b", { x: 322, y: 260 });

  expect(restarted).toBe(first);
  expect(otherProject).not.toBe(restarted);
  expect(otherAnchor).not.toBe(otherProject);
  await waitFor(() => expect(importFigmaProject).toHaveBeenCalledTimes(4));
});

test("a missing PAT is stored before one project-scoped single-flight import", async () => {
  const user = userEvent.setup();
  const order: string[] = [];
  const fallbackApi = makeFakeApi();
  const setFigmaCredential = vi.fn(async ({ token }: { token: string }) => {
    order.push(`credential:${token}`);
    return { configured: true as const, source: "local" as const };
  });
  const importFigmaProject = vi.fn(async (
    projectId: string,
    input: FigmaImportInput,
    signal?: AbortSignal,
  ) => {
    order.push("import");
    return fallbackApi.importFigmaProject(projectId, input, signal);
  });
  const onImported = vi.fn();
  render(
    <ApiProvider client={makeFakeApi({
      getFigmaCredential: async () => ({ configured: false, source: null }),
      setFigmaCredential,
      importFigmaProject,
    })}>
      <FigmaImportDialog
        open
        projectId="project-a"
        anchor={{ x: 321, y: 260 }}
        onClose={() => undefined}
        onImported={onImported}
      />
    </ApiProvider>,
  );

  await user.type(screen.getByRole("textbox", { name: "Figma file URL" }), FIGMA_URL);
  await user.type(await screen.findByLabelText("Figma personal access token"), "figd_local_secret");
  await user.click(screen.getByRole("checkbox", {
    name: "I have permission to import and use this Figma file",
  }));
  const submit = screen.getByRole("button", { name: "Import into canvas" });
  fireEvent.click(submit);
  fireEvent.click(submit);

  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  expect(order).toEqual(["credential:figd_local_secret", "import"]);
  expect(setFigmaCredential).toHaveBeenCalledTimes(1);
  expect(importFigmaProject).toHaveBeenCalledTimes(1);
  expect(importFigmaProject).toHaveBeenCalledWith(
    "project-a",
    expect.objectContaining({
      anchor: { x: 321, y: 260 },
      nodeIds: ["12:34"],
      rightsAcknowledged: true,
    }),
    expect.any(AbortSignal),
  );
});

test("an ambiguous retry keeps its key until success and the next explicit import gets a new key", async () => {
  const user = userEvent.setup();
  const fallbackApi = makeFakeApi();
  const importFigmaProject = vi.fn()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockImplementation((projectId: string, input: FigmaImportInput, signal?: AbortSignal) => (
      fallbackApi.importFigmaProject(projectId, input, signal)
    ));
  const onImported = vi.fn();
  render(
    <ApiProvider client={makeFakeApi({ importFigmaProject })}>
      <FigmaImportDialog
        open
        projectId="project-a"
        anchor={{ x: 321, y: 260 }}
        onClose={() => undefined}
        onImported={onImported}
      />
    </ApiProvider>,
  );

  await user.type(screen.getByRole("textbox", { name: "Figma file URL" }), FIGMA_URL);
  await user.click(screen.getByRole("checkbox", {
    name: "I have permission to import and use this Figma file",
  }));
  await user.click(screen.getByRole("button", { name: "Import into canvas" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't import this Figma file");

  await user.click(screen.getByRole("button", { name: "Import into canvas" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  const firstKey = importFigmaProject.mock.calls[0]?.[1].idempotencyKey;
  const retryKey = importFigmaProject.mock.calls[1]?.[1].idempotencyKey;
  expect(retryKey).toBe(firstKey);

  await user.type(screen.getByRole("textbox", { name: "Figma file URL" }), FIGMA_URL);
  await user.click(screen.getByRole("checkbox", {
    name: "I have permission to import and use this Figma file",
  }));
  await user.click(screen.getByRole("button", { name: "Import into canvas" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
  expect(importFigmaProject.mock.calls[2]?.[1].idempotencyKey).not.toBe(retryKey);
});

test("Cancel import aborts the live request without reporting a completed import", async () => {
  let requestSignal: AbortSignal | undefined;
  const importFigmaProject = vi.fn((
    _projectId: string,
    _input: FigmaImportInput,
    signal?: AbortSignal,
  ) => new Promise<never>((_resolve, reject) => {
    requestSignal = signal;
    signal?.addEventListener("abort", () => {
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true });
  }));
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(
    <ApiProvider client={makeFakeApi({ importFigmaProject })}>
      <FigmaImportDialog
        open
        projectId="project-a"
        anchor={{ x: 321, y: 260 }}
        onClose={onClose}
        onImported={onImported}
      />
    </ApiProvider>,
  );

  await fillImportForm();
  await waitFor(() => expect(importFigmaProject).toHaveBeenCalledTimes(1));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Cancel import" }));

  expect(requestSignal?.aborted).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onImported).not.toHaveBeenCalled();
});

test("URL, rights, and credential status boundaries remain actionable in the Canvas dialog", async () => {
  const user = userEvent.setup();
  const getFigmaCredential = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ configured: true as const, source: "local" as const });
  const setFigmaCredential = vi.fn(async () => ({
    configured: true as const,
    source: "local" as const,
  }));
  const importFigmaProject = vi.fn()
    .mockRejectedValueOnce(new ApiError(503, "Figma access is not configured."))
    .mockRejectedValueOnce(new ApiError(403, "Figma rejected this personal access token or its scopes."));
  render(
    <ApiProvider client={makeFakeApi({
      getFigmaCredential,
      setFigmaCredential,
      importFigmaProject,
    })}>
      <FigmaImportDialog
        open
        projectId="project-a"
        anchor={{ x: 321, y: 260 }}
        onClose={() => undefined}
        onImported={() => undefined}
      />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check Figma access");
  await user.click(screen.getByRole("button", { name: "Retry Figma access" }));
  expect(await screen.findByText("Personal access token stored locally")).toBeInTheDocument();

  const url = screen.getByRole("textbox", { name: "Figma file URL" });
  const submit = screen.getByRole("button", { name: "Import into canvas" });
  await user.type(url, "https://secret@www.figma.com:444/design/MainKey1/File#fragment");
  await user.tab();
  expect(url).toHaveAttribute("aria-invalid", "true");
  expect(submit).toBeDisabled();

  await user.clear(url);
  await user.type(url, "https://www.figma.com/design/MainKey1/Versioned?version-id=123:456");
  expect(screen.getByText("Version-specific Figma links aren't supported. Remove version-id to import the current file.")).toBeInTheDocument();
  expect(submit).toBeDisabled();

  const validUrl = "https://www.figma.com/design/MainKey1/branch/BranchKey2/Branch-Name";
  await user.clear(url);
  await user.type(url, validUrl);
  expect(submit).toBeDisabled();
  const rights = screen.getByRole("checkbox", {
    name: "I have permission to import and use this Figma file",
  });
  await user.click(rights);
  expect(submit).toBeEnabled();

  await user.click(submit);
  expect(await screen.findByText(/FIGMA_ACCESS_TOKEN/)).toBeInTheDocument();
  expect(url).toHaveValue(validUrl);
  expect(rights).toBeChecked();

  await user.type(await screen.findByLabelText("Figma personal access token"), "figd_replacement_secret");
  await user.click(screen.getByRole("button", { name: "Import into canvas" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Figma rejected this personal access token");
  expect(screen.getByRole("button", { name: "Forget credential" })).toBeInTheDocument();
  expect(setFigmaCredential).toHaveBeenCalledWith(
    { token: "figd_replacement_secret" },
    expect.any(AbortSignal),
  );
});
