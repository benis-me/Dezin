import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, afterEach, beforeEach, vi } from "vitest";
import {
  AUTO_FIX_MAX_PER_CONVERSATION,
  buildProjectAnalysisPrompt,
  computeMarkupPosition,
  isPreviewBridgeMessage,
  WorkspaceScreen,
} from "./WorkspaceScreen.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type { RunEvent, RunSummary } from "../lib/api.ts";
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
  localStorage.removeItem("dezin.workspace.inspect.split");
});
afterEach(cleanup);

const AGENTS = [
  { id: "claude", command: "claude", available: true, version: "claude 1.2.3", models: ["opus", "sonnet"] },
  { id: "codex", command: "codex", available: true, version: "codex 1.0.0", models: ["gpt-5"] },
];

function dispatchPreviewMessage(data: Record<string, unknown>): void {
  const iframe = screen.getByTitle("Artifact preview") as HTMLIFrameElement;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "dezin", ...data },
      origin: "null",
      source: iframe.contentWindow,
    }),
  );
}

test("workspace loading state preserves the project split layout", () => {
  render(
    <ApiProvider client={makeFakeApi({ getProject: async () => new Promise(() => {}) })}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  expect(screen.getByRole("region", { name: "Conversation loading" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Artifact loading" })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize panels" })).toHaveAttribute("data-separator");
  expect(screen.getByText("Loading project")).toBeInTheDocument();
  expect(screen.queryByLabelText("Message")).toBeNull();
});

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

test("workspace conversation panel constrains scrolling to the transcript area", async () => {
  render(
    <ApiProvider client={makeFakeApi()}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  expect(await screen.findByRole("region", { name: "Conversation" })).toHaveClass("min-h-0", "overflow-hidden");
  expect(screen.getByTestId("conversation-scroll")).toHaveClass("min-h-0", "overflow-auto");
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
  expect(screen.getByTitle("Artifact preview").getAttribute("src") ?? "").toMatch(/^http:\/\/127\.0\.0\.1:5301\/p1\?t=\d+/);
  expect(captureProjectCover).toHaveBeenCalledTimes(1);
});

test("prototype workspace preview iframe omits allow-same-origin", async () => {
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Prototype",
          skillId: null,
          designSystemId: "modern-minimal",
          mode: "prototype",
          createdAt: 1,
          updatedAt: 1,
        }),
        listFiles: async () => [{ path: "index.html", size: 12 }],
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const iframe = await screen.findByTitle("Artifact preview");
  await waitFor(() => expect(iframe.getAttribute("src")).toMatch(/^\/projects\/p1\/preview\//));
  expect(iframe).toHaveAttribute("sandbox");
  expect(iframe.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");
});

test("preview bridge messages must come from the current iframe window", () => {
  const trustedWindow = window;
  const iframe = { contentWindow: trustedWindow } as unknown as HTMLIFrameElement;

  const accepted = new MessageEvent("message", { data: { source: "dezin", type: "selected" }, origin: "null", source: trustedWindow });
  expect(isPreviewBridgeMessage(accepted, iframe, "/projects/p1/preview/")).toBe(true);

  const wrongSource = new MessageEvent("message", { data: { source: "dezin", type: "selected" }, origin: "null", source: null });
  expect(isPreviewBridgeMessage(wrongSource, iframe, "/projects/p1/preview/")).toBe(false);
  expect(isPreviewBridgeMessage(accepted, null, "/projects/p1/preview/")).toBe(false);

  const wrongOrigin = new MessageEvent("message", { data: { source: "dezin", type: "selected" }, origin: "https://evil.example", source: trustedWindow });
  expect(isPreviewBridgeMessage(wrongOrigin, iframe, "/projects/p1/preview/")).toBe(false);

  const standardPreview = "http://127.0.0.1:5300/p1";
  const standardAccepted = new MessageEvent("message", { data: { source: "dezin", type: "selected" }, origin: "http://127.0.0.1:5300", source: trustedWindow });
  expect(isPreviewBridgeMessage(standardAccepted, iframe, standardPreview)).toBe(true);
  const standardWrongOrigin = new MessageEvent("message", { data: { source: "dezin", type: "selected" }, origin: "null", source: trustedWindow });
  expect(isPreviewBridgeMessage(standardWrongOrigin, iframe, standardPreview)).toBe(false);
});

test("project analysis prompt includes the project folder path and review checklist", () => {
  const prompt = buildProjectAnalysisPrompt({
    id: "p1",
    name: "Landing Sprint",
    skillId: "frontend-design",
    designSystemId: "modern-minimal",
    mode: "standard",
    createdAt: 1,
    updatedAt: 2,
    projectPath: "/Users/ben/.dezin/data/projects/p1",
  });

  expect(prompt).toContain("/Users/ben/.dezin/data/projects/p1");
  expect(prompt).toContain("Landing Sprint");
  expect(prompt).toContain("standard");
  expect(prompt).toContain("Analyze this Dezin-generated project");
  expect(prompt).toContain("contributing factors");
  expect(prompt).toContain("next test round");
});

test("project analysis prompt avoids priority tiers for Sharingan projects", () => {
  const prompt = buildProjectAnalysisPrompt({
    id: "p1",
    name: "TapNow clone",
    skillId: null,
    designSystemId: null,
    mode: "standard",
    sharingan: true,
    sourceUrl: "https://app.tapnow.ai/home",
    createdAt: 1,
    updatedAt: 2,
    projectPath: "/Users/ben/.dezin/data/projects/p1",
  });

  expect(prompt).toContain("required source-fidelity gap");
  expect(prompt).not.toMatch(/\bP[012]\b/);
});

test("workspace project actions menu exposes project management and analysis actions", async () => {
  const user = userEvent.setup();

  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Landing Sprint",
          skillId: "frontend-design",
          designSystemId: "modern-minimal",
          mode: "standard",
          createdAt: 1,
          updatedAt: 2,
          projectPath: "/Users/ben/.dezin/data/projects/p1",
        }),
        listFiles: async () => [{ path: "src/App.tsx", size: 12 }],
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await user.click(await screen.findByLabelText("Project actions"));

  expect(await screen.findByRole("menuitem", { name: "Rename project" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Delete project" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Open in Finder" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Copy Analysis Prompt" })).toBeInTheDocument();
});

test("standard workspace shows setup and dev-server logs in Standard Doctor", async () => {
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
        getSetup: async () => ({
          phase: "installing",
          logs: [
            { at: 1, level: "info", message: "Installing dependencies" },
            { at: 2, level: "error", message: "npm install failed" },
          ],
          error: "npm install failed",
        }),
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText("Standard Doctor")).toBeInTheDocument();
  expect(screen.getByText("installing")).toBeInTheDocument();
  expect(screen.getAllByText("npm install failed").length).toBeGreaterThan(0);
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

test("restored user chat bubbles render markdown", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [{ id: "m1", conversationId: "c1", role: "user", content: "Make this **important** with `tokens`.", createdAt: 1 }],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const strong = await screen.findByText("important");
  expect(strong.tagName).toBe("STRONG");
  expect(screen.getByText("tokens").tagName).toBe("CODE");
});

test("reattaching to an in-flight run reuses the persisted Research card instead of duplicating it", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    // History already holds the persisted research summary (research finished before this reload).
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user", content: "Design a chat UI", createdAt: 1 },
      {
        id: "m2",
        conversationId: "c1",
        role: "system",
        content: JSON.stringify({
          research: { produced: true, report: true, sources: 4, assets: 6, directions: [{ slug: "console", title: "Console", summary: "Calm operator console." }] },
        }),
        createdAt: 2,
      },
    ],
    // The latest run is still in-flight → the workspace reattaches and replays events from seq 0,
    // re-emitting research-start / research-done for the same research phase.
    listRuns: async () => [{ id: "r1", conversationId: "c1", status: "running", score: null, repairRounds: 0, lintPassed: false, createdAt: 3, finishedAt: null }],
    reattachRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "research-start", runId: "r1" } as RunEvent;
      yield { type: "research-done", runId: "r1", report: true, sources: 4, assets: 6, directions: [{ slug: "console", title: "Console" }] } as RunEvent;
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId("research-card").length).toBeGreaterThan(0));
  // Exactly one card — the replay must reuse the history card, not append a duplicate.
  expect(screen.getAllByTestId("research-card")).toHaveLength(1);
});

