import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, afterEach, beforeEach, vi } from "vitest";
import { computeMarkupPosition, WorkspaceScreen } from "./WorkspaceScreen.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type { RunEvent } from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { takePendingAgent, takePendingBrief, takePendingModel } from "../lib/pending-brief.ts";

beforeEach(() => {
  window.history.pushState({}, "", "/projects/p1");
  takePendingBrief();
  takePendingAgent();
  takePendingModel();
  localStorage.removeItem("dezin.workspace.queue.p1");
});
afterEach(cleanup);

const AGENTS = [
  { id: "claude", command: "claude", available: true, version: "claude 1.2.3", models: ["opus", "sonnet"] },
  { id: "codex", command: "codex", available: true, version: "codex 1.0.0", models: ["gpt-5"] },
];

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

test("mount reattaches the latest running run and replays its stream", async () => {
  const reattachRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {
    yield { type: "run-start", runId: "r-live", conversationId: "c1" };
    yield { type: "turn-start", round: 0, isRepair: false };
    yield { type: "turn-end", round: 0, text: "Recovered streamed text." };
    yield { type: "run-done", runId: "r-live", passed: true, rounds: 0, score: 100, previewUrl: "/projects/p1/preview/", findings: [] };
  });
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [],
    listRuns: async () => [
      { id: "r-live", conversationId: "c1", status: "running", score: null, repairRounds: 0, lintPassed: false, createdAt: 2, finishedAt: null },
    ],
    reattachRun,
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  expect(await screen.findByText("Recovered streamed text.")).toBeInTheDocument();
  expect(reattachRun).toHaveBeenCalledWith("r-live", expect.anything());
  expect(await screen.findByText(/Done, quality 100\/100/)).toBeInTheDocument();
});

test("mount replays an interrupted run log after daemon restart", async () => {
  const reattachRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {
    yield { type: "run-start", runId: "r-interrupted", conversationId: "c1" };
    yield { type: "turn-end", round: 0, text: "Partial text before quit." };
  });
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [],
    listRuns: async () => [
      { id: "r-interrupted", conversationId: "c1", status: "cancelled", score: null, repairRounds: 0, lintPassed: false, createdAt: 2, finishedAt: 3 },
    ],
    reattachRun,
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  expect(await screen.findByText("Partial text before quit.")).toBeInTheDocument();
  expect(await screen.findByText("Interrupted.")).toBeInTheDocument();
  expect(reattachRun).toHaveBeenCalledWith("r-interrupted", expect.anything());
});

test("Stop explicitly cancels the active daemon run", async () => {
  const cancelRun = vi.fn(async () => ({ cancelled: true }));
  const fake = makeFakeApi({
    streamRun: async function* (_input, signal): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-stop", conversationId: "c1" };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
    cancelRun,
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "keep going" } });
  fireEvent.click(screen.getByLabelText("Send"));
  fireEvent.click(await screen.findByLabelText("Stop"));

  await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("r-stop"));
});

test("queued prompts survive remount and drain on the next workspace entry", async () => {
  localStorage.setItem("dezin.workspace.queue.p1", JSON.stringify(["queued follow-up"]));
  const streamRun = vi.fn(() =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-queued", conversationId: "c1" };
      yield { type: "turn-end", round: 0, text: "Queued result." };
      yield { type: "run-done", runId: "r-queued", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );
  const fake = makeFakeApi({ streamRun: streamRun as never });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  expect(await screen.findByText("Queued result.")).toBeInTheDocument();
  expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: "queued follow-up" }), expect.anything());
  expect(localStorage.getItem("dezin.workspace.queue.p1")).toBe("[]");
});

test("/projects/new preserves the selected agent and model for the first run", async () => {
  const createProject = vi.fn(async () => ({
    id: "p-new",
    name: "New",
    skillId: null,
    designSystemId: "modern-minimal",
    mode: "prototype" as const,
    createdAt: 1,
    updatedAt: 1,
  }));
  const fake = makeFakeApi({
    createProject,
    listAgents: async () => AGENTS,
    rescanAgents: async () => AGENTS,
    getSettings: async () => ({
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
    }),
  });
  const user = userEvent.setup();

  render(
    <ApiProvider client={fake}>
      <AgentsProvider>
        <WorkspaceScreen projectId="new" />
      </AgentsProvider>
    </ApiProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Agent and model" }));
  await user.click(await screen.findByText("Codex"));
  await user.click(await screen.findByText("gpt-5"));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "make a hero" } });
  fireEvent.click(screen.getByLabelText("Send"));

  await waitFor(() => expect(createProject).toHaveBeenCalled());
  expect(takePendingAgent()).toBe("codex");
  expect(takePendingModel()).toBe("gpt-5");
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

