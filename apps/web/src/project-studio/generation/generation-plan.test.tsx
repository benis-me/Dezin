import { readFileSync } from "node:fs";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ApiProvider } from "../../lib/api-context.tsx";
import { GenerationPlanStreamError } from "../../lib/api.ts";
import type {
  GenerationPlan,
  GenerationPlanDetail,
  GenerationPlanEvent,
  GenerationTask,
  GenerationTaskStatus,
} from "../../lib/api.ts";
import { makeFakeApi } from "../../test/fake-api.ts";
import {
  GenerationPlanInspector,
  GenerationPlanPanel,
} from "./GenerationPlanPanel.tsx";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function chooseGenerationPlan(
  user: ReturnType<typeof userEvent.setup>,
  planId: string,
): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: "Selected generation plan" }));
  const options = await screen.findAllByRole("option");
  const option = options.find((candidate) => candidate.getAttribute("data-plan-id") === planId);
  expect(option).toBeDefined();
  await user.click(option!);
}

function plan(status: GenerationPlan["status"] = "running"): GenerationPlan {
  return {
    id: "plan-1",
    workspaceId: "workspace-1",
    proposalId: "proposal-1",
    proposalRevision: 2,
    baseSnapshotId: "snapshot-1",
    status,
    constructionSealed: true,
    compileError: null,
    createdAt: 10,
    finishedAt: null,
  };
}

function task(
  id: string,
  kind: GenerationTask["kind"],
  status: GenerationTaskStatus,
  overrides: Partial<GenerationTask> = {},
): GenerationTask {
  return {
    id,
    ordinal: Number(id.slice(-1)) || 0,
    workspaceId: "workspace-1",
    planId: "plan-1",
    kind,
    target: kind === "resource"
      ? { type: "resource", workspaceId: "workspace-1", id: "resource-brand" }
      : kind === "checkpoint" || kind === "prototype-validation"
        ? { type: "workspace", workspaceId: "workspace-1", id: "workspace-1" }
        : { type: "artifact", workspaceId: "workspace-1", id: `artifact-${kind}`, trackId: `track-${kind}` },
    dependencyIds: [],
    capabilities: [],
    status,
    blockedReason: null,
    blockedByTaskId: null,
    pendingContextPolicy: null,
    currentAttempt: status === "materialization-pending" ? 0 : 1,
    materializationFailures: 0,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: null,
    createdAt: 10,
    finishedAt: status === "succeeded" ? 20 : null,
    ...overrides,
  };
}

function detail(overrides: Partial<GenerationPlanDetail> = {}): GenerationPlanDetail {
  return {
    plan: plan(),
    tasks: [
      task("task-1", "resource", "succeeded", { resultResourceRevisionId: "resource-revision-1" }),
      task("task-2", "component", "running", { dependencyIds: ["task-1"], currentAttempt: 2 }),
      task("task-3", "page", "failed", {
        dependencyIds: ["task-2"],
        failureClass: "qa",
        error: { message: "Desktop frame overflowed its artboard" },
        finishedAt: 30,
      }),
    ],
    dependencies: [
      { planId: "plan-1", taskId: "task-2", dependencyTaskId: "task-1", ordinal: 0 },
      { planId: "plan-1", taskId: "task-3", dependencyTaskId: "task-2", ordinal: 0 },
    ],
    currentAttempts: [],
    ...overrides,
  };
}

function generationEvent(
  sequence: number,
  type: string,
  taskId: string | null,
  payload: Record<string, unknown> = {},
): GenerationPlanEvent {
  return {
    planId: "plan-1",
    sequence,
    taskId,
    type,
    payload,
    createdAt: 1_720_000_000_000 + sequence * 1_000,
  };
}