test("reattaching to an in-flight run does not duplicate the research direction gate (hosted inline in the Research card)", async () => {
  const gateDirections = [{ slug: "console", title: "Console", markdown: "# Console\n\nCalm operator console." }];
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    // The daemon persists BOTH a research summary and a direction-gate; the gate now renders as the
    // inline picker inside the Research card.
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user", content: "Design a chat UI", createdAt: 1 },
      {
        id: "m2",
        conversationId: "c1",
        role: "system",
        content: JSON.stringify({ research: { produced: true, report: true, sources: 0, assets: 0, directions: [{ slug: "console", title: "Console", summary: "Calm operator console." }] } }),
        createdAt: 2,
      },
      { id: "m3", conversationId: "c1", role: "system", content: JSON.stringify({ directionGate: { runId: "r1", brief: "Design a chat UI", directions: gateDirections } }), createdAt: 3 },
    ],
    listRuns: async () => [{ id: "r1", conversationId: "c1", status: "running", score: null, repairRounds: 0, lintPassed: false, createdAt: 4, finishedAt: null }],
    reattachRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "research-start", runId: "r1" } as RunEvent;
      yield { type: "direction-gate", runId: "r1", brief: "Design a chat UI", directions: gateDirections } as RunEvent;
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  // One Research card hosts the gate → its one direction renders one option, with an inline Submit.
  // A reattach replay must reuse the persisted card, not double it.
  await waitFor(() => expect(screen.getAllByTestId("research-card-direction").length).toBeGreaterThan(0));
  expect(screen.getAllByTestId("research-card-direction")).toHaveLength(1);
  expect(screen.getByTestId("research-submit-direction")).toBeTruthy();
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

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make a hero" } });
  fireEvent.click(screen.getByLabelText("Send"));

  // user message + streamed assistant text + done status
  expect(await screen.findByText("Built your hero section.")).toBeInTheDocument();
  expect(screen.getByText("make a hero")).toBeInTheDocument();
  expect(screen.getByText(/^Done/)).toBeInTheDocument();

  // preview iframe gets the previewUrl src
  const iframe = await screen.findByTitle("Artifact preview");
  expect(iframe.getAttribute("src") ?? "").toMatch(/^\/projects\/p1\/preview\//);
  expect(iframe.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");

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

test("project agent composer cards serialize context at send time", async () => {
  const streamRun = vi.fn((_input: { brief: string; moodboardRefs?: Array<{ id: string; name?: string }> }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-context", conversationId: "c1" };
      yield { type: "run-done", runId: "r-context", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );
  const fake = makeFakeApi({
    streamRun: streamRun as never,
    listFiles: async () => [{ path: "index.html", size: 12 }],
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByLabelText("Message");
  await screen.findByTitle("Artifact preview");
  dispatchPreviewMessage({
    type: "selected",
    selector: ".hero-title",
    tag: "h1",
    text: "Old title",
    rect: { x: 10, y: 20, w: 200, h: 80 },
  });
  fireEvent.change(await screen.findByPlaceholderText(/Describe the change to this element/), { target: { value: "Make this sharper" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));

  expect(await screen.findByText(".hero-title")).toBeInTheDocument();
  expect(screen.getByLabelText("Agent context cards")).toBeInTheDocument();
  fireEvent.dragOver(screen.getByLabelText("Agent context cards"), {
    dataTransfer: { types: ["application/x-dezin-agent-context"], files: [] },
  });
  expect(screen.queryByText("Drop files to attach")).toBeNull();

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Use the selected references" } });
  fireEvent.click(screen.getByLabelText("Send"));

  await waitFor(() => expect(streamRun).toHaveBeenCalled());
  const input = streamRun.mock.calls[0]![0] as { brief: string; moodboardRefs?: Array<{ id: string; name?: string }> };
  expect(input.brief).toContain("Use the selected references");
  expect(input.brief).toContain("Scoped edit");
  expect(input.brief).toContain("selector: `.hero-title`");
  expect(input.brief).toContain("Make this sharper");
  expect(screen.queryByLabelText("Agent context cards")).toBeNull();
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
    // The completed run is a version, so the stack carries a version label above the Processed card.
    listRuns: async () => [{ id: "r-process", conversationId: "c1", status: "succeeded", score: 100, repairRounds: 0, lintPassed: true, createdAt: 2, finishedAt: 3 }],
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make a hero" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByRole("button", { name: /Processed/ })).toBeInTheDocument();
  expect(screen.getByText("Drafted the hero. Tightened the layout.")).toBeInTheDocument();
  expect(screen.queryByText("Editing App.tsx")).toBeNull();
  const stack = await screen.findByTestId("run-card-stack");
  expect(await within(stack).findByTestId("run-stack-version")).toHaveTextContent("v1");
  expect(within(stack).getByRole("button", { name: "1 step" })).toBeInTheDocument();
  expect(within(stack).getByText(/Done, quality 100\/100/)).toBeInTheDocument();
  const stackedCards = within(stack).getAllByTestId("run-card-stack-item");
  expect(stackedCards).toHaveLength(2);
  expect(stackedCards[0].className).toContain("rounded-t-lg");
  expect(stackedCards[0].className).not.toContain("rounded-b-lg");
  expect(stackedCards[1].className).toContain("rounded-b-lg");
  expect(stackedCards[1].className).not.toContain("rounded-t-lg");

  await user.click(screen.getByRole("button", { name: /Processed/ }));
  expect(await screen.findByText("Editing App.tsx")).toBeInTheDocument();
  expect(screen.getAllByText("Drafted the hero. Tightened the layout.")).toHaveLength(1);
});

test("Sharingan region events are shown as live process steps", async () => {
  const user = userEvent.setup();
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-region", conversationId: "c1" };
      yield { type: "sharingan-region-start", runId: "r-region", regionId: "region-1", label: "Header", index: 0, total: 2 };
      yield { type: "sharingan-region-retry", runId: "r-region", regionId: "region-1", label: "Header", index: 0, total: 2, error: "missing region file", nextAttempt: 2 };
      yield { type: "sharingan-region-done", runId: "r-region", regionId: "region-1", label: "Header", index: 0, total: 2 };
      yield { type: "turn-start", round: 0, isRepair: false };
      yield { type: "turn-end", round: 0, text: "Integrated source regions.", summaryBoundary: true };
      yield { type: "run-done", runId: "r-region", passed: true, rounds: 0, score: 100, previewUrl: "/projects/p1/preview/", findings: [] };
    },
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "clone this" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByText("Integrated source regions.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Processed/ }));
  expect(await screen.findByText("Building source region 1/2: Header")).toBeInTheDocument();
  expect(screen.getByText("Retrying source region: Header - missing region file")).toBeInTheDocument();
  expect(screen.getByText("Built source region: Header")).toBeInTheDocument();
});

test("Sharingan failed region events are kept in the processed card", async () => {
  const user = userEvent.setup();
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-region-fail", conversationId: "c1" };
      yield { type: "sharingan-region-start", runId: "r-region-fail", regionId: "region-1", label: "Header", index: 0, total: 1 };
      yield { type: "sharingan-region-failed", runId: "r-region-fail", regionId: "region-1", label: "Header", index: 0, total: 1, error: "missing src/sharingan-regions/region-1.jsx" };
      yield { type: "run-error", runId: "r-region-fail", message: "Sharingan region subagents failed" };
    },
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "clone this" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByText("The run failed: Sharingan region subagents failed")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Processed/ }));
  expect(await screen.findByText("Building source region 1/1: Header")).toBeInTheDocument();
  expect(screen.getByText("Source region failed: Header - missing src/sharingan-regions/region-1.jsx")).toBeInTheDocument();
});

test("summary-boundary runs keep process text folded and final summary outside", async () => {
  const user = userEvent.setup();
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-boundary", conversationId: "c1" };
      yield { type: "activity", activity: { kind: "text", text: "Drafted the pricing layout." } };
      yield { type: "activity", activity: { kind: "tool", name: "Write", summary: "Writing App.tsx" } };
      yield { type: "turn-end", round: 0, text: "Done. Updated the pricing page.", summaryBoundary: true };
      yield { type: "run-done", runId: "r-boundary", passed: true, rounds: 0, score: 100, previewUrl: "/projects/p1/preview/", findings: [] };
    },
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make a pricing page" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByText("Done. Updated the pricing page.")).toBeInTheDocument();
  expect(screen.queryByText("Drafted the pricing layout.")).toBeNull();

  await user.click(screen.getByRole("button", { name: /Processed/ }));
  expect(await screen.findByText("Drafted the pricing layout.")).toBeInTheDocument();
  expect(screen.getByText("Writing App.tsx")).toBeInTheDocument();
});

test("live process timers reset for each assistant turn", async () => {
  let now = 1_000;
  const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-turn-elapsed", conversationId: "c1" };
      yield { type: "turn-start", round: 0, isRepair: false };
      yield { type: "activity", activity: { kind: "tool", name: "Write", summary: "Drafting App.tsx" } };
      now = 61_000;
      yield { type: "turn-end", round: 0, text: "Draft complete.", summaryBoundary: true };
      yield {
        type: "visual-qa-start",
        runId: "r-turn-elapsed",
        enabled: true,
        round: 0,
        agentCommand: "codebuddy",
        model: "hunyuan",
        screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
      };
      yield {
        type: "visual-qa",
        runId: "r-turn-elapsed",
        enabled: true,
        round: 0,
        findings: [{ severity: "P1", id: "visual-copy-wrap", message: "Copy wraps poorly.", fix: "Let the copy wrap." }],
      };
      now = 121_000;
      yield { type: "turn-start", round: 1, isRepair: true };
      yield { type: "activity", activity: { kind: "tool", name: "Edit", summary: "Fixing App.tsx" } };
      now = 126_000;
      yield { type: "turn-end", round: 1, text: "Repair complete.", summaryBoundary: true };
      yield { type: "run-done", runId: "r-turn-elapsed", passed: true, rounds: 1, score: 100, findings: [] };
    },
  });

  try {
    render(
      <ApiProvider client={fake}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make a page" } });
    fireEvent.click(screen.getByLabelText("Send"));

    expect(await screen.findByRole("button", { name: "Processed 1m 00s" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Processed 5s" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Processed 2m 05s" })).toBeNull();
  } finally {
    dateNow.mockRestore();
  }
});

