import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  broadcastDesignInvalidation,
  commitDesignAuthorityChange,
  persistDesignInvalidation,
  publishDesignInvalidation,
  subscribeDesignInvalidations,
} from "../src/design/design-invalidation-journal.ts";
import {
  appendDesignJobActivity,
  appendDesignThreadMessage,
  createDesignJob,
  getDesignCanvas,
  getDesignJob,
  getDesignThread,
  initializeDesignProject,
  mutateDesignCanvas,
} from "../src/design/design-storage.ts";

test("a persisted cursor replays later invalidations before live delivery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = await publishDesignInvalidation(directory, ["canvas"]);
  const second = await publishDesignInvalidation(directory, ["jobs"]);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.epoch, first.epoch);
  assert.equal(first.cursor, `${first.epoch}:1`);

  const live: unknown[] = [];
  const subscription = await subscribeDesignInvalidations(
    directory,
    first.cursor,
    (event) => live.push(event),
  );
  t.after(subscription.unsubscribe);

  assert.deepEqual(subscription.initial, [second]);
  const third = await publishDesignInvalidation(directory, ["thread:main"]);
  assert.deepEqual(live, [third]);

  subscription.unsubscribe();
  await publishDesignInvalidation(directory, ["canvas", "jobs"]);
  assert.deepEqual(live, [third]);
});

test("a durable invalidation is not live until its authority write commits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const subscription = await subscribeDesignInvalidations(directory, null, () => {
    throw new Error("listener must be replaced below");
  });
  subscription.unsubscribe();

  const live: unknown[] = [];
  const current = subscription.initial[0]!;
  const listener = await subscribeDesignInvalidations(directory, current.cursor, (event) => live.push(event));
  t.after(listener.unsubscribe);

  const persisted = await persistDesignInvalidation(directory, ["canvas"]);
  assert.deepEqual(live, []);
  broadcastDesignInvalidation(directory, persisted);
  assert.deepEqual(live, [persisted]);
});

test("missing, foreign, compacted, and future cursors reset to the durable head", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const initial = await subscribeDesignInvalidations(directory, null, () => {});
  initial.unsubscribe();
  assert.equal(initial.initial[0]?.type, "reset");
  assert.equal(initial.initial[0]?.reason, "initial");
  assert.equal(initial.initial[0]?.sequence, 0);

  let firstCursor = "";
  let headCursor = "";
  for (let index = 0; index < 258; index += 1) {
    const event = await persistDesignInvalidation(directory, ["jobs"]);
    if (index === 0) firstCursor = event.cursor;
    headCursor = event.cursor;
  }

  for (const [candidate, reason] of [
    ["not-a-cursor", "invalid-cursor"],
    ["foreign-epoch:0", "epoch-mismatch"],
    [firstCursor, "history-compacted"],
    [`${headCursor.slice(0, headCursor.lastIndexOf(":"))}:259`, "cursor-ahead"],
  ] as const) {
    const subscription = await subscribeDesignInvalidations(directory, candidate, () => {});
    subscription.unsubscribe();
    assert.deepEqual(subscription.initial, [{
      ...(subscription.initial[0] as object),
      type: "reset",
      cursor: headCursor,
      sequence: 258,
      reason,
    }]);
  }
});

test("live listeners observe committed authority and failed writes stay replay-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authorityPath = join(directory, "authority.json");
  await writeFile(authorityPath, JSON.stringify({ revision: 0 }));

  const head = await subscribeDesignInvalidations(directory, null, () => {});
  head.unsubscribe();
  const observed: Array<Promise<number>> = [];
  const live = await subscribeDesignInvalidations(directory, head.initial[0]!.cursor, () => {
    observed.push(readFile(authorityPath, "utf8").then((raw) => (
      JSON.parse(raw) as { revision: number }
    ).revision));
  });
  t.after(live.unsubscribe);

  const committed = await commitDesignAuthorityChange(directory, ["canvas"], async () => {
    await writeFile(authorityPath, JSON.stringify({ revision: 1 }));
    return "committed" as const;
  });
  assert.equal(committed.result, "committed");
  assert.deepEqual(await Promise.all(observed), [1]);

  await assert.rejects(
    commitDesignAuthorityChange(directory, ["canvas"], async () => {
      throw new Error("authority write failed");
    }),
    /authority write failed/,
  );
  assert.equal(observed.length, 1);

  const replay = await subscribeDesignInvalidations(directory, committed.event.cursor, () => {});
  replay.unsubscribe();
  assert.equal(replay.initial.length, 1);
  assert.equal(replay.initial[0]?.type, "invalidate");
  assert.equal((JSON.parse(await readFile(authorityPath, "utf8")) as { revision: number }).revision, 1);
});