test("GenerationPlanPanel presents a compact production docket with explicit state and retry choices", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn(async () => {});
  const onCancel = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan(), { ...plan(), id: "plan-2", createdAt: 9 }]}
      detail={detail()}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={onRetry}
      onCancel={onCancel}
      onClose={onClose}
    />,
  );

  expect(screen.getByRole("heading", { name: "Build plan" })).toBeInTheDocument();
  const header = screen.getByRole("heading", { name: "Build plan" }).closest("header");
  expect(header).toHaveClass("h-10", "min-h-10", "border-b");
  expect(header?.firstElementChild).toHaveClass("items-center", "gap-2.5");
  expect(screen.getByText("1 of 3 complete")).toBeInTheDocument();
  expect(screen.getByText("Live updates")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/1 of 3 complete.*Live updates/);
  expect(screen.getByRole("progressbar", { name: "Generation progress" })).toHaveAttribute("aria-valuenow", "1");
  expect(screen.getByRole("progressbar", { name: "Generation progress" })).toHaveAttribute("aria-valuemax", "3");
  expect(screen.getByRole("list", { name: "Generation tasks" })).toHaveTextContent("Resource");
  expect(screen.getByRole("list", { name: "Generation tasks" })).toHaveTextContent("Component");
  expect(screen.getByText("Desktop frame overflowed its artboard")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  const planSelector = screen.getByRole("combobox", { name: "Selected generation plan" });
  expect(planSelector).toHaveAttribute("data-slot", "select-trigger");
  expect(planSelector).toHaveAttribute("data-size", "sm");
  const css = readFileSync(
    `${process.cwd()}/src/project-studio/generation/generation-plan.css`,
    "utf8",
  );
  expect(css).not.toMatch(
    /\.dezin-generation-plan__selector-trigger\s*\{[^}]*(?:height|font-size|border-color|background|box-shadow)\s*:/s,
  );
  expect(css).not.toMatch(
    /\.dezin-generation-plan__(?:header|heading|header-actions)(?:\s+[^{,]+)?\s*\{/,
  );
  expect(screen.getByRole("button", { name: "Close build plan" })).toHaveAttribute("data-slot", "button");
  expect(screen.getByRole("group", { name: "Page retry options" })).toBeInTheDocument();

  const sameContext = screen.getByRole("button", { name: "Retry Page with the same context" });
  expect(sameContext).toHaveAttribute("data-slot", "button");
  await user.click(sameContext);
  expect(onRetry).toHaveBeenCalledWith("task-3", "same-context");
  await user.click(screen.getByRole("button", { name: "Retry Page with refreshed context" }));
  expect(onRetry).toHaveBeenCalledWith("task-3", "latest-context");
  const cancel = screen.getByRole("button", { name: "Cancel generation plan" });
  expect(cancel).toHaveAttribute("data-slot", "button");
  await user.click(cancel);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("GenerationPlanPanel renders durable activity and always-visible task output without exposing internal ids", async () => {
  const user = userEvent.setup();
  const onFocusTask = vi.fn();
  const running = task("task-2", "component", "running", {
    currentAttempt: 2,
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "5b6e7f80-1234-4abc-8def-1234567890ab",
      trackId: "track-component",
    },
  });
  const events = [
    generationEvent(1, "plan-queued", null, { taskCount: 1, dependencyCount: 0 }),
    generationEvent(2, "task-materialized", running.id, { attempt: 2 }),
    generationEvent(3, "task-running", running.id, {
      attempt: 2,
      ownerId: "1d2e3f40-1234-4abc-8def-1234567890ab",
    }),
    generationEvent(4, "task-progress", running.id, {
      attempt: 2,
      phase: "verifying-sources",
    }),
  ];

  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail({
        tasks: [running],
        dependencies: [],
        events,
        currentAttempts: [{
          taskId: running.id,
          attempt: 2,
          status: "running",
          candidateRevisionId: null,
          candidateResourceRevisionId: null,
          candidateEvidence: null,
          candidateEvidenceHash: null,
        }],
      })}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
      onFocusTask={onFocusTask}
    />,
  );

  const process = screen.getByRole("list", { name: "Generation process" });
  expect(process).toHaveTextContent("Generation started");
  expect(process).toHaveTextContent("Verifying sources");
  expect(process).toHaveTextContent("Inputs prepared");
  expect(process).toHaveTextContent("1 task queued");
  expect(process.querySelectorAll("time")).toHaveLength(4);
  expect(screen.queryByText("1d2e3f40-1234-4abc-8def-1234567890ab")).not.toBeInTheDocument();
  expect(screen.queryByText("5b6e7f80-1234-4abc-8def-1234567890ab")).not.toBeInTheDocument();

  expect(screen.getByText("Component 3", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("Attempt 2 · 0 dependencies")).toBeInTheDocument();
  expect(screen.getByText("Output · Verifying sources in progress")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /details for Component 3/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Show on canvas" }));
  expect(onFocusTask).toHaveBeenCalledWith(running);
});

test("GenerationPlanPanel traces concurrent process events to semantic targets and canvas focus", async () => {
  const user = userEvent.setup();
  const onFocusTask = vi.fn();
  const page = task("task-1", "page", "running", {
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "11111111-1111-4111-8111-111111111111",
      trackId: "track-page",
    },
  });
  const component = task("task-2", "component", "candidate-ready", {
    currentAttempt: 2,
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "22222222-2222-4222-8222-222222222222",
      trackId: "track-component",
    },
  });
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail({
        tasks: [page, component],
        dependencies: [],
        events: [
          generationEvent(1, "task-running", page.id, { attempt: 1 }),
          generationEvent(2, "task-candidate-ready", component.id, {
            attempt: 2,
            candidateRevisionId: "revision-internal-id",
          }),
        ],
      })}
      connection="live"
      busyAction={null}
      targetLabels={{
        artifacts: new Map([
          [page.target.id, "Checkout"],
          [component.target.id, "Cart"],
        ]),
        resources: new Map(),
      }}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
      onFocusTask={onFocusTask}
    />,
  );

  const process = screen.getByRole("list", { name: "Generation process" });
  expect(process).toHaveTextContent("Page · Checkout · Attempt 1");
  expect(process).toHaveTextContent("Component · Cart · Attempt 2 · Artifact candidate ready");
  expect(process).not.toHaveTextContent("11111111-1111-4111-8111-111111111111");
  expect(process).not.toHaveTextContent("revision-internal-id");
  await user.click(screen.getByRole("button", { name: "Show Cart on canvas" }));
  expect(onFocusTask).toHaveBeenCalledWith(component);
});

test("GenerationPlanPanel keeps long target identities discoverable in a 23-task plan", () => {
  const tasks = Array.from({ length: 23 }, (_, index) => task(
    `task-${index + 10}`,
    "page",
    "materialization-pending",
    {
      ordinal: index,
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: `artifact-${index}`,
        trackId: `track-${index}`,
      },
    },
  ));
  const longTarget = "Electric Cobalt Grid Checkout";
  const targetLabels = {
    artifacts: new Map(tasks.map((item, index) => [
      item.target.id,
      index === 0 ? longTarget : `KITE Page ${index + 1}`,
    ])),
    resources: new Map<string, string>(),
  };

  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail({ tasks, dependencies: [] })}
      connection="live"
      busyAction={null}
      targetLabels={targetLabels}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getAllByRole("listitem")).toHaveLength(23);
  expect(screen.getByText(longTarget)).toHaveAttribute("title", longTarget);
});

test("GenerationPlanPanel gives the target its own row beneath task kind and status", () => {
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail({ tasks: [task("task-10", "page", "materialization-pending")], dependencies: [] })}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  const target = screen.getByText("Page", { selector: "strong" });
  expect(target.parentElement).toHaveClass("dezin-generation-plan__task-topline");
  expect(target.parentElement).toContainElement(screen.getByText("Page", {
    selector: ".dezin-generation-plan__task-kind",
  }));
  expect(target.parentElement).toContainElement(screen.getByText("Preparing"));
});

test("GenerationPlanPanel keeps task titles and metadata at inspector reading size", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    `${process.cwd()}/src/project-studio/generation/generation-plan.css`,
    "utf8",
  );
  document.head.append(style);
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail({ tasks: [task("task-10", "page", "materialization-pending")], dependencies: [] })}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  try {
    expect(getComputedStyle(screen.getByText("Page", { selector: "strong" })).fontSize).toBe("14px");
    expect(getComputedStyle(screen.getByText("Not started · 0 dependencies")).fontSize).toBe("12px");
  } finally {
    style.remove();
  }
});

test("GenerationPlanPanel keeps narrow task rows and the footer dimensionally stable", () => {
  const css = readFileSync(
    `${process.cwd()}/src/project-studio/generation/generation-plan.css`,
    "utf8",
  );

  expect(css).toMatch(
    /\.dezin-generation-plan__task-topline\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s,
  );
  expect(css).toMatch(
    /\.dezin-generation-plan__task-topline strong\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*-webkit-line-clamp:\s*2;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  expect(css).toMatch(
    /\.dezin-generation-plan__task-status\s*\{[^}]*white-space:\s*nowrap;/s,
  );
  expect(css).toMatch(
    /\.dezin-generation-plan__footer\s*\{[^}]*min-height:\s*44px;[^}]*flex:\s*0\s+0\s+44px;[^}]*justify-content:\s*flex-end;[^}]*background:\s*var\(--background\);/s,
  );
  expect(css).not.toContain(".dezin-generation-plan__identity");
});