test("reopening old transcripts keeps final steps with the stopped card below the summary", async () => {
  const user = userEvent.setup();
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user" as const, content: "stop after partial", createdAt: 1 },
      {
        id: "m2",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({
          process: {
            items: [
              { type: "text", text: "Partial output before stop." },
              { type: "tool", summary: "Editing hero.tsx" },
            ],
            elapsedMs: 1500,
          },
        }),
        createdAt: 2,
      },
      { id: "m3", conversationId: "c1", role: "system" as const, content: JSON.stringify({ steps: ["Editing hero.tsx"] }), createdAt: 3 },
      { id: "m4", conversationId: "c1", role: "assistant" as const, content: "Partial output before stop.", createdAt: 4 },
      { id: "m5", conversationId: "c1", role: "system" as const, content: JSON.stringify({ result: { text: "Stopped.", meta: {} } }), createdAt: 5 },
    ],
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const processed = await screen.findByRole("button", { name: /Processed/ });
  expect(screen.getByText("Partial output before stop.")).toBeInTheDocument();
  const stack = await screen.findByTestId("run-card-stack");
  expect(within(stack).getByRole("button", { name: "1 step" })).toBeInTheDocument();
  expect(within(stack).getByText("Stopped")).toBeInTheDocument();
  expect(within(stack).queryByRole("button", { name: /Processed/ })).toBeNull();

  await user.click(processed);
  expect(await screen.findByText("Editing hero.tsx")).toBeInTheDocument();
  expect(screen.getAllByText("Partial output before stop.")).toHaveLength(1);
});

test("reopening auto-improve transcripts keeps the next turn process with the next assistant summary", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user" as const, content: "make it better", createdAt: 1 },
      { id: "m2", conversationId: "c1", role: "assistant" as const, content: "Draft complete.", createdAt: 2 },
      { id: "m3", conversationId: "c1", role: "system" as const, content: JSON.stringify({ steps: ["Drafting App.tsx"] }), createdAt: 3 },
      {
        id: "m4",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({
          visualReview: {
            status: "complete",
            enabled: true,
            round: 0,
            agentCommand: "codebuddy",
            model: "hunyuan",
            summary: "codebuddy / hunyuan reviewed the screenshot and reported 1 issue.",
            findings: [{ severity: "P1", id: "visual-copy-wrap", message: "Copy wraps poorly.", fix: "Let the copy wrap." }],
            process: [{ type: "tool", summary: "Reviewing screenshot with codebuddy / hunyuan" }],
          },
        }),
        createdAt: 4,
      },
      {
        id: "m5",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({ process: { items: [{ type: "tool", summary: "Fixing App.tsx" }], elapsedMs: 5_000 } }),
        createdAt: 5,
      },
      { id: "m6", conversationId: "c1", role: "assistant" as const, content: "Repair complete.", createdAt: 6 },
      { id: "m7", conversationId: "c1", role: "system" as const, content: JSON.stringify({ steps: ["Fixing App.tsx"] }), createdAt: 7 },
      {
        id: "m8",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({
          visualReview: {
            status: "complete",
            enabled: true,
            round: 1,
            agentCommand: "codebuddy",
            model: "hunyuan",
            summary: "Screenshot review completed with no visible layout issues reported.",
            findings: [],
            process: [{ type: "tool", summary: "Reviewing screenshot with codebuddy / hunyuan" }],
          },
        }),
        createdAt: 8,
      },
    ],
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const firstVisualReview = (await screen.findAllByTestId("visual-review-message"))[0]!;
  const firstVisualStack = firstVisualReview.closest("[data-testid='run-card-stack']");
  expect(firstVisualStack).toBeInstanceOf(HTMLElement);
  const firstStackElement = firstVisualStack as HTMLElement;
  expect(within(firstStackElement).getByRole("button", { name: "1 step" })).toBeInTheDocument();
  expect(within(firstStackElement).queryByRole("button", { name: /Processed/ })).toBeNull();

  const nextTurnProcess = screen.getByRole("button", { name: "Processed 5s" });
  const repairSummary = screen.getByText("Repair complete.");
  expect(nextTurnProcess.closest("[data-testid='turn-process-stack']")).toBeInTheDocument();
  expect(nextTurnProcess.closest("[data-testid='run-card-stack']")).not.toBe(firstStackElement);
  expect(nextTurnProcess.compareDocumentPosition(repairSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("assistant copy and fork actions sit below the final cards in a completed message", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "assistant" as const, content: "Built the page.", createdAt: 1 },
      { id: "m2", conversationId: "c1", role: "system" as const, content: JSON.stringify({ steps: ["Editing App.tsx"] }), createdAt: 2 },
      {
        id: "m3",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({ result: { text: "Done.", meta: { passed: true, score: 100, rounds: 0 } } }),
        createdAt: 3,
      },
    ],
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const stack = await screen.findByTestId("run-card-stack");
  const copy = await screen.findByLabelText("Copy message");
  expect(stack.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByLabelText("Fork from this message")).toBeInTheDocument();
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

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make a pricing page" } });
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
  expect(reattachRun).toHaveBeenCalledWith("r-live", expect.anything(), { afterSeq: 0 });
  expect(await screen.findByText(/Done, quality 100\/100/)).toBeInTheDocument();
});

test("live generating status uses shiny text", async () => {
  let finishRun!: () => void;
  const runDone = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-shiny", conversationId: "c1" };
      yield { type: "turn-start", round: 0, isRepair: false };
      await runDone;
      yield { type: "run-done", runId: "r-shiny", passed: true, rounds: 0, score: 100, previewUrl: "/projects/p1/preview/", findings: [] };
    },
  });

  try {
    render(
      <ApiProvider client={fake}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
    fireEvent.click(screen.getByLabelText("Send"));

    expect(await screen.findByText("Generating…")).toHaveClass("shiny-text");
  } finally {
    finishRun?.();
  }
});

test("mount shows an interrupted run's persisted terminal WITHOUT reattaching (no double-render)", async () => {
  const reattachRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {});
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    // Finished runs are fully persisted (start.ts writes a terminal for interrupted ones). loadMessages
    // restores the transcript; a finished run must NOT be reattached — replaying it would double-render.
    listMessages: async () => [
      { id: "m-user", conversationId: "c1", role: "user", content: "make a hero", createdAt: 1 },
      {
        id: "m-term",
        conversationId: "c1",
        role: "system",
        content: JSON.stringify({ result: { text: "Stopped — the app restarted before this run finished.", meta: {} } }),
        createdAt: 3,
      },
    ],
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

  expect(await screen.findByText(/Stopped — the app restarted/)).toBeInTheDocument();
  // The cancelled run is NOT reattached — that replay is what double-rendered finished runs on re-entry.
  await Promise.resolve();
  expect(reattachRun).not.toHaveBeenCalled();
});

