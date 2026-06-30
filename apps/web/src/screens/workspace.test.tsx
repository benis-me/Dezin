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
  localStorage.removeItem("dezin.workspace.split");
  localStorage.removeItem("dezin.workspace.files.split");
});
afterEach(cleanup);

const AGENTS = [
  { id: "claude", command: "claude", available: true, version: "claude 1.2.3", models: ["opus", "sonnet"] },
  { id: "codex", command: "codex", available: true, version: "codex 1.0.0", models: ["gpt-5"] },
];

test("workspace conversation panel defaults to 400px before the user resizes it", async () => {
  const innerWidth = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
  try {
    render(
      <ApiProvider client={makeFakeApi()}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("conversation")).toHaveStyle({ flexGrow: "40" }));
  } finally {
    innerWidth.mockRestore();
  }
});

test("workspace conversation panel keeps a saved user resize instead of the 400px default", () => {
  localStorage.setItem("dezin.workspace.split", "0.25");
  render(
    <ApiProvider client={makeFakeApi()}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  expect(screen.getByTestId("conversation")).toHaveStyle({ flexGrow: "25" });
  expect(screen.getByTestId("conversation")).not.toHaveStyle({ flexBasis: "400px" });
});

test("leaving a standard workspace releases its dev server lease", async () => {
  const getDevServerUrl = vi.fn(async () => ({ url: "http://127.0.0.1:5300/p1" }));
  const releaseDevServer = vi.fn(async () => {});
  const { unmount } = render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Standard",
          skillId: null,
          designSystemId: "modern-minimal",
          mode: "standard",
          createdAt: 1,
          updatedAt: 1,
        }),
        getDevServerUrl,
        releaseDevServer,
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(getDevServerUrl).toHaveBeenCalledWith("p1"));
  unmount();
  await waitFor(() => expect(releaseDevServer).toHaveBeenCalledWith("p1"));
});

test("opening a standard workspace backfills a missing cover from the dev preview", async () => {
  const captureProjectCover = vi.fn(async () => ({ captured: true }));
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Standard",
          skillId: null,
          designSystemId: "modern-minimal",
          mode: "standard",
          createdAt: 1,
          updatedAt: 1,
        }),
        getDevServerUrl: async () => ({ url: "http://127.0.0.1:5300/p1" }),
        captureProjectCover,
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(captureProjectCover).toHaveBeenCalledWith("p1"));
});

test("refreshing a standard preview revalidates the dev server lease", async () => {
  const getDevServerUrl = vi
    .fn()
    .mockResolvedValueOnce({ url: "http://127.0.0.1:5300/p1" })
    .mockResolvedValueOnce({ url: "http://127.0.0.1:5301/p1" });
  const captureProjectCover = vi.fn(async () => ({ captured: true }));
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Standard",
          skillId: null,
          designSystemId: "modern-minimal",
          mode: "standard",
          createdAt: 1,
          updatedAt: 1,
        }),
        getDevServerUrl,
        captureProjectCover,
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const iframe = await screen.findByTitle("Artifact preview");
  await waitFor(() => expect(iframe.getAttribute("src")).toBe("http://127.0.0.1:5300/p1"));

  fireEvent.click(screen.getByLabelText("Refresh preview"));

  await waitFor(() => expect(getDevServerUrl).toHaveBeenCalledTimes(2));
  expect(iframe.getAttribute("src") ?? "").toMatch(/^http:\/\/127\.0\.0\.1:5301\/p1\?t=\d+/);
  expect(captureProjectCover).toHaveBeenCalledTimes(1);
});