test("a subscriber arriving during an authority commit cannot replay its reserved cursor early", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const head = await subscribeDesignInvalidations(directory, null, () => {});
  head.unsubscribe();
  const headCursor = head.initial[0]!.cursor;
  let authorityRevision = 0;
  let releaseCommit!: () => void;
  let enterCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  const commitEntered = new Promise<void>((resolve) => {
    enterCommit = resolve;
  });

  const committing = commitDesignAuthorityChange(directory, ["canvas"], async () => {
    enterCommit();
    await commitGate;
    authorityRevision = 1;
    return authorityRevision;
  });
  await commitEntered;

  const observedLiveRevisions: number[] = [];
  const arriving = subscribeDesignInvalidations(directory, headCursor, () => {
    observedLiveRevisions.push(authorityRevision);
  });
  const settledBeforeAuthority = await Promise.race([
    arriving.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(settledBeforeAuthority, false, "the uncommitted cursor must remain hidden from replay");

  releaseCommit();
  const committed = await committing;
  const subscription = await arriving;
  t.after(subscription.unsubscribe);
  assert.equal(committed.result, 1);
  assert.equal(authorityRevision, 1);
  assert.deepEqual(subscription.initial, [committed.event]);
  assert.deepEqual(observedLiveRevisions, []);
});

test("Canvas storage broadcasts only after its canonical revision is readable", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projectId = "project-events";
  await initializeDesignProject(dataDir, projectId, 1);
  const root = join(dataDir, "projects", projectId, "design");

  const head = await subscribeDesignInvalidations(root, null, () => {});
  head.unsubscribe();
  const revisions: Array<Promise<number>> = [];
  const live = await subscribeDesignInvalidations(root, head.initial[0]!.cursor, (event) => {
    if (event.topics.includes("canvas")) {
      revisions.push(getDesignCanvas(dataDir, projectId).then((canvas) => canvas.revision));
    }
  });
  t.after(live.unsubscribe);

  await mutateDesignCanvas(dataDir, projectId, {
    expectedRevision: 0,
    intents: [{ type: "add-node", node: { id: "node-1", kind: "page" } }],
  }, 2);

  assert.deepEqual(await Promise.all(revisions), [1]);
});

test("background Job activity and thread writes invalidate their canonical GETs", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-events-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projectId = "project-background-events";
  await initializeDesignProject(dataDir, projectId, 1);
  const created = await createDesignJob(dataDir, projectId, {
    kind: "main-agent",
    runnerId: "fixture",
    model: null,
  }, 2);
  await getDesignThread(dataDir, projectId, { type: "main" });
  const root = join(dataDir, "projects", projectId, "design");
  const head = await subscribeDesignInvalidations(root, null, () => {});
  head.unsubscribe();

  const observed: Array<Promise<string>> = [];
  const live = await subscribeDesignInvalidations(root, head.initial[0]!.cursor, (event) => {
    if (event.topics.includes("jobs")) {
      observed.push(getDesignJob(dataDir, projectId, created.job.id).then((job) => job.activity.at(-1)?.text ?? ""));
    }
    if (event.topics.includes("thread:main")) {
      observed.push(getDesignThread(dataDir, projectId, { type: "main" }).then((thread) => (
        thread.messages.at(-1)?.content ?? ""
      )));
    }
  });
  t.after(live.unsubscribe);

  await appendDesignJobActivity(dataDir, projectId, created.job.id, { kind: "status", text: "Rendering" }, 3);
  await appendDesignThreadMessage(
    dataDir,
    projectId,
    { type: "main" },
    { role: "assistant", content: "Rendered", jobId: created.job.id },
    4,
  );

  assert.deepEqual(await Promise.all(observed), ["Rendering", "Rendered"]);
});