test("re-entry reattaches the loaded conversation's live run, not another conversation's", async () => {
  const reattachRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {});
  const fake = makeFakeApi({
    listConversations: async () => [
      { id: "cA", projectId: "p1", title: "A", createdAt: 1 },
      { id: "cB", projectId: "p1", title: "B", createdAt: 2 },
    ],
    listMessages: async () => [],
    // A live run belongs to conversation A, but re-entry opens the newest conversation (B). Reattaching
    // it (as the variant's newest run) would stream A's cards into B — it must be skipped.
    listRuns: async () => [
      { id: "r-live", conversationId: "cA", status: "running", score: null, repairRounds: 0, lintPassed: false, createdAt: 3, finishedAt: null },
    ],
    reattachRun,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  await screen.findByLabelText("Message");
  await new Promise((r) => setTimeout(r, 50));
  expect(reattachRun).not.toHaveBeenCalled();
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

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "keep going" } });
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

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "first prompt" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await waitFor(() => expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: "first prompt" }), expect.anything()));

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "second prompt" } });
  fireEvent.click(screen.getByLabelText("Queue"));
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "third prompt" } });
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
  expect(localStorage.getItem("dezin.workspace.queue.p1")).toBe(JSON.stringify([{ text: "third prompt" }]));

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
  const settings = {
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
    autoFixLiveRuntimeErrors: false,
    sharinganAffirmed: false,
    researchEnabled: false, researchAgentCommand: "", researchModel: "",    visualQaAgentCommand: "",
    visualQaModel: "",
    autoImproveEnabled: true,
    autoImproveMaxRounds: 8,
  };
  const updateSettings = vi.fn(async (patch) => ({ ...settings, ...patch }));
  const fake = makeFakeApi({
    createProject,
    listAgents: async () => AGENTS,
    rescanAgents: async () => AGENTS,
    getSettings: async () => settings,
    updateSettings,
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
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make a hero" } });
  fireEvent.click(screen.getByLabelText("Send"));

  await waitFor(() => expect(createProject).toHaveBeenCalled());
  expect(takePendingAgent()).toBe("codex");
  expect(takePendingModel()).toBe("gpt-5");
  expect(updateSettings).toHaveBeenLastCalledWith({ agentCommand: "codex", model: "gpt-5" });
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
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "tweak it" } });
  fireEvent.click(screen.getByLabelText("Send"));
  expect(await screen.findByText("Continued.")).toBeInTheDocument();
  expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1", brief: "tweak it" }), expect.anything());
});