test("opening a project scrolls the restored conversation to the bottom", async () => {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  try {
    render(
      <ApiProvider
        client={makeFakeApi({
          listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
          listMessages: async () => [
            { id: "m1", conversationId: "c1", role: "user", content: "old question", createdAt: 1 },
            { id: "m2", conversationId: "c1", role: "assistant", content: "old answer", createdAt: 2 },
          ],
        })}
      >
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    const scroller = await screen.findByTestId("conversation-scroll");
    await waitFor(() => expect(scroller.scrollTop).toBe(1200));
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});

test("sending a brief streams events into the chat and shows the preview + export menu", async () => {
  const user = userEvent.setup();
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

  expect(screen.getByLabelText("Full screen preview")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
  expect(screen.queryByLabelText("Full screen preview")).toBeNull();
  expect(screen.getByRole("button", { name: "Export project" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Export project" }));
  const source = await screen.findByRole("menuitem", { name: "Source ZIP" });
  expect(source).toHaveAttribute("href", "/api/projects/p1/export");
  const full = screen.getByRole("menuitem", { name: "Full project ZIP" });
  expect(full).toHaveAttribute("href", "/api/projects/p1/export?scope=full");
});

test("completed runs collapse the interleaved process above the final summary", async () => {
  const user = userEvent.setup();
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-process", conversationId: "c1" };
      yield { type: "activity", activity: { kind: "text", text: "Drafted the hero." } };
      yield { type: "activity", activity: { kind: "tool", name: "Edit", summary: "Editing App.tsx" } };
      yield { type: "activity", activity: { kind: "text", text: " Tightened the layout." } };
      yield { type: "run-done", runId: "r-process", passed: true, rounds: 0, score: 100, previewUrl: "/projects/p1/preview/", findings: [] };
    },
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "make a hero" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByRole("button", { name: /Processed/ })).toBeInTheDocument();
  expect(screen.getByText("Drafted the hero. Tightened the layout.")).toBeInTheDocument();
  expect(screen.queryByText("Editing App.tsx")).toBeNull();

  await user.click(screen.getByRole("button", { name: /Processed/ }));
  expect(await screen.findByText("Editing App.tsx")).toBeInTheDocument();
});

test("agent questions render as answerable transcript cards", async () => {
  const user = userEvent.setup();
  const streamRun = vi.fn((input: { brief?: string }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      if (input.brief === "Use the annual plan") {
        yield { type: "run-start", runId: "r-answer", conversationId: "c1" };
        yield { type: "turn-end", round: 0, text: "Continuing with annual." };
        yield { type: "run-done", runId: "r-answer", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
        return;
      }
      yield { type: "run-start", runId: "r-question", conversationId: "c1" };
      yield { type: "ask-user-question", runId: "r-question", question: "Which billing plan should the pricing page feature?" };
      yield { type: "run-cancelled", runId: "r-question", reason: "question" };
    })(),
  );

  render(
    <ApiProvider client={makeFakeApi({ streamRun: streamRun as never })}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "make a pricing page" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByText("Which billing plan should the pricing page feature?")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Answer question"), { target: { value: "Use the annual plan" } });
  await user.click(screen.getByRole("button", { name: "Send answer" }));

  await waitFor(() => expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: "Use the annual plan", conversationId: "c1" }), expect.anything()));
  expect(await screen.findByText("Continuing with annual.")).toBeInTheDocument();
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
      yield { type: "activity", activity: { kind: "text", text: "Partial output before stop." } };
      yield { type: "activity", activity: { kind: "tool", name: "Edit", summary: "Editing hero.tsx" } };
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
  expect(await screen.findByRole("button", { name: /Processed/ })).toBeInTheDocument();
  expect(screen.getByText("Partial output before stop.")).toBeInTheDocument();
  expect(await screen.findByText("Stopped")).toBeInTheDocument();
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

test("queued prompts can be edited, reordered, and removed before they run", async () => {
  let releaseFirstRun!: () => void;
  const firstRunDone = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const streamRun = vi.fn((input: { brief?: string }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: `r-${input.brief ?? "empty"}`, conversationId: "c1" };
      if (input.brief === "first prompt") {
        await firstRunDone;
      }
      yield { type: "run-done", runId: `r-${input.brief ?? "empty"}`, passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );

  render(
    <ApiProvider client={makeFakeApi({ streamRun: streamRun as never })}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "first prompt" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await waitFor(() => expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: "first prompt" }), expect.anything()));

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "second prompt" } });
  fireEvent.click(screen.getByLabelText("Queue"));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "third prompt" } });
  fireEvent.click(screen.getByLabelText("Queue"));

  expect(await screen.findByLabelText("Queued prompt 1")).toHaveValue("second prompt");
  expect(screen.getByLabelText("Queued prompt 2")).toHaveValue("third prompt");

  fireEvent.change(screen.getByLabelText("Queued prompt 1"), { target: { value: "edited second prompt" } });
  expect(screen.getByLabelText("Queued prompt 1")).toHaveValue("edited second prompt");

  fireEvent.dragStart(screen.getByLabelText("Drag queued prompt 2"));
  fireEvent.dragOver(screen.getByTestId("queued-prompt-row-0"));
  fireEvent.drop(screen.getByTestId("queued-prompt-row-0"));
  expect(screen.getByLabelText("Queued prompt 1")).toHaveValue("third prompt");
  expect(screen.getByLabelText("Queued prompt 2")).toHaveValue("edited second prompt");

  fireEvent.click(screen.getByLabelText("Delete queued prompt 2"));
  expect(screen.getByLabelText("Queued prompt 1")).toHaveValue("third prompt");
  expect(screen.queryByDisplayValue("edited second prompt")).toBeNull();
  expect(localStorage.getItem("dezin.workspace.queue.p1")).toBe(JSON.stringify(["third prompt"]));

  releaseFirstRun();
  await waitFor(() => expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: "third prompt" }), expect.anything()));
  expect(streamRun).not.toHaveBeenCalledWith(expect.objectContaining({ brief: "edited second prompt" }), expect.anything());
  await waitFor(() => expect(localStorage.getItem("dezin.workspace.queue.p1")).toBe("[]"));
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

