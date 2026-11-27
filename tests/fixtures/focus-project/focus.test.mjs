import test from "node:test";
import assert from "node:assert/strict";
import "./focus.js";
test("pause/resume accumulates only running time", () => {
  let now = 0;
  const focus = globalThis.createFocus(() => now);
  focus.name("Writing");
  focus.start();
  now = 12500;
  focus.pause();
  now = 90000;
  assert.deepEqual(focus.state(), {
    name: "Writing",
    elapsed: 12500,
    running: false,
    completed: 0,
    total: 0,
  });
  focus.start();
  focus.start();
  now = 97500;
  focus.finish();
  assert.deepEqual(focus.state(), {
    name: "Writing",
    elapsed: 0,
    running: false,
    completed: 1,
    total: 20000,
  });
});
test("finish requires elapsed time; reset preserves completed totals", () => {
  let now = 0;
  const focus = globalThis.createFocus(() => now);
  focus.finish();
  focus.start();
  now = 4000;
  focus.finish();
  focus.finish();
  focus.start();
  now = 6000;
  focus.reset();
  assert.equal(focus.state().total, 4000);
  assert.equal(focus.state().completed, 1);
  assert.equal(focus.state().elapsed, 0);
  focus.start();
  now = 9000;
  focus.pause();
  focus.finish();
  assert.equal(focus.state().total, 7000);
  assert.equal(focus.state().completed, 2);
  assert.equal(globalThis.createFocus(() => now).state().total, 0);
});