test("GenerationPlanPanel presents scheduled retries and direction selection as compact active states", () => {
  const scheduledRetry = task("task-10", "component", "retry-wait");
  const directionSelection = task("task-11", "resource", "blocked-context", {
    blockedReason: "Choose one visual direction before generation continues.",
    error: {
      message: "Choose one visual direction before generation continues.",
      refs: ["research:resource-brand@revision-1:direction-selection"],
    },
  });

  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail({ tasks: [scheduledRetry, directionSelection], dependencies: [] })}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByText("Retry scheduled").closest("[data-tone]")).toHaveAttribute("data-tone", "active");
  expect(screen.getByText("Choose direction").closest("[data-tone]")).toHaveAttribute("data-tone", "active");
  expect(screen.queryByText("Awaiting direction selection")).not.toBeInTheDocument();
});

test("GenerationPlanPanel footer exposes the plan action without a raw plan identifier", () => {
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail()}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "Cancel generation plan" })).toBeInTheDocument();
  expect(screen.queryByText("plan-1")).not.toBeInTheDocument();
});

test("GenerationPlanPanel never exposes absolute local paths from legacy Task failures", () => {
  const failed = task("task-1", "component", "failed", {
    error: {
      message: "/Users/private-user/.local/lib/node_modules/provider/bin/codebuddy returned an error result",
    },
  });
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan("failed")]}
      detail={{
        plan: plan("failed"),
        tasks: [failed],
        dependencies: [],
        currentAttempts: [],
      }}
      connection="settled"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByText("codebuddy returned an error result")).toBeInTheDocument();
  expect(screen.queryByText(/private-user|\/Users\//)).not.toBeInTheDocument();
});

test("GenerationPlanPanel keeps dependency failures on the owning Task instead of repeating them on every blocked row", () => {
  const failure = "Moodboard Asset drifted into an airline operations dashboard instead of the approved film-festival direction.";
  const moodboard = task("task-1", "resource", "failed", {
    target: { type: "resource", workspaceId: "workspace-1", id: "resource-moodboard" },
    failureClass: "qa",
    error: { message: failure },
  });
  const blocked = [
    task("task-2", "component", "blocked", {
      blockedByTaskId: moodboard.id,
      blockedReason: failure,
    }),
    task("task-3", "page", "blocked", {
      blockedByTaskId: moodboard.id,
      blockedReason: failure,
    }),
  ];

  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan("failed")]}
      detail={{
        plan: plan("failed"),
        tasks: [moodboard, ...blocked],
        dependencies: [],
        currentAttempts: [],
      }}
      connection="settled"
      busyAction={null}
      targetLabels={{
        artifacts: new Map(),
        resources: new Map([["resource-moodboard", "KITE Visual Directions Moodboard"]]),
      }}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getAllByText(failure)).toHaveLength(1);
  const blockedMessages = screen.getAllByText("Blocked by KITE Visual Directions Moodboard");
  expect(blockedMessages).toHaveLength(2);
  for (const blockedStatus of screen.getAllByText("Blocked")) {
    expect(blockedStatus.closest("[data-tone]")).toHaveAttribute("data-tone", "neutral");
  }
  expect(screen.getByText("Failed").closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
});

test("GenerationPlanPanel resolves owned Resource and Artifact names while preserving Workspace and stable fallbacks", () => {
  const tasks = [
    task("task-1", "resource", "failed", {
      target: { type: "resource", workspaceId: "workspace-1", id: "resource-research" },
    }),
    task("task-2", "component", "failed", {
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-location-card",
        trackId: "track-location-card",
      },
    }),
    task("task-3", "page", "failed", {
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-destination",
        trackId: "track-destination",
      },
    }),
    task("task-4", "prototype-validation", "blocked", {
      target: { type: "workspace", workspaceId: "workspace-1", id: "workspace-1" },
    }),
    task("task-5", "page", "blocked", {
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-fallback-title",
        trackId: "track-fallback-title",
      },
    }),
  ];
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan("failed")]}
      detail={{
        plan: plan("failed"),
        tasks,
        dependencies: [],
        currentAttempts: [],
      }}
      connection="settled"
      busyAction={null}
      targetLabels={{
        artifacts: new Map([
          ["artifact-location-card", "Location Metadata"],
          ["artifact-destination", "Atlas Journal"],
        ]),
        resources: new Map([
          ["resource-research", "Kyoto Cultural Guide"],
        ]),
      }}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByText("Kyoto Cultural Guide")).toBeInTheDocument();
  expect(screen.getByText("Location Metadata")).toBeInTheDocument();
  expect(screen.getByText("Atlas Journal")).toBeInTheDocument();
  expect(screen.getByText("Workspace")).toBeInTheDocument();
  expect(screen.getByText("Fallback Title")).toBeInTheDocument();
});

test("Research context gate opens the exact immutable Revision and never offers retry on the blocked Task", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn();
  const blocked = detail({
    tasks: [task("task-1", "page", "blocked-context", {
      failureClass: "context",
      blockedReason: "Choose one immutable Research direction before Artifact generation.",
      error: {
        message: "Research direction selection is required.",
        refs: ["research:resource-checkout@revision-research-1:direction-selection"],
      },
    })],
    dependencies: [],
  });
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[blocked.plan]}
      detail={blocked}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={onRetry}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByText("Choose direction")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Retry Page/ })).not.toBeInTheDocument();
  const link = screen.getByRole("link", {
    name: "Review Research directions from Revision revision-research-1",
  });
  expect(link).toHaveAttribute(
    "href",
    "/projects/project-1/resources/resource-checkout/revisions/revision-research-1",
  );
  await user.click(link);
  expect(window.location.pathname).toBe(
    "/projects/project-1/resources/resource-checkout/revisions/revision-research-1",
  );
  expect(onRetry).not.toHaveBeenCalled();
  window.history.replaceState({}, "", "/");
});

test("GenerationPlanPanel explains compile failures even when no Task DAG exists", () => {
  const failedPlan = {
    ...plan("compile-failed"),
    compileError: {
      code: "generation_dependency_cycle",
      message: "The approved component dependencies contain a cycle.",
    },
    finishedAt: 20,
  };
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[failedPlan]}
      detail={{ plan: failedPlan, tasks: [], dependencies: [], currentAttempts: [] }}
      connection="settled"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent(
    "The approved component dependencies contain a cycle.",
  );
  expect(screen.getByText("0 of 0 complete")).toBeInTheDocument();
});