test("idle assistant messages expose copy and fork actions on hover", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(async () => {});
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const forkMessage = vi.fn(async () => ({
    conversationId: "c2",
    variantId: "v2",
    variants: [
      { id: "main", projectId: "p1", name: "Main", createdAt: 1, active: false },
      { id: "v2", projectId: "p1", name: "Forked here", createdAt: 2, active: true },
    ],
  }));
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async (_pid: string, cid: string) =>
      cid === "c2"
        ? [{ id: "m3", conversationId: "c2", role: "assistant" as const, content: "Forked transcript", createdAt: 3 }]
        : [{ id: "m2", conversationId: "c1", role: "assistant" as const, content: "Built it.", createdAt: 2 }],
    forkMessage,
  });

  try {
    render(
      <ApiProvider client={fake}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    const assistant = await screen.findByText("Built it.");
    await user.hover(assistant.closest("[data-message-kind='assistant']")!);
    await user.click(await screen.findByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith("Built it.");

    await user.click(screen.getByRole("button", { name: "Fork from this message" }));
    await waitFor(() => expect(forkMessage).toHaveBeenCalledWith("p1", "m2"));
    expect(await screen.findByText("Forked transcript")).toBeInTheDocument();
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  }
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
  expect(target.className).not.toContain("shadow");
  expect(target).toHaveTextContent("h1");
  expect(target).toHaveTextContent("320x48");
  expect(target).toHaveTextContent("Enterprise pricing made simple");
  expect(target).toHaveTextContent("Use fewer words");
  expect(screen.queryByText(/Scoped edit/)).toBeNull();
  expect(target.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("clicking a marked target asks the preview to focus that element", async () => {
  const fake = makeFakeApi({
    listFiles: async () => [{ path: "index.html", size: 120 }],
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      {
        id: "m1",
        conversationId: "c1",
        role: "user" as const,
        content:
          "Adjust this.\n\n" +
          "Scoped edit — change ONLY the element(s) below and keep the rest of the design byte-for-byte unchanged:\n" +
          '- selector: `section.hero > h1`\n  tag: h1\n  rect: x=24 y=40 w=320 h=48\n  text: "Enterprise pricing made simple"',
        createdAt: 1,
      },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const iframe = (await screen.findByTitle("Artifact preview")) as HTMLIFrameElement;
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.click(screen.getByRole("button", { name: "Marked target section.hero > h1" }));

  expect(postMessage).toHaveBeenCalledWith(
    {
      source: "dezin-parent",
      type: "focus-target",
      selector: "section.hero > h1",
      rect: { x: 24, y: 40, w: 320, h: 48 },
    },
    "*",
  );
});

test("conversation opens at the bottom and shows an icon-only jump button when scrolled away", async () => {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "conversation-scroll" ? 1200 : 0;
  });
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "conversation-scroll" ? 360 : 0;
  });
  try {
    const fake = makeFakeApi({
      listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
      listMessages: async () => [
        { id: "m1", conversationId: "c1", role: "user" as const, content: "First", createdAt: 1 },
        { id: "m2", conversationId: "c1", role: "assistant" as const, content: "Second", createdAt: 2 },
      ],
    });
    render(
      <ApiProvider client={fake}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    await screen.findByText("Second");
    const scroll = screen.getByTestId("conversation-scroll");
    await waitFor(() => expect(scroll.scrollTop).toBe(1200));
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();

    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    const jump = await screen.findByRole("button", { name: "Scroll to bottom" });
    expect(jump.textContent).toBe("");
    expect(jump.className).not.toContain("shadow");

    fireEvent.click(jump);
    expect(scroll.scrollTop).toBe(1200);
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
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
  const trigger = screen.getByRole("button", { name: "Conversations" });
  expect(trigger).not.toHaveTextContent("Conversations");
  const user = userEvent.setup();
  expect(screen.queryByRole("button", { name: /Second/ })).toBeNull();
  await user.click(trigger);
  const activeConversation = (await screen.findAllByRole("button", { name: /Second/ })).find((el) => !el.hasAttribute("aria-label"));
  expect(activeConversation).toBeTruthy();
  const activeConversationButton = activeConversation!;
  expect(activeConversationButton.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  expect(activeConversationButton.firstElementChild?.getAttribute("class")).toContain("text-foreground");
  expect(activeConversationButton.children[1]?.getAttribute("class")).toContain("text-muted-foreground");
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
  fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
  fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
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
  expect(screen.getByRole("tablist", { name: "Artifact views" }).className).toContain("[&_[role=tab]]:px-2.5");
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  const fileResize = await screen.findByRole("separator", { name: "Resize file browser" });
  expect(fileResize).toHaveAttribute("data-separator");
  expect(fileResize).toHaveClass("dezin-resize-separator", "app-no-drag");
  expect(fileResize.className).not.toContain("primary");
  expect(fileResize.className).not.toContain("focus-visible");
  expect((await screen.findAllByText("index.html")).length).toBeGreaterThan(0);
  // assets is a folder at root; double-click into it, then open the file
  expect(screen.getByText("assets")).toBeInTheDocument();
  fireEvent.doubleClick(screen.getByText("assets"));
  fireEvent.click(await screen.findByText("style.css"));
  expect(await screen.findByText(/--accent:#101010/)).toBeInTheDocument();
});

test("the Versions tab groups branch versions with View, set cover, and Restore", async () => {
  const restoreVersion = vi.fn(async () => {});
  const setVersionCover = vi.fn(async () => ({ captured: true }));
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
    setVersionCover,
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
  fireEvent.click(screen.getByRole("button", { name: "Set Main v1 as cover" }));
  await waitFor(() => expect(setVersionCover).toHaveBeenCalledWith("p1", "r1"));
  // the active branch's newest version has no Restore (it IS current); the older branch version does
  fireEvent.click(screen.getByRole("button", { name: "Restore Main v1" }));
  await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith("p1", "r1"));
});

test("standard project version Diff uses the commit diff endpoint", async () => {
  const getVersionText = vi.fn(async () => {
    throw new Error("prototype snapshot text should not be used for standard diffs");
  });
  const getVersionDiff = vi.fn(async () => [
    { t: "del" as const, text: "export default function App(){ return <main>One</main> }" },
    { t: "add" as const, text: "export default function App(){ return <main>Two</main> }" },
  ]);
  const fake = makeFakeApi({
    getProject: async () => ({
      id: "p1",
      name: "Standard",
      skillId: null,
      designSystemId: "modern-minimal",
      mode: "standard",
      createdAt: 1,
      updatedAt: 1,
    }),
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [],
    listVariants: async () => [{ id: "main", projectId: "p1", name: "Main", createdAt: 1, active: true }],
    listRuns: async () => [
      { id: "r2", variantId: "main", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000001000, finishedAt: 1700000001001 },
      { id: "r1", variantId: "main", status: "succeeded" as const, score: 90, repairRounds: 0, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
    ],
    getDevServerUrl: async () => ({ url: "http://127.0.0.1:5300/p1" }),
    getVersionText,
    getVersionDiff,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("tab", { name: "Versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Diff Main v1" }));

  await waitFor(() => expect(getVersionDiff).toHaveBeenCalledWith("p1", "r1"));
  expect(getVersionText).not.toHaveBeenCalled();
  expect(await screen.findByText(/One/)).toBeInTheDocument();
  expect(await screen.findByText(/Two/)).toBeInTheDocument();
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