test("user message shows attached images as thumbnails, not the .refs path text", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      {
        id: "m1",
        conversationId: "c1",
        role: "user" as const,
        content: "make it like this\n\nReference files (read them from disk): .refs/shot.png",
        createdAt: 1,
      },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  // the prose renders; the auto-generated path line does not
  expect(await screen.findByText("make it like this")).toBeInTheDocument();
  expect(screen.queryByText(/read them from disk/)).toBeNull();
  expect(screen.queryByText(/\.refs\/shot\.png/)).toBeNull();
  // a thumbnail points at the ref-serving URL
  const img = screen.getAllByAltText("reference")[0] as HTMLImageElement;
  expect(img.getAttribute("src")).toBe("/api/projects/p1/refs/shot.png");
});

test("user message shows markup targets as cards above the text bubble", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      {
        id: "m1",
        conversationId: "c1",
        role: "user" as const,
        content:
          "Make the headline shorter.\n\n" +
          "Scoped edit — change ONLY the element(s) below and keep the rest of the design byte-for-byte unchanged:\n" +
          '- selector: `section.hero > h1`\n  tag: h1\n  rect: x=24 y=40 w=320 h=48\n  text: "Enterprise pricing made simple"\n  note: Use fewer words',
        createdAt: 1,
      },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const bubble = await screen.findByText("Make the headline shorter.");
  const target = screen.getByLabelText("Marked target section.hero > h1");
  expect(target).toBeInTheDocument();
  expect(target).toHaveTextContent("h1");
  expect(target).toHaveTextContent("320x48");
  expect(target).toHaveTextContent("Enterprise pricing made simple");
  expect(target).toHaveTextContent("Use fewer words");
  expect(screen.queryByText(/Scoped edit/)).toBeNull();
  expect(target.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("markup prompts include selector, tag, geometry, text, and note for precise scoped edits", async () => {
  const streamRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {
    yield { type: "run-start", runId: "r-markup", conversationId: "c1" };
    yield { type: "run-done", runId: "r-markup", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
  });
  const fake = makeFakeApi({
    listFiles: async () => [{ path: "index.html", size: 120 }],
    streamRun: streamRun as never,
  });
  const user = userEvent.setup();
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByTitle("Artifact preview");
  fireEvent.click(screen.getByLabelText("Select an element"));
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "dezin",
        type: "selected",
        selector: "section.hero > h1",
        tag: "h1",
        text: "Enterprise pricing made simple",
        rect: { x: 24, y: 40, w: 320, h: 48 },
      },
    }),
  );
  await user.type(await screen.findByPlaceholderText("Describe the change to this element…"), "Use fewer words");
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(screen.getByLabelText("Send"));

  await waitFor(() => expect(streamRun).toHaveBeenCalled());
  const calls = streamRun.mock.calls as unknown as Array<[{ brief?: string }]>;
  const brief = calls[0]?.[0]?.brief ?? "";
  expect(brief).toContain("selector: `section.hero > h1`");
  expect(brief).toContain("tag: h1");
  expect(brief).toContain("rect: x=24 y=40 w=320 h=48");
  expect(brief).toContain('text: "Enterprise pricing made simple"');
  expect(brief).toContain("note: Use fewer words");
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