test("GenerationPlanPanel offers only refreshed context when no immutable Attempt exists", () => {
  const blocked = task("task-1", "resource", "blocked-context", {
    currentAttempt: 0,
    blockedReason: "Required source is unavailable",
  });
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan("failed")]}
      detail={{ plan: plan("failed"), tasks: [blocked], dependencies: [], currentAttempts: [] }}
      connection="settled"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.queryByRole("button", { name: /same context/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /refreshed context/i })).toBeEnabled();
});

test("GenerationPlanPanel reopens unfinished work on a cancelled Plan without wiping succeeded Tasks", () => {
  const cancelled = { ...plan("cancelled"), finishedAt: 40 };
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[cancelled]}
      detail={{
        plan: cancelled,
        tasks: [
          task("task-ok", "component", "succeeded"),
          task("task-1", "page", "failed", { error: { message: "Failed before cancellation" } }),
        ],
        dependencies: [],
        currentAttempts: [],
      }}
      connection="settled"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onRetryFailed={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByText("Failed before cancellation")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Retry all unfinished root tasks/i })).toBeEnabled();
  expect(screen.getByRole("button", { name: /refreshed context/i })).toBeEnabled();
});

test("GenerationPlanPanel links only exact candidate and published Revisions without a mutable Head fallback", () => {
  const candidateTask = task("task-1", "page", "candidate-ready", {
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact / candidate",
      trackId: "track-candidate",
    },
  });
  const rebaseTask = task("task-2", "component", "needs-rebase", {
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-rebase",
      trackId: "track-rebase",
    },
  });
  const succeededTask = task("task-3", "page", "succeeded", {
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-published",
      trackId: "track-published",
    },
    resultRevisionId: "revision / published",
  });
  const runningTask = task("task-4", "page", "running", {
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-running",
      trackId: "track-running",
    },
  });
  render(
    <GenerationPlanPanel
      projectId="project / one"
      plans={[plan()]}
      detail={{
        plan: plan(),
        tasks: [candidateTask, rebaseTask, succeededTask, runningTask],
        dependencies: [],
        currentAttempts: [
          {
            taskId: candidateTask.id,
            attempt: candidateTask.currentAttempt,
            status: "candidate-ready",
            candidateRevisionId: "revision / candidate",
            candidateResourceRevisionId: null,
            candidateEvidence: { protocol: "dezin.artifact-run.v1" },
            candidateEvidenceHash: "a".repeat(64),
          },
          {
            taskId: rebaseTask.id,
            attempt: rebaseTask.currentAttempt,
            status: "needs-rebase",
            candidateRevisionId: "revision-rebase",
            candidateResourceRevisionId: null,
            candidateEvidence: { protocol: "dezin.artifact-run.v1" },
            candidateEvidenceHash: "b".repeat(64),
          },
          {
            taskId: runningTask.id,
            attempt: runningTask.currentAttempt,
            status: "running",
            candidateRevisionId: null,
            candidateResourceRevisionId: null,
            candidateEvidence: null,
            candidateEvidenceHash: null,
          },
        ],
      }}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByRole("link", { name: "Review Page candidate" })).toHaveAttribute(
    "href",
    "/projects/project%20%2F%20one/artifacts/artifact%20%2F%20candidate/candidates/plan-1/task-1/1",
  );
  expect(screen.getByRole("link", { name: "Review Component candidate" })).toHaveAttribute(
    "href",
    "/projects/project%20%2F%20one/artifacts/artifact-rebase/candidates/plan-1/task-2/1",
  );
  expect(screen.getByRole("link", { name: "Open published Page revision" })).toHaveAttribute(
    "href",
    "/projects/project%20%2F%20one/artifacts/artifact-published/revisions/revision%20%2F%20published",
  );
  expect(screen.queryByRole("link", { name: /artifact-running/i })).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/projects/project%20%2F%20one/artifacts/artifact-running"]'))
    .not.toBeInTheDocument();
});

test("GenerationPlanPanel fails closed when candidate identity is stale, missing, or belongs to another Attempt", () => {
  const candidateTask = task("task-1", "page", "candidate-ready", {
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-candidate",
      trackId: "track-candidate",
    },
    currentAttempt: 2,
  });
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={{
        plan: plan(),
        tasks: [candidateTask],
        dependencies: [],
        currentAttempts: [{
          taskId: candidateTask.id,
          attempt: 1,
          status: "candidate-ready",
          candidateRevisionId: "stale-candidate",
          candidateResourceRevisionId: null,
          candidateEvidence: { protocol: "dezin.artifact-run.v1" },
          candidateEvidenceHash: "c".repeat(64),
        }],
      }}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("GenerationPlanInspector keeps one header and close action across loading, ready, and history switching", async () => {
  const user = userEvent.setup();
  const oldPlan = plan("failed");
  const newerPlan = { ...plan("failed"), id: "plan-2", createdAt: 20, finishedAt: 30 };
  const oldDetail = detail({
    plan: oldPlan,
    tasks: [task("task-1", "component", "failed", { error: { message: "Old Plan finding" } })],
    dependencies: [],
  });
  const newerDetail = detail({
    plan: newerPlan,
    tasks: [{
      ...task("task-2", "page", "failed", { error: { message: "New Plan finding" } }),
      planId: newerPlan.id,
    }],
    dependencies: [],
  });
  const initialRead = deferred<GenerationPlanDetail>();
  const historyRead = deferred<GenerationPlanDetail>();
  const onClose = vi.fn();
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [newerPlan, oldPlan],
      getGenerationPlan: async (_projectId, planId) => (
        planId === oldPlan.id ? initialRead.promise : historyRead.promise
      ),
    })}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId={oldPlan.id}
        onClose={onClose}
      />
    </ApiProvider>,
  );

  const header = rendered.container.querySelector("header.dezin-generation-plan__header");
  const close = screen.getByRole("button", { name: "Close build plan" });
  expect(header).not.toBeNull();
  expect(header).toHaveClass("h-10", "min-h-10");

  await act(async () => {
    initialRead.resolve(oldDetail);
    await initialRead.promise;
  });
  await screen.findByText("Old Plan finding");
  expect(rendered.container.querySelector("header.dezin-generation-plan__header")).toBe(header);
  expect(screen.getByRole("button", { name: "Close build plan" })).toBe(close);

  await chooseGenerationPlan(user, newerPlan.id);
  expect(screen.getByRole("status")).toHaveTextContent("Loading build plan");
  expect(screen.queryByText("Old Plan finding")).not.toBeInTheDocument();
  expect(rendered.container.querySelector("header.dezin-generation-plan__header")).toBe(header);
  expect(screen.getByRole("button", { name: "Close build plan" })).toBe(close);

  await act(async () => {
    historyRead.resolve(newerDetail);
    await historyRead.promise;
  });
  await screen.findByText("New Plan finding");
  expect(rendered.container.querySelector("header.dezin-generation-plan__header")).toBe(header);
  expect(screen.getByRole("button", { name: "Close build plan" })).toBe(close);
  expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue(newerPlan.id);

  await user.click(close);
  expect(onClose).toHaveBeenCalledTimes(1);
  rendered.unmount();
});

