import assert from "node:assert/strict";
import test from "node:test";
import { createStderrSummary } from "./stderr_summary.mjs";

test("detects every forbidden marker beyond retained bytes and across chunks", () => {
  const summary = createStderrSummary();
  summary.push(Buffer.alloc(8192, 88));
  summary.push(Buffer.from("Tra"));
  summary.push(Buffer.from("ceback and Bo"));
  summary.push(Buffer.from("dy and SYNTHETIC_"));
  summary.push(Buffer.from("SECRET"));
  assert.deepEqual(summary.result(), {
    hasTraceback: true,
    hasBody: true,
    hasSecret: true,
    diagnostics: [],
  });
});