test("composer references a moodboard for the next project run", async () => {
  const user = userEvent.setup();
  const streamRun = vi.fn((input: { brief?: string; moodboardRefs?: Array<{ id: string; name?: string }> }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-mood", conversationId: "c1" };
      yield { type: "turn-end", round: 0, text: `Used ${input.moodboardRefs?.[0]?.name ?? "no moodboard"}.` };
      yield { type: "run-done", runId: "r-mood", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );

  render(
    <ApiProvider
      client={makeFakeApi({
        listMoodboards: async () => [
          { id: "mood-1", name: "Warm references", createdAt: 1, updatedAt: 2, archivedAt: null, coverAssetId: null, coverUrl: null },
        ],
        streamRun: streamRun as never,
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const addMenu = await screen.findByRole("button", { name: "Add files and context" });
  addMenu.focus();
  fireEvent.pointerDown(addMenu, { button: 0, ctrlKey: false });
  fireEvent.keyDown(addMenu, { key: "Enter" });
  await user.click(await screen.findByText("Reference a moodboard"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Warm references" }));

  expect(await screen.findByLabelText("Remove Warm references")).toBeInTheDocument();

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Use this visual direction" } });
  await user.click(screen.getByLabelText("Send"));

  await waitFor(() =>
    expect(streamRun).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: expect.stringContaining("Use this visual direction"),
        moodboardRefs: [{ id: "mood-1", name: "Warm references" }],
      }),
      expect.anything(),
    ),
  );
  expect(screen.queryByLabelText("Remove Warm references")).toBeNull();
});

test("composer references an effect for the next project run", async () => {
  const user = userEvent.setup();
  const streamRun = vi.fn((input: { brief?: string; effectRefs?: Array<{ id: string; name?: string }> }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-effect", conversationId: "c1" };
      yield { type: "turn-end", round: 0, text: `Used ${input.effectRefs?.[0]?.name ?? "no effect"}.` };
      yield { type: "run-done", runId: "r-effect", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );

  render(
    <ApiProvider
      client={makeFakeApi({
        listEffects: async () => [{ id: "paper-texture", name: "paper texture", origin: "built-in", category: "@Paper", summary: "Paper grain" }],
        streamRun: streamRun as never,
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const addMenu = await screen.findByRole("button", { name: "Add files and context" });
  addMenu.focus();
  fireEvent.pointerDown(addMenu, { button: 0, ctrlKey: false });
  fireEvent.keyDown(addMenu, { key: "Enter" });
  await user.click(await screen.findByText("Reference an effect"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "paper texture" }));

  expect(await screen.findByLabelText("Remove paper texture")).toBeInTheDocument();

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Use this tactile grain treatment" } });
  await user.click(screen.getByLabelText("Send"));

  await waitFor(() =>
    expect(streamRun).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: expect.stringContaining("Effect references"),
        effectRefs: [{ id: "paper-texture", name: "paper texture" }],
      }),
      expect.anything(),
    ),
  );
  expect(screen.queryByLabelText("Remove paper texture")).toBeNull();
});

test("queued moodboard references are preserved for the next project run", async () => {
  const user = userEvent.setup();
  let releaseFirstRun!: () => void;
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const streamRun = vi.fn((input: { brief?: string; moodboardRefs?: Array<{ id: string; name?: string }> }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: `r-${streamRun.mock.calls.length}`, conversationId: "c1" };
      if (streamRun.mock.calls.length === 1) await firstRunGate;
      yield { type: "turn-end", round: 0, text: input.brief ?? "" };
      yield { type: "run-done", runId: `r-${streamRun.mock.calls.length}`, passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );

  render(
    <ApiProvider
      client={makeFakeApi({
        listMoodboards: async () => [
          { id: "mood-1", name: "Warm references", createdAt: 1, updatedAt: 2, archivedAt: null, coverAssetId: null, coverUrl: null },
        ],
        streamRun: streamRun as never,
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "First run" } });
  await user.click(screen.getByLabelText("Send"));
  await waitFor(() => expect(streamRun).toHaveBeenCalledTimes(1));

  const addMenu = await screen.findByRole("button", { name: "Add files and context" });
  addMenu.focus();
  fireEvent.pointerDown(addMenu, { button: 0, ctrlKey: false });
  fireEvent.keyDown(addMenu, { key: "Enter" });
  await user.click(await screen.findByText("Reference a moodboard"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Warm references" }));
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Use queued visual direction" } });
  await user.click(screen.getByLabelText("Queue"));

  const queuedPrompt = (await screen.findByLabelText("Queued prompt 1")) as HTMLTextAreaElement;
  expect(queuedPrompt.value).toContain("Warm references");
  releaseFirstRun();

  await waitFor(() => expect(streamRun).toHaveBeenCalledTimes(2));
  expect(streamRun.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({
      brief: expect.stringContaining("Use queued visual direction"),
      moodboardRefs: [{ id: "mood-1", name: "Warm references" }],
    }),
  );
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

test("idle user messages expose a copy action below the bubble", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(async () => {});
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [{ id: "m1", conversationId: "c1", role: "user" as const, content: "Make it **bolder**.", createdAt: 1 }],
  });

  try {
    render(
      <ApiProvider client={fake}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    const bubbleText = await screen.findByText("bolder");
    const actions = await screen.findByTestId("user-message-actions");
    const copy = within(actions).getByRole("button", { name: "Copy message" });
    expect(bubbleText.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith("Make it **bolder**.");
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
  const inspect = screen.getByLabelText("Inspect panel");
  expect(within(inspect).getByText("H1")).toBeInTheDocument();
  expect(within(inspect).getAllByText("section.hero > h1").length).toBeGreaterThan(0);
  expect(within(inspect).getAllByText("320").length).toBeGreaterThan(0);
  expect(within(inspect).getAllByText("48").length).toBeGreaterThan(0);
  expect(screen.getByRole("separator", { name: "Resize inspect panel" })).toBeInTheDocument();
});

test("inspect mode continuously captures real preview element attributes", async () => {
  const fake = makeFakeApi({
    getProject: async () => ({
      id: "p1",
      name: "Preview Project",
      skillId: null,
      designSystemId: "clean",
      mode: "prototype",
      createdAt: 1,
      updatedAt: 1,
    }),
    listDesignSystems: async () => [
      {
        id: "clean",
        name: "Clean",
        category: "Default",
        summary: "Neutral interface tokens",
        swatch: { bg: "#ffffff", surface: "#f6f6f6", fg: "#111111", accent: "#2563eb" },
      },
    ],
    listFiles: async () => [{ path: "index.html", size: 120 }],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const iframe = (await screen.findByTitle("Artifact preview")) as HTMLIFrameElement;
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.click(screen.getByLabelText("Inspect preview"));

  expect(await screen.findByRole("separator", { name: "Resize inspect panel" })).toBeInTheDocument();
  expect(screen.queryByText("Click an element to inspect · Esc to cancel")).toBeNull();
  const emptyInspect = screen.getByLabelText("Inspect panel");
  expect(within(emptyInspect).getByText("Project variables")).toBeInTheDocument();
  expect(await within(emptyInspect).findByText("#2563eb")).toBeInTheDocument();
  expect(within(emptyInspect).queryByText("Selection")).toBeNull();

  dispatchPreviewMessage({
    type: "selected",
    selector: "section.hero > h1",
    tag: "h1",
    text: "Enterprise pricing made simple",
    rect: { x: 24, y: 40, w: 320, h: 48 },
    styles: {
      display: "block",
      position: "static",
      zIndex: "auto",
      overflow: "visible",
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "baseline",
      gap: "24px",
      padding: "12px 16px",
      margin: "0px",
      gridTemplateColumns: "none",
      gridTemplateRows: "none",
      background: "rgb(255, 255, 255)",
      backgroundImage: "linear-gradient(rgb(255, 255, 255), rgb(245, 245, 245))",
      color: "rgb(17, 17, 17)",
      fontFamily: "Inter, sans-serif",
      fontSize: "64px",
      fontWeight: "700",
      lineHeight: "72px",
      letterSpacing: "0px",
      textAlign: "center",
      textTransform: "none",
      borderRadius: "0px",
      opacity: "1",
      borderTopColor: "rgb(17, 17, 17)",
      borderTopWidth: "2px",
      borderTopStyle: "solid",
      borderRightColor: "rgb(17, 17, 17)",
      borderRightWidth: "2px",
      borderRightStyle: "solid",
      borderBottomColor: "rgb(17, 17, 17)",
      borderBottomWidth: "2px",
      borderBottomStyle: "solid",
      borderLeftColor: "rgb(17, 17, 17)",
      borderLeftWidth: "2px",
      borderLeftStyle: "solid",
      outlineColor: "rgb(0, 0, 0)",
      outlineWidth: "0px",
      outlineStyle: "none",
      boxShadow: "rgba(0, 0, 0, 0.2) 0px 10px 30px",
      filter: "none",
      backdropFilter: "blur(12px)",
      transform: "matrix(1, 0, 0, 1, 0, 0)",
      mixBlendMode: "normal",
    },
    attrs: {
      id: "hero-title",
      className: "hero title",
      role: "heading",
      ariaLabel: "Hero title",
      screenLabel: "Hero headline",
    },
  });

  await waitFor(() => expect(within(screen.getByLabelText("Inspect panel")).getByText("Hero headline")).toBeInTheDocument());
  await waitFor(() => {
    const pickModeCalls = postMessage.mock.calls.filter(
      ([message]) => (message as { type?: string; on?: boolean }).type === "select-mode" && (message as { on?: boolean }).on === true,
    );
    expect(pickModeCalls.length).toBeGreaterThan(1);
  });
  const inspect = screen.getByLabelText("Inspect panel");
  expect(within(inspect).getAllByText("section.hero > h1").length).toBeGreaterThan(0);
  expect(within(inspect).getByText("64px")).toBeInTheDocument();
  expect(within(inspect).getByText("24px")).toBeInTheDocument();
  expect(within(inspect).getByText("12px 16px")).toBeInTheDocument();
  expect(within(inspect).getByText("Inter, sans-serif")).toBeInTheDocument();
  expect(within(inspect).getByText("72px")).toBeInTheDocument();
  expect(within(inspect).getByText("linear-gradient(rgb(255, 255, 255), rgb(245, 245, 245))")).toBeInTheDocument();
  expect(within(inspect).getByText("rgb(255, 255, 255)")).toBeInTheDocument();
  expect(within(inspect).getByText("2px")).toBeInTheDocument();
  expect(within(inspect).getByText("solid")).toBeInTheDocument();
  expect(within(inspect).getByText("rgba(0, 0, 0, 0.2) 0px 10px 30px")).toBeInTheDocument();
  expect(within(inspect).getByText("blur(12px)")).toBeInTheDocument();
  expect(within(inspect).getByText("matrix(1, 0, 0, 1, 0, 0)")).toBeInTheDocument();
  expect(within(inspect).getByText("hero-title")).toBeInTheDocument();
  expect(within(inspect).getByText("hero title")).toBeInTheDocument();
  expect(within(inspect).queryByText("Auto layout")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();

  dispatchPreviewMessage({
    type: "selected",
    selector: "button.cta",
    tag: "button",
    text: "Start",
    rect: { x: 64, y: 112, w: 120, h: 40 },
    styles: {
      display: "inline-flex",
      position: "relative",
      background: "rgb(17, 17, 17)",
      color: "rgb(255, 255, 255)",
      fontSize: "16px",
    },
  });

  await waitFor(() => expect(within(screen.getByLabelText("Inspect panel")).getByText("BUTTON")).toBeInTheDocument());
  expect(within(screen.getByLabelText("Inspect panel")).getAllByText("button.cta").length).toBeGreaterThan(0);
  expect(within(screen.getByLabelText("Inspect panel")).queryByText("Hero headline")).toBeNull();

  fireEvent.click(screen.getByLabelText("Select an element"));
  expect(screen.queryByLabelText("Inspect panel")).toBeNull();
  expect(screen.getByText("Click an element to attach it · Esc to cancel")).toBeInTheDocument();
});

test("inspect and selection modes keep the preview iframe mounted and use two-step Escape", async () => {
  const fake = makeFakeApi({
    listFiles: async () => [{ path: "index.html", size: 120 }],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const iframe = (await screen.findByTitle("Artifact preview")) as HTMLIFrameElement;
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

  fireEvent.click(screen.getByLabelText("Inspect preview"));
  expect(await screen.findByLabelText("Inspect panel")).toBeInTheDocument();
  expect(screen.getByTitle("Artifact preview")).toBe(iframe);
  expect(screen.getByLabelText("Inspect preview").className).toContain("!bg-primary");
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ source: "dezin-parent", type: "select-mode", on: true }, "*"));
  expect(screen.queryByText("Click an element to inspect · Esc to cancel")).toBeNull();

  dispatchPreviewMessage({
    type: "selected",
    selector: "section.hero > h1",
    tag: "h1",
    text: "Title",
    rect: { x: 24, y: 40, w: 320, h: 48 },
    styles: { display: "block", position: "static" },
  });
  expect(await within(screen.getByLabelText("Inspect panel")).findByText("H1")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(within(screen.getByLabelText("Inspect panel")).getByText("Project variables")).toBeInTheDocument());
  expect(screen.queryByText("H1")).toBeNull();
  expect(postMessage).toHaveBeenCalledWith({ source: "dezin-parent", type: "clear" }, "*");
  expect(postMessage).toHaveBeenCalledWith({ source: "dezin-parent", type: "select-mode", on: true }, "*");

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("Inspect panel")).toBeNull());
  expect(screen.getByTitle("Artifact preview")).toBe(iframe);

  fireEvent.click(screen.getByLabelText("Select an element"));
  expect(screen.getByTitle("Artifact preview")).toBe(iframe);
  expect(screen.getByLabelText("Select an element").className).toContain("!bg-primary");
  expect(screen.getByText("Click an element to attach it · Esc to cancel")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("Click an element to attach it · Esc to cancel")).toBeNull());
  expect(screen.getByTitle("Artifact preview")).toBe(iframe);
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
    expect(jump.className).not.toContain("before:animate-spin");
    expect(jump.style.bottom).toBe("calc(100% + 12px)");

    fireEvent.click(jump);
    expect(scroll.scrollTop).toBe(1200);
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});

test("scroll to bottom button shows a subtle loading ring while generation is running", async () => {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "conversation-scroll" ? 1200 : 0;
  });
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "conversation-scroll" ? 360 : 0;
  });
  let finishRun!: () => void;
  const runDone = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const streamRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {
    yield { type: "run-start", runId: "r-scroll", conversationId: "c1" };
    yield { type: "activity", activity: { kind: "text", text: "Still generating." } };
    await runDone;
    yield { type: "run-done", runId: "r-scroll", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
  });
  try {
    render(
      <ApiProvider client={makeFakeApi({ streamRun })}>
        <WorkspaceScreen projectId="p1" />
      </ApiProvider>,
    );

    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "make it" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await screen.findByText("Still generating.");

    const scroll = screen.getByTestId("conversation-scroll");
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    const jump = await screen.findByRole("button", { name: "Scroll to bottom" });
    expect(jump.className).toContain("before:animate-spin");
  } finally {
    finishRun?.();
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
  dispatchPreviewMessage({
    type: "selected",
    selector: "section.hero > h1",
    tag: "h1",
    text: "Enterprise pricing made simple",
    rect: { x: 24, y: 40, w: 320, h: 48 },
  });
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
  expect((await screen.findByRole("tablist", { name: "Artifact views" })).className).toContain("[&_[role=tab]]:px-2");
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
  // The Files viewer syntax-highlights code, so `#101010` is tokenized into its own <span> —
  // the declaration is split across nodes. Assert on the <code> element's full textContent.
  const codeEl = await screen.findByText(
    (_content, el) => el?.tagName === "CODE" && (el.textContent ?? "").includes("--accent:#101010"),
  );
  expect(codeEl).toBeInTheDocument();
});

test("the Versions dropdown groups branch versions with switching, set cover, and Restore", async () => {
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
  expect(screen.queryByRole("tab", { name: "Versions" })).toBeNull();
  expect(await screen.findByTestId("versions-tabs-separator")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
  expect(await screen.findByText("Main")).toBeInTheDocument();
  expect((await screen.findAllByText("Exploration")).length).toBeGreaterThan(0);
  expect(await screen.findByText("92/100")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Switch to Main v1" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Set Main v1 as cover" }));
  await waitFor(() => expect(setVersionCover).toHaveBeenCalledWith("p1", "r1"));
  // the active branch's newest version has no Restore (it IS current); the older branch version does
  fireEvent.click(screen.getByRole("button", { name: "Restore Main v1" }));
  await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith("p1", "r1"));
});

test("switching a version updates Preview, Files, and Quality to that run", async () => {
  const getVersionPreview = vi.fn(async (_projectId: string, runId: string) => ({ url: `/api/projects/p1/versions/${runId}`, mode: "prototype" as const }));
  const getVersionText = vi.fn(async (_projectId: string, runId: string) =>
    runId === "r-old" ? "<html><body><h1>Older version file</h1></body></html>" : "<html><body><h1>Latest version file</h1></body></html>",
  );
  const fake = makeFakeApi({
    listFiles: async () => [{ path: "index.html", size: 31 }],
    getFileText: async () => "<html><body><h1>Current live file</h1></body></html>",
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [],
    listVariants: async () => [{ id: "main", projectId: "p1", name: "Main", createdAt: 1, active: true }],
    listRuns: async () => [
      {
        id: "r-new",
        variantId: "main",
        status: "succeeded" as const,
        score: 100,
        repairRounds: 0,
        lintPassed: true,
        createdAt: 1700000001000,
        finishedAt: 1700000001001,
        findings: [],
      },
      {
        id: "r-old",
        variantId: "main",
        status: "succeeded" as const,
        score: 88,
        repairRounds: 1,
        lintPassed: true,
        createdAt: 1700000000000,
        finishedAt: 1700000000001,
        findings: [
          {
            severity: "P1",
            id: "visual-ai-review-1",
            message: "The old mobile CTA is clipped.",
            fix: "Reduce the mobile hero height.",
            reviewSummary: "codebuddy / hunyuan reviewed the older screenshot and reported 1 issue.",
            screenshotUrl: "/projects/p1/preview/.visual-qa/old.png",
          },
        ],
      },
    ],
    getVersionPreview,
    getVersionText,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Switch to Main v1" }));

  await waitFor(() => expect(getVersionPreview).toHaveBeenCalledWith("p1", "r-old"));
  expect(screen.getByTitle("Artifact preview")).toHaveAttribute("src", expect.stringMatching(/^\/api\/projects\/p1\/versions\/r-old\?t=\d+$/));

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await screen.findByText(/Older version file/)).toBeInTheDocument();
  expect(screen.queryByText(/Current live file/)).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText("88/100")).toBeInTheDocument();
  expect(screen.getByText(/old mobile CTA is clipped/)).toBeInTheDocument();
  expect(screen.getByText(/reviewed the older screenshot/)).toBeInTheDocument();
});

test("version compare uses the active branch's newest run as current even when runs arrive unsorted", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "First", createdAt: 1 }],
    listMessages: async () => [],
    listVariants: async () => [{ id: "main", projectId: "p1", name: "Main", createdAt: 1, active: true }],
    listRuns: async () => [
      { id: "r-old", variantId: "main", status: "succeeded" as const, score: 90, repairRounds: 0, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
      { id: "r-new", variantId: "main", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000001000, finishedAt: 1700000001001 },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
  expect(await screen.findByRole("button", { name: "Switch to Main v2" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Compare Main v1 visually" }));

  const oldFrame = await screen.findByTitle("Main v1");
  const currentFrame = await screen.findByTitle("Main current");
  expect(oldFrame).toHaveAttribute("src", expect.stringMatching(/^\/api\/projects\/p1\/versions\/r-old\?t=\d+$/));
  expect(currentFrame).toHaveAttribute("src", expect.stringMatching(/^\/api\/projects\/p1\/versions\/r-new\?t=\d+$/));
});

test("refreshing a viewed standard version keeps the version preview instead of jumping to live current", async () => {
  const getDevServerUrl = vi.fn(async () => ({ url: "http://127.0.0.1:5300/p1" }));
  const getVersionPreview = vi.fn(async () => ({ url: "http://127.0.0.1:5401/", mode: "standard" as const }));
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
      { id: "r1", variantId: "main", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
    ],
    getDevServerUrl,
    getVersionPreview,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(getDevServerUrl).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Switch to Main v1" }));
  await waitFor(() => expect(screen.getByTitle("Artifact preview")).toHaveAttribute("src", expect.stringMatching(/^http:\/\/127\.0\.0\.1:5401\/\?t=\d+$/)));

  fireEvent.click(screen.getByLabelText("Refresh preview"));

  await waitFor(() => expect(getVersionPreview).toHaveBeenCalledTimes(2));
  expect(screen.getByTitle("Artifact preview")).toHaveAttribute("src", expect.stringMatching(/^http:\/\/127\.0\.0\.1:5401\/\?t=\d+$/));
  expect(getDevServerUrl).toHaveBeenCalledTimes(1);
});

test("viewing a standard version resolves the dev-server URL before rendering the iframe", async () => {
  let resolveVersionPreview!: (value: { url: string; mode: "standard" }) => void;
  const getVersionPreview = vi.fn(
    () =>
      new Promise<{ url: string; mode: "standard" }>((resolve) => {
        resolveVersionPreview = resolve;
      }),
  );
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
      { id: "r1", variantId: "main", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
    ],
    getDevServerUrl: async () => ({ url: "http://127.0.0.1:5300/current" }),
    getVersionPreview,
  } as never);
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Switch to Main v1" }));

  expect(getVersionPreview).toHaveBeenCalledWith("p1", "r1");
  expect(await screen.findByText("Loading version preview")).toBeInTheDocument();

  resolveVersionPreview({ url: "http://127.0.0.1:5401/", mode: "standard" });

  await waitFor(() => expect(screen.getByTitle("Artifact preview")).toHaveAttribute("src", expect.stringMatching(/^http:\/\/127\.0\.0\.1:5401\/\?t=\d+$/)));
  expect(screen.getByTitle("Artifact preview").getAttribute("sandbox") ?? "").toContain("allow-same-origin");
  expect(screen.queryByText("Loading version preview")).toBeNull();
});

test("standard version compare resolves both dev-server URLs before opening the frames", async () => {
  const pending = new Map<string, (value: { url: string; mode: "standard" }) => void>();
  const getVersionPreview = vi.fn(
    (_projectId: string, runId: string) =>
      new Promise<{ url: string; mode: "standard" }>((resolve) => {
        pending.set(runId, resolve);
      }),
  );
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
      { id: "r-old", variantId: "main", status: "succeeded" as const, score: 90, repairRounds: 0, lintPassed: true, createdAt: 1700000000000, finishedAt: 1700000000001 },
      { id: "r-new", variantId: "main", status: "succeeded" as const, score: 100, repairRounds: 0, lintPassed: true, createdAt: 1700000001000, finishedAt: 1700000001001 },
    ],
    getDevServerUrl: async () => ({ url: "http://127.0.0.1:5300/current" }),
    getVersionPreview,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Compare Main v1 visually" }));

  await waitFor(() => expect(getVersionPreview).toHaveBeenCalledWith("p1", "r-old"));
  expect(getVersionPreview).toHaveBeenCalledWith("p1", "r-new");
  expect(await screen.findByText("Loading version comparison")).toBeInTheDocument();

  pending.get("r-old")?.({ url: "http://127.0.0.1:5401/", mode: "standard" });
  pending.get("r-new")?.({ url: "http://127.0.0.1:5402/", mode: "standard" });

  const oldFrame = await screen.findByTitle("Main v1");
  const currentFrame = await screen.findByTitle("Main current");
  expect(oldFrame).toHaveAttribute("src", expect.stringMatching(/^http:\/\/127\.0\.0\.1:5401\/\?t=\d+$/));
  expect(currentFrame).toHaveAttribute("src", expect.stringMatching(/^http:\/\/127\.0\.0\.1:5402\/\?t=\d+$/));
  expect(oldFrame.getAttribute("sandbox") ?? "").toContain("allow-same-origin");
  expect(currentFrame.getAttribute("sandbox") ?? "").toContain("allow-same-origin");
  expect(screen.queryByText("Loading version comparison")).toBeNull();
});

test("artifact header keeps Versions, divider, and tabs tight", async () => {
  render(
    <ApiProvider client={makeFakeApi()}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByRole("button", { name: "Versions" });
  const separator = screen.getByTestId("versions-tabs-separator");
  expect(separator).toHaveClass("mx-0.5");
  expect(separator).not.toHaveClass("mx-1");
  expect(screen.getByRole("tablist", { name: "Artifact views" })).toHaveClass("[&_[role=tab]]:px-2");
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

  fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
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
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
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
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByText(/Done, quality 94\/100/);
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/raw hex values/)).toBeInTheDocument();
  expect(screen.getByText(/Large rounded card radius/)).toBeInTheDocument();
  expect(screen.queryByText(/No quality issues\. Clean/)).toBeNull();
});

test("the Quality tab renders Sharingan findings as required instead of priority tiers", async () => {
  const fake = makeFakeApi({
    getProject: async () => ({
      id: "p1",
      name: "TapNow clone",
      skillId: null,
      designSystemId: null,
      mode: "standard",
      sharingan: true,
      sourceUrl: "https://app.tapnow.ai/home",
      createdAt: 1,
      updatedAt: 1,
    }),
    listRuns: async (): Promise<RunSummary[]> => [
      {
        id: "r-sharingan",
        conversationId: "c1",
        variantId: "main",
        status: "succeeded",
        score: 92,
        repairRounds: 0,
        lintPassed: false,
        findings: [
          { severity: "P2", id: "visual-improve-1", message: "The active nav pill is missing.", fix: "Recreate the source nav pill." },
        ],
        createdAt: 1,
        finishedAt: 2,
      },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  await screen.findByText("TapNow clone");
  fireEvent.click(await screen.findByRole("tab", { name: /Quality/ }));

  expect(await screen.findByText("Required")).toBeInTheDocument();
  expect(screen.queryByText("P2")).toBeNull();
  expect(screen.getByText(/active nav pill/)).toBeInTheDocument();
});

test("the Quality tab separates static, geometry, and agent visual lanes", async () => {
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
          { severity: "P2", id: "visual-ai-review-1", message: "The button is visibly misaligned.", fix: "Align the button to the form baseline." },
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
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByText(/Done, quality 89\/100/);
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));

  expect(await screen.findByText("Static anti-slop")).toBeInTheDocument();
  expect(screen.getByText("Geometry")).toBeInTheDocument();
  expect(screen.getByText("Agent visual review")).toBeInTheDocument();
  expect(screen.getByText(/Desktop viewport has horizontal overflow/)).toBeInTheDocument();
  expect(screen.getByText(/button is visibly misaligned/)).toBeInTheDocument();
  expect(screen.getByText(/raw hex values/)).toBeInTheDocument();
});

test("visual review stream events render a titled transcript record with collapsible process and result", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-visual-review", conversationId: "c1" };
      yield {
        type: "visual-qa-start",
        runId: "r-visual-review",
        enabled: true,
        round: 0,
        agentCommand: "codebuddy",
        model: "hunyuan",
        screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
      };
      yield {
        type: "visual-qa",
        runId: "r-visual-review",
        enabled: true,
        findings: [
          {
            severity: "P1",
            id: "visual-ai-review-1",
            message: "Hero image overlaps the navigation.",
            fix: "Move the navigation above the image layer.",
            screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
            reviewSummary: "codebuddy / hunyuan reviewed the screenshot and reported 1 issue.",
          },
        ],
      };
      yield { type: "run-done", runId: "r-visual-review", passed: true, rounds: 0, score: 91, findings: [] };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));

  const record = await screen.findByTestId("visual-review-message");
  expect(within(record).getByText("Visual Review")).toBeInTheDocument();
  expect(within(record).getByRole("button", { name: /Visual Review process/ })).toHaveAttribute("aria-expanded", "false");
  expect(within(record).getByText(/Hero image overlaps the navigation/)).toBeInTheDocument();

  fireEvent.click(within(record).getByRole("button", { name: /Visual Review process/ }));
  expect(within(record).getByText(/Reviewing screenshot with codebuddy \/ hunyuan/)).toBeInTheDocument();
});

test("reopening a project restores persisted visual review transcript records", async () => {
  const fake = makeFakeApi({
    listConversations: async () => [{ id: "c1", projectId: "p1", title: "Chat", createdAt: 1 }],
    listMessages: async () => [
      { id: "m1", conversationId: "c1", role: "user" as const, content: "make a campaign page", createdAt: 1 },
      {
        id: "m2",
        conversationId: "c1",
        role: "system" as const,
        content: JSON.stringify({
          visualReview: {
            status: "complete",
            enabled: true,
            round: 0,
            agentCommand: "codebuddy",
            model: "hunyuan",
            screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
            summary: "codebuddy / hunyuan reviewed the screenshot and reported 1 issue.",
            findings: [
              {
                severity: "P1",
                id: "visual-ai-review-1",
                message: "Hero image overlaps the navigation.",
                fix: "Move the navigation above the image layer.",
                screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
              },
            ],
            process: [
              { type: "tool", summary: "Captured preview screenshot" },
              { type: "tool", summary: "Reviewing screenshot with codebuddy / hunyuan" },
            ],
          },
        }),
        createdAt: 2,
      },
    ],
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const record = await screen.findByTestId("visual-review-message");
  expect(within(record).getByText("Visual Review")).toBeInTheDocument();
  expect(within(record).getByText(/reviewed the screenshot and reported 1 issue/)).toBeInTheDocument();
  expect(within(record).getByText(/Hero image overlaps the navigation/)).toBeInTheDocument();

  fireEvent.click(within(record).getByRole("button", { name: /Visual Review process/ }));
  expect(within(record).getByText(/Reviewing screenshot with codebuddy \/ hunyuan/)).toBeInTheDocument();
});

test("static quality stream events update the Quality pane while a run is still active", async () => {
  let release: (() => void) | undefined;
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-static-quality", conversationId: "c1" };
      yield {
        type: "static-quality",
        runId: "r-static-quality",
        round: 0,
        findings: [{ severity: "P2", id: "raw-hex", message: "2 raw hex values outside :root.", fix: "Move colours into tokens." }],
      };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  try {
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
    fireEvent.click(screen.getByLabelText("Send"));
    fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
    expect(await screen.findByText(/raw hex values/)).toBeInTheDocument();
    expect(screen.queryByText(/No quality issues\. Clean/)).toBeNull();
  } finally {
    release?.();
  }
});

test("prototype preview-update stream events refresh the preview during generation", async () => {
  let release: (() => void) | undefined;
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-preview", conversationId: "c1" };
      yield { type: "preview-update", runId: "r-preview", t: 123456 };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  try {
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(await screen.findByTitle("Artifact preview")).toHaveAttribute("src", "/projects/p1/preview/?t=123456");
  } finally {
    release?.();
  }
});

test("standard preview-update stream events use the live dev-server URL and refresh versions during generation", async () => {
  let release: (() => void) | undefined;
  let runs: RunSummary[] = [];
  const listRuns = vi.fn(async () => runs);
  const streamRun = vi.fn(async function* (): AsyncGenerator<RunEvent> {
    yield { type: "run-start", runId: "r-live", conversationId: "c1" };
    runs = [
      {
        id: "r-live",
        conversationId: "c1",
        variantId: "main",
        status: "running",
        score: null,
        repairRounds: 0,
        lintPassed: false,
        createdAt: 1700000001000,
        finishedAt: null,
      },
    ];
    yield {
      type: "preview-update",
      runId: "r-live",
      mode: "standard",
      previewUrl: "http://127.0.0.1:5310/",
      t: 123456,
    };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
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
    listRuns,
    getDevServerUrl: async () => ({ url: "http://127.0.0.1:5300/p1" }),
    listFiles: async () => [{ path: "src/App.jsx", size: 120 }],
    streamRun,
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  try {
    await screen.findByLabelText("Message");
    const listRunsBeforeSend = listRuns.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(() =>
      expect(screen.getByTitle("Artifact preview")).toHaveAttribute("src", "http://127.0.0.1:5310/?t=123456"),
    );
    await waitFor(() => expect(listRuns.mock.calls.length).toBeGreaterThan(listRunsBeforeSend));

    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(await screen.findByText("Generating")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Main v1" })).toBeDisabled();
  } finally {
    release?.();
  }
});

test("the Agent visual review quality lane shows the screenshot review summary", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-visual-summary", conversationId: "c1" };
      yield {
        type: "visual-qa",
        runId: "r-visual-summary",
        enabled: true,
        findings: [
          {
            severity: "P2",
            id: "visual-ai-review-1",
            message: "The call-to-action is clipped on mobile.",
            fix: "Reduce the mobile headline block height.",
            screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
            reviewSummary: "codebuddy / hunyuan reviewed the screenshot and reported 1 issue.",
          },
        ],
      };
      yield {
        type: "run-done",
        runId: "r-visual-summary",
        passed: true,
        rounds: 0,
        score: 93,
        findings: [
          {
            severity: "P2",
            id: "visual-ai-review-1",
            message: "The call-to-action is clipped on mobile.",
            fix: "Reduce the mobile headline block height.",
            screenshotUrl: "/projects/p1/preview/.visual-qa/screenshot.png",
            reviewSummary: "codebuddy / hunyuan reviewed the screenshot and reported 1 issue.",
          },
        ],
      };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByText(/Done, quality 93\/100/);
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));

  const image = (await screen.findByAltText("Visual review screenshot")) as HTMLImageElement;
  expect(image).toHaveAttribute("src", "/projects/p1/preview/.visual-qa/screenshot.png");
  const agentLane = screen.getByText("Agent visual review").closest("section");
  expect(agentLane).not.toBeNull();
  expect(within(agentLane as HTMLElement).getByText(/codebuddy \/ hunyuan reviewed the screenshot/)).toBeInTheDocument();
  expect(within(agentLane as HTMLElement).getByText(/call-to-action is clipped on mobile/)).toBeInTheDocument();
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
      yield { type: "visual-qa", enabled: true, findings: [] };
      yield { type: "run-done", runId: "r2", passed: true, rounds: 0, score: 100 };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));
  await screen.findByTitle("Artifact preview");
  fireEvent.click(screen.getByRole("tab", { name: /Quality/ }));
  expect(await screen.findByText(/No findings in recorded checks/)).toBeInTheDocument();
  expect(screen.getByText("Static anti-slop")).toBeInTheDocument();
  expect(screen.getAllByText("100/100").length).toBeGreaterThan(0); // shown in the score header (and result card)
});

test("generated material sources render only in the run result card", async () => {
  const fake = makeFakeApi({
    streamRun: async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-assets", conversationId: "c1" };
      yield { type: "images", count: 2 };
      yield { type: "run-done", runId: "r-assets", passed: true, rounds: 0, score: 100, findings: [] };
    },
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));

  expect(await screen.findByText("Material sources")).toBeInTheDocument();
  expect(screen.getByText("Generated image assets (2)")).toBeInTheDocument();
});

test("the variant fan-out button is exposed on Standard projects and enables once there's a brief", async () => {
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({ id: "p1", name: "Standard", skillId: null, designSystemId: "modern-minimal", mode: "standard", createdAt: 1, updatedAt: 1 }),
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByLabelText("Message");
  const button = screen.getByLabelText("Generate variants");
  expect(button).toBeInTheDocument();
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "explore bolder hero directions" } });
  expect(button).toBeEnabled();
});

