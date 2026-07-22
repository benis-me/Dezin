import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ApiProvider } from "../../lib/api-context.tsx";
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

test("GenerationPlanPanel presents a compact production docket with explicit state and retry choices", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn(async () => {});
  const onCancel = vi.fn(async () => {});
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[plan()]}
      detail={detail()}
      connection="live"
      busyAction={null}
      onSelectPlan={() => {}}
      onRetry={onRetry}
      onCancel={onCancel}
    />,
  );

  expect(screen.getByRole("heading", { name: "Build plan" })).toBeInTheDocument();
  expect(screen.getByText("1 of 3 complete")).toBeInTheDocument();
  expect(screen.getByText("Live updates")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/1 of 3 complete.*Live updates/);
  expect(screen.getByRole("progressbar", { name: "Generation progress" })).toHaveAttribute("aria-valuenow", "1");
  expect(screen.getByRole("progressbar", { name: "Generation progress" })).toHaveAttribute("aria-valuemax", "3");
  expect(screen.getByRole("list", { name: "Generation tasks" })).toHaveTextContent("Resource");
  expect(screen.getByRole("list", { name: "Generation tasks" })).toHaveTextContent("Component");
  expect(screen.getByText("Desktop frame overflowed its artboard")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Retry Page with the same context" }));
  expect(onRetry).toHaveBeenCalledWith("task-3", "same-context");
  await user.click(screen.getByRole("button", { name: "Retry Page with refreshed context" }));
  expect(onRetry).toHaveBeenCalledWith("task-3", "latest-context");
  await user.click(screen.getByRole("button", { name: "Cancel generation plan" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
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

  expect(screen.getByText("Awaiting direction selection")).toBeInTheDocument();
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

test("GenerationPlanPanel never offers retry controls for a cancelled Plan", () => {
  const cancelled = { ...plan("cancelled"), finishedAt: 40 };
  render(
    <GenerationPlanPanel
      projectId="project-1"
      plans={[cancelled]}
      detail={{
        plan: cancelled,
        tasks: [task("task-1", "page", "failed", { error: { message: "Failed before cancellation" } })],
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

  expect(screen.getByText("Failed before cancellation")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Retry Page/i })).not.toBeInTheDocument();
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
    "/projects/project%20%2F%20one/artifacts/artifact%20%2F%20candidate/revisions/revision%20%2F%20candidate",
  );
  expect(screen.getByRole("link", { name: "Review Component candidate" })).toHaveAttribute(
    "href",
    "/projects/project%20%2F%20one/artifacts/artifact-rebase/revisions/revision-rebase",
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
  const api = makeFakeApi({
    listGenerationPlans: async () => [plan("queued")],
    getGenerationPlan,
    streamGenerationPlanEvents,
  });

  const { unmount } = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
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
  unmount();
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
  await user.selectOptions(screen.getByRole("combobox", { name: "Selected generation plan" }), newerPlan.id);
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
  await user.selectOptions(screen.getByRole("combobox", { name: "Selected generation plan" }), newerPlan.id);
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
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      listGenerationPlans: async () => [running.plan],
      getGenerationPlan,
      cancelGenerationPlan: async () => cancelled,
      streamGenerationPlanEvents,
    })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
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

  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Selected generation plan" }),
    newerPlan.id,
  );

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
  const api = makeFakeApi({
    listGenerationPlans: async () => [failed.plan],
    getGenerationPlan: async () => failed,
    retryGenerationTask,
    streamGenerationPlanEvents,
  });

  const rendered = render(
    <ApiProvider client={api}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId="plan-1" />
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
  await user.selectOptions(selector, workingDetail.plan.id);
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

test("GenerationPlanInspector keeps an intentional empty state when no approved work exists", async () => {
  render(
    <ApiProvider client={makeFakeApi({ listGenerationPlans: async () => [] })}>
      <GenerationPlanInspector projectId="project-1" preferredPlanId={null} />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByText("No build plan yet")).toBeInTheDocument());
  expect(screen.getByText(/Approved generation work will appear here/i)).toBeInTheDocument();
});
