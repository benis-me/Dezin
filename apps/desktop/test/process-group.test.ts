const test = require("node:test");
const assert = require("node:assert/strict");

const { handleTaskkillResult } = require("../process-group.js");

test("a successful taskkill result does not use the child fallback", () => {
  let fallbackCalls = 0;
  const logged = [];

  assert.equal(
    handleTaskkillResult({
      result: { status: 0, error: undefined },
      child: { kill: () => (fallbackCalls += 1) },
      logError: (message) => logged.push(message),
    }),
    true,
  );
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(logged, []);
});

test("a nonzero taskkill status is logged and falls back to child.kill", () => {
  let fallbackCalls = 0;
  const logged = [];

  assert.equal(
    handleTaskkillResult({
      result: { status: 1, error: undefined },
      child: { kill: () => (fallbackCalls += 1) },
      logError: (message) => logged.push(message),
    }),
    false,
  );
  assert.equal(fallbackCalls, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /status 1/);
});
