import assert from "node:assert/strict";
import test from "node:test";
import { waitForQualificationReadiness } from "../scripts/qualification-readiness.js";

test("pairing startup can settle beyond the old thirty second window", async () => {
  let elapsed = 0;
  await waitForQualificationReadiness(async () => {
    if (elapsed < 45_000) throw new Error("starting");
  }, { now: () => elapsed, sleep: async (ms) => { elapsed += ms; } });
  assert.equal(elapsed, 45_000);
});

test("persistent startup failure stops at the deadline without exposing probe details", async () => {
  let elapsed = 0;
  await assert.rejects(waitForQualificationReadiness(async () => {
    throw new Error("sensitive synthetic probe detail");
  }, { timeoutMs: 2_500, now: () => elapsed, sleep: async (ms) => { elapsed += ms; } }),
  /^Error: Gateway pairing readiness timed out after 2500ms \(3 probes\)$/u);
  assert.equal(elapsed, 2_500);
});

test("a stalled HTTP readiness probe receives a bounded abort signal", async () => {
  await assert.rejects(waitForQualificationReadiness(async (signal) => {
    await new Promise<void>((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 1_000);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  }, { timeoutMs: 25 }), /readiness timed out/u);
});
