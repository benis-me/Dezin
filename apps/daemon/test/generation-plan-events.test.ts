import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationPlanEventBroker } from "../src/orchestration/generation-plan-events.ts";

test("GenerationPlanEventBroker wakes only exact Plan subscribers and releases them idempotently", () => {
  const broker = new GenerationPlanEventBroker();
  const wakes: string[] = [];
  const unsubscribeA = broker.subscribe("plan-a", () => wakes.push("a"));
  broker.subscribe("plan-b", () => wakes.push("b"));

  broker.notify("plan-a");
  unsubscribeA();
  unsubscribeA();
  broker.notify("plan-a");
  broker.notify("plan-b");

  assert.deepEqual(wakes, ["a", "b"]);
});

test("GenerationPlanEventBroker isolates a failed observer from durable wake delivery", () => {
  const errors: unknown[] = [];
  const broker = new GenerationPlanEventBroker({ onError: (error) => errors.push(error) });
  const expected = new Error("listener failed");
  let healthyWakes = 0;
  broker.subscribe("plan-1", () => {
    throw expected;
  });
  broker.subscribe("plan-1", () => {
    healthyWakes += 1;
  });

  assert.doesNotThrow(() => broker.notify("plan-1"));
  assert.equal(healthyWakes, 1);
  assert.deepEqual(errors, [expected]);
});

test("GenerationPlanEventBroker snapshots listeners so reentrant mutation cannot skip a wake", () => {
  const broker = new GenerationPlanEventBroker();
  const wakes: string[] = [];
  let unsubscribeSecond = (): void => {};
  broker.subscribe("plan-1", () => {
    wakes.push("first");
    unsubscribeSecond();
    broker.subscribe("plan-1", () => wakes.push("late"));
  });
  unsubscribeSecond = broker.subscribe("plan-1", () => wakes.push("second"));

  broker.notify("plan-1");
  broker.notify("plan-1");

  assert.deepEqual(wakes, ["first", "second", "first", "late"]);
});