test("GenerationPlanInspector keeps its header and close action when loading resolves empty", async () => {
  const user = userEvent.setup();
  const plans = deferred<GenerationPlan[]>();
  const onClose = vi.fn();
  const rendered = render(
    <ApiProvider client={makeFakeApi({ listGenerationPlans: async () => plans.promise })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={null} onClose={onClose} />
    </ApiProvider>,
  );

  const header = rendered.container.querySelector("header.dezin-generation-plan__header");
  const close = screen.getByRole("button", { name: "Close build plan" });
  expect(header).not.toBeNull();

  await act(async () => {
    plans.resolve([]);
    await plans.promise;
  });
  expect(await screen.findByRole("heading", { name: "No build plan yet" })).toBeInTheDocument();
  expect(rendered.container.querySelector("header.dezin-generation-plan__header")).toBe(header);
  expect(screen.getByRole("button", { name: "Close build plan" })).toBe(close);

  await user.click(close);
  expect(onClose).toHaveBeenCalledTimes(1);
  rendered.unmount();
});

test("GenerationPlanInspector keeps its header and close action when loading fails", async () => {
  const user = userEvent.setup();
  const plans = deferred<GenerationPlan[]>();
  const onClose = vi.fn();
  const rendered = render(
    <ApiProvider client={makeFakeApi({ listGenerationPlans: async () => plans.promise })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={null} onClose={onClose} />
    </ApiProvider>,
  );

  const header = rendered.container.querySelector("header.dezin-generation-plan__header");
  const close = screen.getByRole("button", { name: "Close build plan" });
  expect(header).not.toBeNull();

  await act(async () => {
    plans.reject(new Error("Plan index unavailable"));
    await plans.promise.catch(() => {});
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Plan index unavailable");
  expect(rendered.container.querySelector("header.dezin-generation-plan__header")).toBe(header);
  expect(screen.getByRole("button", { name: "Close build plan" })).toBe(close);

  await user.click(close);
  expect(onClose).toHaveBeenCalledTimes(1);
  rendered.unmount();
});

test("GenerationPlanInspector rejects a mismatched initial detail without exposing the wrong Plan", async () => {
  const selected = plan("failed");
  const mismatchedPlan = { ...plan("failed"), id: "plan-2", createdAt: 20 };
  const mismatchedDetail = detail({
    plan: mismatchedPlan,
    tasks: [{
      ...task("task-2", "page", "failed", { error: { message: "Wrong Plan finding" } }),
      planId: mismatchedPlan.id,
    }],
    dependencies: [],
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [selected],
      getGenerationPlan: async () => mismatchedDetail,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={selected.id} onClose={() => {}} />
    </ApiProvider>,
  );

  const header = rendered.container.querySelector("header.dezin-generation-plan__header");
  expect(await screen.findByRole("alert")).toHaveTextContent("identity mismatch");
  expect(screen.queryByText("Wrong Plan finding")).not.toBeInTheDocument();
  expect(rendered.container.querySelector("header.dezin-generation-plan__header")).toBe(header);
  rendered.unmount();
});

test("GenerationPlanInspector reconnects from the durable cursor and refreshes authoritative detail", async () => {
  const initial = detail({
    plan: plan("queued"),
    tasks: [task("task-1", "component", "queued")],
    dependencies: [],
  });
  const running = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(running);
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    yield {
      planId: "plan-1",
      sequence: 4,
      taskId: "task-1",
      type: "task-running",
      payload: {},
      createdAt: 20,
    };
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const onDetailChange = vi.fn();
  const api = makeFakeApi({
    listGenerationPlans: async () => [plan("queued")],
    getGenerationPlan,
    streamGenerationPlanEvents,
  });

  const { unmount } = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        onDetailChange={onDetailChange}
      />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getAllByText("Running")).toHaveLength(2));
  expect(streamGenerationPlanEvents).toHaveBeenCalledWith(
    "project-1",
    "plan-1",
    expect.any(AbortSignal),
    { after: 0 },
  );
  expect(getGenerationPlan).toHaveBeenCalledTimes(2);
  expect(onDetailChange).toHaveBeenNthCalledWith(1, {
    detail: initial,
    source: "load",
  });
  expect(onDetailChange).toHaveBeenLastCalledWith({
    detail: running,
    source: "observation",
  });
  unmount();
});

test("GenerationPlanInspector follows an authoritative retry while a previously-live stream is stalled", async () => {
  const attemptTwo = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "materialization-pending", { currentAttempt: 2 })],
    dependencies: [],
  });
  const attemptFour = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running", { currentAttempt: 4 })],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn(async () => attemptTwo);
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    yield generationEvent(66, "task-materialized", "task-1", { attempt: 2 });
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const api = makeFakeApi({
    listGenerationPlans: async () => [attemptTwo.plan],
    getGenerationPlan,
    streamGenerationPlanEvents,
  });
  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        authoritativeDetail={attemptTwo}
      />
    </ApiProvider>,
  );

  await waitFor(() => expect(getGenerationPlan).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/Attempt 2/)).toBeInTheDocument();
  expect(screen.getByText("Live updates")).toBeInTheDocument();

  rendered.rerender(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        authoritativeDetail={attemptFour}
      />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByText(/Attempt 4/)).toBeInTheDocument());
  expect(screen.queryByText(/Attempt 2/)).not.toBeInTheDocument();
  expect(screen.getAllByText("Running")).toHaveLength(2);

  rendered.rerender(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        authoritativeDetail={attemptTwo}
      />
    </ApiProvider>,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText(/Attempt 4/)).toBeInTheDocument();
  expect(screen.queryByText(/Attempt 2/)).not.toBeInTheDocument();
  rendered.unmount();
});