test("the variant fan-out button is hidden on Prototype projects (targeted variant runs are Standard-only)", async () => {
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({ id: "p1", name: "Proto", skillId: null, designSystemId: "modern-minimal", mode: "prototype", createdAt: 1, updatedAt: 1 }),
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByLabelText("Message");
  expect(screen.queryByLabelText("Generate variants")).toBeNull();
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
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "go" } });
  fireEvent.click(screen.getByLabelText("Send"));

  // intermediate "Found N issues" status is transient; the result card records the run
  expect(await screen.findByText("Fixed it.")).toBeInTheDocument();
  expect(await screen.findByText(/after 1 fix/)).toBeInTheDocument();
});

test("a fatal runtime-error shows the crash overlay and Fix dispatches a repair run", async () => {
  const streamRun = vi.fn(() => (async function* (): AsyncGenerator<RunEvent> {})());
  render(
    <ApiProvider
      client={makeFakeApi({
        streamRun: streamRun as never,
        listFiles: async () => [{ path: "index.html", size: 12 }],
        listAgents: async () => AGENTS,
      })}
    >
      <AgentsProvider>
        <WorkspaceScreen projectId="p1" />
      </AgentsProvider>
    </ApiProvider>,
  );
  await screen.findByTitle("Artifact preview"); // preview iframe present (same setup as the other preview tests)
  dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: "render blew up", count: 1, at: 1 });
  expect(await screen.findByText("render blew up")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /fix with agent/i }));
  await waitFor(() =>
    expect(streamRun).toHaveBeenCalledWith(expect.objectContaining({ brief: expect.stringMatching(/render blew up/) }), expect.anything()),
  );
});

