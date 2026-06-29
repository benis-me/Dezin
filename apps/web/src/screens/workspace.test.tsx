import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, afterEach, beforeEach, vi } from "vitest";
import { WorkspaceScreen } from "./WorkspaceScreen.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type { RunEvent } from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";

beforeEach(() => window.history.pushState({}, "", "/projects/p1"));
afterEach(cleanup);

test("sending a brief streams events into the chat and shows the preview + export", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r1", conversationId: "c1" };
      yield { type: "turn-end", round: 0, text: "Built your hero section." };
      yield {
        type: "run-done",
        runId: "r1",
        passed: true,
        rounds: 0,
        previewUrl: "/projects/p1/preview/",
        findings: [],
      };
    },
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "make a hero" } });
  fireEvent.click(screen.getByLabelText("Send"));

  // user message + streamed assistant text + done status
  expect(await screen.findByText("Built your hero section.")).toBeInTheDocument();
  expect(screen.getByText("make a hero")).toBeInTheDocument();
  expect(screen.getByText(/^Done/)).toBeInTheDocument();

  // preview iframe gets the previewUrl src
  const iframe = await screen.findByTitle("Artifact preview");
  expect(iframe.getAttribute("src") ?? "").toMatch(/^\/projects\/p1\/preview\//);
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-downloads");

  // export link points at the export endpoint
  const exportLink = screen.getByRole("link", { name: /export/i });
  expect(exportLink).toHaveAttribute("href", "/api/projects/p1/export");
});

test("rehydrates the prior transcript and reuses the conversation on the next run", async () => {
  const streamRun = vi.fn((input: { conversationId?: string }) => {
    void input;
    return (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "turn-end", round: 0, text: "Continued." };
      yield { type: "run-done", runId: "r", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })();
  });
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user" as const, content: "make a hero", createdAt: 1 },
      { id: "m2", conversationId: "c1", role: "assistant" as const, content: "Built it.", createdAt: 2 },
    ],
    streamRun: streamRun as never,
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  // prior transcript is rehydrated on mount
  expect(await screen.findByText("make a hero")).toBeInTheDocument();
  expect(screen.getByText("Built it.")).toBeInTheDocument();

  // a new message reuses the rehydrated conversation id
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "tweak it" } });
  fireEvent.click(screen.getByLabelText("Send"));
  expect(await screen.findByText("Continued.")).toBeInTheDocument();
  expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1", brief: "tweak it" }), expect.anything());
});

test("conversation switcher lists conversations and switches between them", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [
      { id: "c1", projectId: "p1", title: "First", createdAt: 1 },
      { id: "c2", projectId: "p1", title: "Second", createdAt: 2 },
    ],
    listMessages: async (_pid: string, cid: string) =>
      cid === "c1"
        ? [{ id: "m1", conversationId: "c1", role: "user" as const, content: "first message", createdAt: 1 }]
        : [{ id: "m2", conversationId: "c2", role: "user" as const, content: "second message", createdAt: 1 }],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  // defaults to the latest conversation (c2)
  expect(await screen.findByText("second message")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Conversation switcher" }));
  await user.click(await screen.findByText("First"));
  expect(await screen.findByText("first message")).toBeInTheDocument();
});

test("New conversation creates one and clears the transcript", async () => {
  const createConversation = vi.fn(async () => ({ id: "c3", projectId: "p1", title: "Untitled", createdAt: 3 }));
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [{ id: "m1", conversationId: "c1", role: "user" as const, content: "old message", createdAt: 1 }],
    createConversation,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  expect(await screen.findByText("old message")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("New conversation"));
  await waitFor(() => expect(screen.queryByText("old message")).toBeNull());
  expect(createConversation).toHaveBeenCalledWith("p1");
});

test("the Files tab lists project files and Code shows the selected file's source", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [],
    listFiles: async () => [
      { path: "index.html", size: 120 },
      { path: "assets/style.css", size: 40 },
    ],
    getFileText: async (_id: string, path: string) =>
      path === "index.html" ? "<h1>Hello</h1>" : ":root{--accent:#101010}",
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await screen.findByText("index.html")).toBeInTheDocument();
  // assets is a folder at root; double-click into it, then open the file
  expect(screen.getByText("assets")).toBeInTheDocument();
  fireEvent.doubleClick(screen.getByText("assets"));
  fireEvent.click(await screen.findByText("style.css"));
  expect(await screen.findByText(/--accent:#101010/)).toBeInTheDocument();
});

test("the History tab lists versions with View + Restore", async () => {
  const restoreVersion = vi.fn(async () => {});
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [],
    listRuns: async () => [
      { id: "r2", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000001000, finishedAt: 1700000001001 },
      { id: "r1", status: "succeeded" as const, score: 92, repairRounds: 1, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
    ],
    restoreVersion,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "History" }));
  expect(await screen.findByText("92/100")).toBeInTheDocument();
  // the newest version has no Restore (it IS current); the older one does
  fireEvent.click(screen.getByRole("button", { name: "Restore v1" }));
  await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith("p1", "r1"));
});

test("the Quality tab surfaces the run's lint findings + fix", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r1", conversationId: "c1" };
      yield {
        type: "lint",
        findings: [
          { severity: "P1", id: "text-justify", message: "Avoid text-align: justify on the web.", fix: "Use text-align: left." },
        ],
      };
      yield { type: "run-done", runId: "r1", passed: true, rounds: 1 };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByTitle("Artifact preview");
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/text-align: justify/)).toBeInTheDocument();
  expect(screen.getByText(/Use text-align: left/)).toBeInTheDocument();
});

test("a clean run shows the Quality pane's clean empty state", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r2", conversationId: "c1" };
      yield { type: "run-done", runId: "r2", passed: true, rounds: 0, score: 100 };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByTitle("Artifact preview");
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/No anti-slop issues\. Clean/)).toBeInTheDocument();
  expect(screen.getAllByText("100/100").length).toBeGreaterThan(0); // shown in the score header (and result card)
});

test("repair rounds surface a lint status line", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "turn-end", round: 0, text: "First draft." };
      yield { type: "lint", round: 1, findings: [{ id: "ai-default-indigo" }] };
      yield { type: "turn-start", round: 1, isRepair: true };
      yield { type: "turn-end", round: 1, text: "Fixed it." };
      yield { type: "run-done", runId: "r", passed: true, rounds: 1, previewUrl: "/projects/p1/preview/", findings: [] };
    },
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));

  // intermediate "Found N issues" status is transient; the result card records the run
  expect(await screen.findByText("Fixed it.")).toBeInTheDocument();
  expect(await screen.findByText(/after 1 fix/)).toBeInTheDocument();
});