test("GenerationPlanInspector resumes an ordinary stream disconnect from its durable cursor", async () => {
  const attemptTwo = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "materialization-pending", { currentAttempt: 2 })],
    dependencies: [],
  });
  const attemptThree = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running", { currentAttempt: 3 })],
    dependencies: [],
  });
  const attemptFour = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running", { currentAttempt: 4 })],
    dependencies: [],
  });
  const disconnect = deferred<void>();
  const cursors: number[] = [];
  let streamCalls = 0;
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
    options?: { after?: number },
  ): AsyncGenerator<GenerationPlanEvent> {
    streamCalls += 1;
    cursors.push(options?.after ?? 0);
    if (streamCalls === 1) {
      yield generationEvent(66, "task-running", "task-1", { attempt: 3 });
      await disconnect.promise;
      throw new Error("daemon restarted");
    }
    yield generationEvent(69, "task-running", "task-1", { attempt: 4 });
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(attemptTwo)
    .mockResolvedValueOnce(attemptThree)
    .mockResolvedValue(attemptFour);
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [attemptTwo.plan],
      getGenerationPlan,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByText(/Attempt 3/)).toBeInTheDocument());
  disconnect.resolve();
  await waitFor(() => expect(screen.getByText(/Attempt 4/)).toBeInTheDocument());
  expect(cursors.slice(0, 2)).toEqual([0, 66]);
  expect(streamGenerationPlanEvents).toHaveBeenCalledTimes(2);
  rendered.unmount();
});

test("GenerationPlanInspector requests one authoritative workspace reconciliation per published output identity", async () => {
  const initial = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const published = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "succeeded", {
      resultRevisionId: "revision-2",
      resultSnapshotId: "snapshot-2",
    })],
    dependencies: [],
  });
  const onWorkspaceChanged = vi.fn();
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(published);
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    yield {
      planId: "plan-1",
      sequence: 4,
      taskId: "task-1",
      type: "task-succeeded",
      payload: {},
      createdAt: 30,
    };
    yield {
      planId: "plan-1",
      sequence: 5,
      taskId: null,
      type: "plan-running",
      payload: {},
      createdAt: 31,
    };
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [initial.plan],
      getGenerationPlan,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        onWorkspaceChanged={onWorkspaceChanged}
      />
    </ApiProvider>,
  );

  await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledTimes(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(onWorkspaceChanged).toHaveBeenCalledTimes(1);
  rendered.unmount();
});

test("GenerationPlanInspector coalesces a replay burst into one authoritative detail refresh", async () => {
  const initial = detail({
    plan: plan("queued"),
    tasks: [task("task-1", "component", "queued")],
    dependencies: [],
  });
  const running = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(running);
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    for (let sequence = 1; sequence <= 64; sequence += 1) {
      yield {
        planId: "plan-1",
        sequence,
        taskId: "task-1",
        type: "task-running",
        payload: {},
        createdAt: 20 + sequence,
      };
    }
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [plan("queued")],
      getGenerationPlan,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getAllByText("Running")).toHaveLength(2));
  await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(getGenerationPlan).toHaveBeenCalledTimes(2);
  rendered.unmount();
});

test("GenerationPlanInspector replays a terminal event when its first authoritative refresh fails", async () => {
  const initial = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const settled = detail({
    plan: { ...plan("succeeded"), finishedAt: 40 },
    tasks: [task("task-1", "component", "succeeded")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("transient detail read failure"))
    .mockResolvedValue(settled);
  const cursors: number[] = [];
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    _signal?: AbortSignal,
    options?: { after?: number },
  ): AsyncGenerator<GenerationPlanEvent> {
    const after = options?.after ?? 0;
    cursors.push(after);
    if (after < 8) {
      yield {
        planId: "plan-1",
        sequence: 8,
        taskId: "task-1",
        type: "task-succeeded",
        payload: {},
        createdAt: 40,
      };
    }
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [plan("running")],
      getGenerationPlan,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getAllByText("Complete")).toHaveLength(2), { timeout: 1_000 });
  expect(cursors.slice(0, 2)).toEqual([0, 0]);
  expect(getGenerationPlan).toHaveBeenCalledTimes(3);
  rendered.unmount();
});

test("GenerationPlanInspector ignores an older Plan refresh that completes after a new selection", async () => {
  const user = userEvent.setup();
  const oldPlan = plan("running");
  const newerPlan = {
    ...plan("running"),
    id: "plan-2",
    createdAt: 20,
  };
  const oldInitial = detail({
    plan: oldPlan,
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const staleRefresh = detail({
    plan: { ...oldPlan, status: "failed" },
    tasks: [task("task-1", "component", "failed", { error: { message: "Stale failure" } })],
    dependencies: [],
  });
  const newDetail = detail({
    plan: newerPlan,
    tasks: [{
      ...task("task-2", "page", "running"),
      planId: newerPlan.id,
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-new-page",
        trackId: "track-new-page",
      },
    }],
    dependencies: [],
  });
  const oldRefresh = deferred<GenerationPlanDetail>();
  const refreshStarted = deferred<void>();
  const getGenerationPlan = vi.fn(async (_projectId: string, planId: string) => {
    if (getGenerationPlan.mock.calls.length === 1) return oldInitial;
    if (planId === oldPlan.id) {
      refreshStarted.resolve();
      return oldRefresh.promise;
    }
    return newDetail;
  });
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    if (planId === oldPlan.id) {
      yield {
        planId,
        sequence: 1,
        taskId: "task-1",
        type: "task-running",
        payload: {},
        createdAt: 21,
      };
    }
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const api = makeFakeApi({
    listGenerationPlans: async () => [newerPlan, oldPlan],
    getGenerationPlan,
    streamGenerationPlanEvents,
  });

  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={oldPlan.id} />
    </ApiProvider>,
  );

  await refreshStarted.promise;
  await chooseGenerationPlan(user, newerPlan.id);
  await waitFor(() => expect(screen.getByText("New Page")).toBeInTheDocument());

  await act(async () => {
    oldRefresh.resolve(staleRefresh);
    await oldRefresh.promise;
  });

  expect(screen.getByText("New Page")).toBeInTheDocument();
  expect(screen.queryByText("Stale failure")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue(newerPlan.id);
  rendered.unmount();
});

test("GenerationPlanInspector does not apply a retry response after the operator selects another Plan", async () => {
  const user = userEvent.setup();
  const oldPlan = plan("failed");
  const newerPlan = { ...plan("failed"), id: "plan-2", createdAt: 20, finishedAt: 30 };
  const oldDetail = detail({
    plan: oldPlan,
    tasks: [task("task-1", "page", "failed", { error: { message: "Needs another pass" } })],
    dependencies: [],
  });
  const newerDetail = detail({
    plan: newerPlan,
    tasks: [{
      ...task("task-2", "component", "failed", { error: { message: "New Plan finding" } }),
      planId: newerPlan.id,
    }],
    dependencies: [],
  });
  const retryResponse = deferred<GenerationPlanDetail>();
  const retryGenerationTask = vi.fn(() => retryResponse.promise);
  const api = makeFakeApi({
    listGenerationPlans: async () => [newerPlan, oldPlan],
    getGenerationPlan: async (_projectId, planId) => planId === oldPlan.id ? oldDetail : newerDetail,
    retryGenerationTask,
  });

  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={oldPlan.id} />
    </ApiProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Retry Page with the same context" }));
  await chooseGenerationPlan(user, newerPlan.id);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue(newerPlan.id));
  expect(screen.getByRole("button", { name: "Retry Component with the same context" })).toBeEnabled();

  await act(async () => {
    retryResponse.resolve({
      ...oldDetail,
      plan: { ...oldPlan, status: "queued" },
      tasks: [task("task-1", "page", "queued")],
    });
    await retryResponse.promise;
  });

  expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue(newerPlan.id);
  expect(screen.queryByText("Needs another pass")).not.toBeInTheDocument();
  expect(retryGenerationTask).toHaveBeenCalledWith("project-1", oldPlan.id, "task-1", "same-context");
  rendered.unmount();
});