test("auto-fix dispatches one repair when enabled and a fatal error arrives while idle", async () => {
  const streamRun = vi.fn(() => (async function* (): AsyncGenerator<RunEvent> {})());
  render(
    <ApiProvider
      client={makeFakeApi({
        streamRun: streamRun as never,
        listFiles: async () => [{ path: "index.html", size: 12 }],
        listAgents: async () => AGENTS,
        getSettings: async () => ({ agentCommand: "claude", model: "", autoFixLiveRuntimeErrors: true }) as never,
      })}
    >
      <AgentsProvider>
        <WorkspaceScreen projectId="p1" />
      </AgentsProvider>
    </ApiProvider>,
  );
  await screen.findByTitle("Artifact preview");
  dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: "auto boom", count: 1, at: 1 });
  await waitFor(() => expect(streamRun).toHaveBeenCalledTimes(1));
  dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: "auto boom", count: 1, at: 1 }); // same signature must not re-fire
  await new Promise((r) => setTimeout(r, 0));
  expect(streamRun).toHaveBeenCalledTimes(1);
});

test("auto-fix stops dispatching once the per-conversation cap is reached", async () => {
  const streamRun = vi.fn(() => (async function* (): AsyncGenerator<RunEvent> {})());
  render(
    <ApiProvider
      client={makeFakeApi({
        streamRun: streamRun as never,
        listFiles: async () => [{ path: "index.html", size: 12 }],
        listAgents: async () => AGENTS,
        getSettings: async () => ({ agentCommand: "claude", model: "", autoFixLiveRuntimeErrors: true }) as never,
      })}
    >
      <AgentsProvider>
        <WorkspaceScreen projectId="p1" />
      </AgentsProvider>
    </ApiProvider>,
  );
  await screen.findByTitle("Artifact preview");

  // Each dispatch uses a distinct `message` so signature-dedupe doesn't mask the cap.
  // `running` (and the error model's `runActive` gate) must settle back to false between
  // dispatches — otherwise the next fatal is dropped by ingestRuntimeError, not the cap —
  // so we waitFor each streamRun call to register before firing the next distinct fatal.
  const distinctFatals = ["crash one", "crash two", "crash three", "crash four", "crash five"];
  for (let i = 0; i < distinctFatals.length; i++) {
    dispatchPreviewMessage({ type: "runtime-error", kind: "fatal", errorType: "error", message: distinctFatals[i], count: 1, at: i + 1 });
    if (i < AUTO_FIX_MAX_PER_CONVERSATION) {
      await waitFor(() => expect(streamRun).toHaveBeenCalledTimes(i + 1));
    } else {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  expect(streamRun.mock.calls.length).toBeLessThanOrEqual(AUTO_FIX_MAX_PER_CONVERSATION);
  expect(streamRun).toHaveBeenCalledTimes(AUTO_FIX_MAX_PER_CONVERSATION);
});

test("shows an auto-selected Sharingan tab for a sharingan project", async () => {
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Cloned Site",
          skillId: null,
          designSystemId: "modern-minimal",
          mode: "standard",
          createdAt: 1,
          updatedAt: 1,
          sharingan: true,
          sourceUrl: "https://example.com",
        }),
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const tab = await screen.findByRole("tab", { name: /Sharingan/i });
  expect(tab).toBeInTheDocument();
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("button", { name: "Design system" })).not.toBeInTheDocument();
});

test("shows no Sharingan tab for a normal project", async () => {
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => ({
          id: "p1",
          name: "Regular",
          skillId: null,
          designSystemId: "modern-minimal",
          mode: "prototype",
          createdAt: 1,
          updatedAt: 1,
          sharingan: false,
        }),
      })}
    >
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByLabelText("Message");
  expect(screen.queryByRole("tab", { name: /Sharingan/i })).not.toBeInTheDocument();
});