test("the Files tab lists project files and previews the selected file's source", async () => {
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
  expect(screen.queryByRole("tab", { name: "Code" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect((await screen.findAllByText("index.html")).length).toBeGreaterThan(0);
  // assets is a folder at root; double-click into it, then open the file
  expect(screen.getByText("assets")).toBeInTheDocument();
  fireEvent.doubleClick(screen.getByText("assets"));
  fireEvent.click(await screen.findByText("style.css"));
  expect(await screen.findByText(/--accent:#101010/)).toBeInTheDocument();
});

test("the Versions tab groups branch versions with View + Restore", async () => {
  const restoreVersion = vi.fn(async () => {});
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [],
    listVariants: async () => [
      { id: "main", projectId: "p1", name: "Main", createdAt: 1, active: false },
      { id: "branch", projectId: "p1", name: "Exploration", createdAt: 2, active: true },
    ],
    listRuns: async () => [
      { id: "r2", variantId: "branch", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000001000, finishedAt: 1700000001001 },
      { id: "r1", variantId: "main", status: "succeeded" as const, score: 92, repairRounds: 1, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
    ],
    restoreVersion,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  expect(screen.queryByRole("tab", { name: "History" })).toBeNull();
  fireEvent.click(await screen.findByRole("tab", { name: "Versions" }));
  expect(await screen.findByText("Main")).toBeInTheDocument();
  expect((await screen.findAllByText("Exploration")).length).toBeGreaterThan(0);
  expect(await screen.findByText("92/100")).toBeInTheDocument();
  // the active branch's newest version has no Restore (it IS current); the older branch version does
  fireEvent.click(screen.getByRole("button", { name: "Restore Main v1" }));
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

test("the Quality tab shows final run-done findings even when no repair lint event fired", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-score", conversationId: "c1" };
      yield { type: "turn-end", round: 0, text: "Built it." };
      yield {
        type: "run-done",
        runId: "r-score",
        passed: true,
        rounds: 0,
        score: 94,
        previewUrl: "/projects/p1/preview/",
        findings: [
          { severity: "P2", id: "raw-hex", message: "2 raw hex values outside :root.", fix: "Move colours into tokens." },
          { severity: "P2", id: "oversized-radius", message: "Large rounded card radius.", fix: "Use a tighter radius." },
        ],
      };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByText(/Done, quality 94\/100/);
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/raw hex values/)).toBeInTheDocument();
  expect(screen.getByText(/Large rounded card radius/)).toBeInTheDocument();
  expect(screen.queryByText(/No quality issues\. Clean/)).toBeNull();
});

test("the Quality tab groups visual QA findings separately from anti-slop findings", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-visual", conversationId: "c1" };
      yield {
        type: "run-done",
        runId: "r-visual",
        passed: true,
        rounds: 0,
        score: 89,
        previewUrl: "/projects/p1/preview/",
        findings: [
          { severity: "P1", id: "visual-horizontal-overflow", message: "Desktop viewport has horizontal overflow.", fix: "Constrain wide sections." },
          { severity: "P2", id: "raw-hex", message: "2 raw hex values outside :root.", fix: "Move colours into tokens." },
        ],
      };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByText(/Done, quality 89\/100/);
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));

  expect(await screen.findByText("Visual QA")).toBeInTheDocument();
  expect(screen.getByText("Anti-slop")).toBeInTheDocument();
  expect(screen.getByText(/Desktop viewport has horizontal overflow/)).toBeInTheDocument();
  expect(screen.getByText(/raw hex values/)).toBeInTheDocument();
});

test("reopening a project restores persisted result cards and quality findings", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user" as const, content: "make a pricing page", createdAt: 1 },
      { id: "m2", conversationId: "c1", role: "assistant" as const, content: "Built it.", createdAt: 2 },
      {
        id: "m3",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({ result: { text: "Done, quality 94/100.", meta: { passed: true, score: 94, rounds: 0 } } }),
        createdAt: 3,
      },
    ],
    listRuns: async () => [
      {
        id: "r-score",
        conversationId: "c1",
        status: "succeeded",
        score: 94,
        repairRounds: 0,
        lintPassed: true,
        createdAt: 2,
        finishedAt: 3,
        findings: [{ severity: "P2", id: "raw-hex", message: "2 raw hex values outside :root.", fix: "Move colours into tokens." }],
      },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  expect(await screen.findByText("Done, quality 94/100.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/raw hex values/)).toBeInTheDocument();
  expect(screen.queryByText(/No quality issues\. Clean/)).toBeNull();
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
  expect(await screen.findByText(/No quality issues\. Clean/)).toBeInTheDocument();
  expect(screen.getAllByText("100/100").length).toBeGreaterThan(0); // shown in the score header (and result card)
});

test("a non-perfect restored score without stored findings does not claim clean", async () => {
  const fake = makeFakeApi({
    listRuns: async () => [
      { id: "r-old", status: "succeeded", score: 94, repairRounds: 0, lintPassed: true, createdAt: 1, finishedAt: 2 },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/No stored quality details/)).toBeInTheDocument();
  expect(screen.queryByText(/No quality issues\. Clean/)).toBeNull();
});

test("markup popover position is clamped into the viewport", () => {
  const pos = computeMarkupPosition(
    { left: 900, top: 700, width: 160, height: 120 },
    { x: 180, y: 120, w: 80, h: 60 },
    { width: 1024, height: 768 },
  );
  expect(pos.x).toBeLessThanOrEqual(724);
  expect(pos.y).toBeGreaterThanOrEqual(12);
  expect(pos.y).toBeLessThanOrEqual(564);
});

test("markup popover position honors the measured popover size", () => {
  const pos = computeMarkupPosition(
    { left: 40, top: 40, width: 320, height: 240 },
    { x: 260, y: 170, w: 80, h: 40 },
    { width: 360, height: 280 },
    { width: 340, height: 240, margin: 12, gap: 8 },
  );
  expect(pos.x).toBe(12);
  expect(pos.y).toBeLessThanOrEqual(28);
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