test("GenerationPlanInspector never lets an older stream refresh overwrite a completed retry", async () => {
  const user = userEvent.setup();
  const failed = detail({
    plan: plan("failed"),
    tasks: [task("task-1", "page", "failed", { error: { message: "Initial failure" } })],
    dependencies: [],
  });
  const staleRefresh = detail({
    plan: plan("failed"),
    tasks: [task("task-1", "page", "failed", { error: { message: "Stale GET failure" } })],
    dependencies: [],
  });
  const queued = detail({
    plan: plan("queued"),
    tasks: [task("task-1", "page", "queued")],
    dependencies: [],
  });
  const staleResponse = deferred<GenerationPlanDetail>();
  const refreshStarted = deferred<void>();
  const getGenerationPlan = vi.fn(async () => {
    if (getGenerationPlan.mock.calls.length === 1) return failed;
    refreshStarted.resolve();
    return staleResponse.promise;
  });
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    yield {
      planId: "plan-1",
      sequence: 7,
      taskId: "task-1",
      type: "task-failed",
      payload: {},
      createdAt: 30,
    };
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [failed.plan],
      getGenerationPlan,
      retryGenerationTask: async () => queued,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
    </ApiProvider>,
  );

  await refreshStarted.promise;
  await user.click(screen.getByRole("button", { name: "Retry Page with the same context" }));
  await waitFor(() => expect(screen.getAllByText("Queued")).toHaveLength(2));

  await act(async () => {
    staleResponse.resolve(staleRefresh);
    await staleResponse.promise;
  });

  expect(screen.getAllByText("Queued")).toHaveLength(2);
  expect(screen.queryByText("Stale GET failure")).not.toBeInTheDocument();
  rendered.unmount();
});

test("GenerationPlanInspector never lets an older stream refresh undo a completed cancellation", async () => {
  const user = userEvent.setup();
  const running = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const cancelled = detail({
    plan: { ...plan("cancelled"), finishedAt: 40 },
    tasks: [task("task-1", "component", "cancelled", { finishedAt: 40 })],
    dependencies: [],
  });
  const staleResponse = deferred<GenerationPlanDetail>();
  const refreshStarted = deferred<void>();
  const getGenerationPlan = vi.fn(async () => {
    if (getGenerationPlan.mock.calls.length === 1) return running;
    refreshStarted.resolve();
    return staleResponse.promise;
  });
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    yield {
      planId: "plan-1",
      sequence: 3,
      taskId: "task-1",
      type: "task-running",
      payload: {},
      createdAt: 25,
    };
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const onDetailChange = vi.fn();
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [running.plan],
      getGenerationPlan,
      cancelGenerationPlan: async () => cancelled,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        onDetailChange={onDetailChange}
      />
    </ApiProvider>,
  );

  await refreshStarted.promise;
  await user.click(screen.getByRole("button", { name: "Cancel generation plan" }));
  await waitFor(() => expect(screen.getAllByText("Cancelled")).toHaveLength(2));

  await act(async () => {
    staleResponse.resolve(running);
    await staleResponse.promise;
  });

  expect(screen.getAllByText("Cancelled")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Cancel generation plan" })).not.toBeInTheDocument();
  expect(onDetailChange).toHaveBeenCalledWith({
    detail: cancelled,
    source: "cancel",
  });
  rendered.unmount();
});

test("GenerationPlanInspector hides stale controls while loading and safely restores the previous Plan on failure", async () => {
  const user = userEvent.setup();
  const oldPlan = plan("running");
  const newerPlan = { ...plan("running"), id: "plan-2", createdAt: 20 };
  const oldDetail = detail({
    plan: oldPlan,
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const failedSelection = deferred<GenerationPlanDetail>();
  const cancelGenerationPlan = vi.fn(async () => ({
    ...oldDetail,
    plan: { ...oldPlan, status: "cancelled" as const, finishedAt: 40 },
  }));
  const api = makeFakeApi({
    listGenerationPlans: async () => [newerPlan, oldPlan],
    getGenerationPlan: async (_projectId, planId) => {
      if (planId === newerPlan.id) return failedSelection.promise;
      return oldDetail;
    },
    cancelGenerationPlan,
  });

  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={oldPlan.id} />
    </ApiProvider>,
  );

  await screen.findByRole("combobox", { name: "Selected generation plan" });
  await chooseGenerationPlan(user, newerPlan.id);

  expect(screen.queryByRole("button", { name: "Cancel generation plan" })).not.toBeInTheDocument();
  expect(screen.queryByText("Component")).not.toBeInTheDocument();
  failedSelection.reject(new Error("Plan 2 is unavailable"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Plan 2 is unavailable"));

  expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue(oldPlan.id);
  expect(screen.getAllByText("Component")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Cancel generation plan" }));
  expect(cancelGenerationPlan).toHaveBeenCalledWith("project-1", oldPlan.id);
  rendered.unmount();
});

test("GenerationPlanInspector keeps a failed Plan subscribed so another viewer's retry is observed", async () => {
  const failed = detail({
    plan: plan("failed"),
    tasks: [task("task-1", "page", "failed", { error: { message: "Visual QA failed" } })],
    dependencies: [],
  });
  const queued = detail({
    plan: plan("queued"),
    tasks: [task("task-1", "page", "queued")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(failed)
    .mockResolvedValue(queued);
  const streamGenerationPlanEvents = vi.fn(async function* (): AsyncGenerator<GenerationPlanEvent> {
    yield {
      planId: "plan-1",
      sequence: 9,
      taskId: "task-1",
      type: "task-retry-requested",
      payload: { mode: "same-context" },
      createdAt: 50,
    };
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [failed.plan],
      getGenerationPlan,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getAllByText("Queued")).toHaveLength(2));
  expect(streamGenerationPlanEvents).toHaveBeenCalledWith(
    "project-1",
    "plan-1",
    expect.any(AbortSignal),
    { after: 0 },
  );
  expect(getGenerationPlan).toHaveBeenCalledTimes(2);
  rendered.unmount();
});

test("GenerationPlanInspector opens the durable stream when a settled task is retried", async () => {
  const user = userEvent.setup();
  const failed = detail({
    plan: plan("failed"),
    tasks: [task("task-1", "page", "failed", { error: { message: "Visual QA failed" } })],
    dependencies: [],
  });
  const queued = detail({
    plan: plan("queued"),
    tasks: [task("task-1", "page", "queued")],
    dependencies: [],
  });
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const retryGenerationTask = vi.fn(async () => queued);
  const onDetailChange = vi.fn();
  const api = makeFakeApi({
    listGenerationPlans: async () => [failed.plan],
    getGenerationPlan: async () => failed,
    retryGenerationTask,
    streamGenerationPlanEvents,
  });

  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId="plan-1"
        onDetailChange={onDetailChange}
      />
    </ApiProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Retry Page with the same context" }));
  await waitFor(() => expect(streamGenerationPlanEvents).toHaveBeenCalledWith(
    "project-1",
    "plan-1",
    expect.any(AbortSignal),
    { after: 0 },
  ));
  expect(retryGenerationTask).toHaveBeenCalledWith("project-1", "plan-1", "task-1", "same-context");
  expect(onDetailChange).toHaveBeenCalledWith({
    detail: queued,
    source: "retry",
  });
  rendered.unmount();
});

test("GenerationPlanInspector preserves history and retry recovery when the initial detail read fails", async () => {
  const user = userEvent.setup();
  const brokenPlan = { ...plan("running"), id: "plan-2", createdAt: 20 };
  const workingDetail = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn(async (_projectId: string, planId: string) => {
    if (planId === brokenPlan.id) throw new Error("Newest Plan is temporarily unavailable");
    return workingDetail;
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [brokenPlan, workingDetail.plan],
      getGenerationPlan,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={brokenPlan.id} />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("temporarily unavailable"));
  const selector = screen.getByRole("combobox", { name: "Selected generation plan" });
  expect(selector).toHaveValue(brokenPlan.id);
  await chooseGenerationPlan(user, workingDetail.plan.id);
  await waitFor(() => expect(screen.getAllByText("Component")).toHaveLength(2));
  expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue(workingDetail.plan.id);
  rendered.unmount();
});

test("GenerationPlanInspector can retry an initial detail read without reloading the project", async () => {
  const user = userEvent.setup();
  const working = detail({
    plan: plan("running"),
    tasks: [task("task-1", "page", "running")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn()
    .mockRejectedValueOnce(new Error("Transient Plan read failure"))
    .mockResolvedValue(working);
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [working.plan],
      getGenerationPlan,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={working.plan.id} />
    </ApiProvider>,
  );

  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Retry loading build plan" }));
  await waitFor(() => expect(screen.getAllByText("Page")).toHaveLength(2));
  expect(getGenerationPlan).toHaveBeenCalledTimes(2);
  rendered.unmount();
});

test("GenerationPlanInspector can retry an initial Plan index failure without remounting", async () => {
  const user = userEvent.setup();
  const working = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const listGenerationPlans = vi.fn()
    .mockRejectedValueOnce(new Error("Plan index temporarily unavailable"))
    .mockResolvedValue([working.plan]);
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans,
      getGenerationPlan: async () => working,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={null} />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("Plan index temporarily unavailable");
  await user.click(screen.getByRole("button", { name: "Retry loading build plan" }));
  await waitFor(() => expect(screen.getAllByText("Component")).toHaveLength(2));
  expect(listGenerationPlans).toHaveBeenCalledTimes(2);
  rendered.unmount();
});

test("GenerationPlanInspector follows authoritative detail after a fatal stream error and reconnects in place", async () => {
  const user = userEvent.setup();
  const initial = detail({
    plan: plan("queued"),
    tasks: [task("task-1", "component", "queued")],
    dependencies: [],
  });
  const authoritative = detail({
    plan: plan("running"),
    tasks: [task("task-1", "component", "running")],
    dependencies: [],
  });
  const getGenerationPlan = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(authoritative);
  let streamCalls = 0;
  const streamGenerationPlanEvents = vi.fn(async function* (
    _projectId: string,
    _planId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationPlanEvent> {
    streamCalls += 1;
    if (streamCalls === 1) {
      throw new GenerationPlanStreamError("Plan update history must be reconnected");
    }
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const api = makeFakeApi({
    listGenerationPlans: async () => [initial.plan],
    getGenerationPlan,
    streamGenerationPlanEvents,
  });
  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId={initial.plan.id}
        authoritativeDetail={initial}
      />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("must be reconnected");
  rendered.rerender(
    <ApiProvider client={api}>
      <GenerationPlanInspector
        projectId="project-1"
        preferredPlanId={initial.plan.id}
        authoritativeDetail={authoritative}
      />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getAllByText("Running")).toHaveLength(2));
  await user.click(screen.getByRole("button", { name: "Reconnect build plan updates" }));
  await waitFor(() => expect(streamGenerationPlanEvents).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Plan update history must be reconnected")).not.toBeInTheDocument();
  expect(getGenerationPlan).toHaveBeenCalledTimes(2);
  rendered.unmount();
});

test("GenerationPlanInspector keeps an intentional empty state when no approved work exists", async () => {
  render(
    <ApiProvider client={makeFakeApi({ listGenerationPlans: async () => [] })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={null} />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByText("No build plan yet")).toBeInTheDocument());
  expect(screen.getByText(/Approved generation work will appear here/i)).toBeInTheDocument();
});
