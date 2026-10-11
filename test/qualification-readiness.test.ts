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

test('readiness timing diagnostics report attempts and safe categories without probe details', async () => {
  const { ReadinessProbeError } = await import('../scripts/qualification-readiness.js');
  let elapsed = 0;
  const records: unknown[] = [];
  await assert.rejects(waitForQualificationReadiness(async () => {
    throw new ReadinessProbeError('http-status');
  }, { timeoutMs: 2500, now: () => elapsed, sleep: async (ms) => { elapsed += ms; }, observe: (event) => records.push(event) }), /readiness timed out/u);
  assert.deepEqual(records, [
    { outcome: 'started', elapsedMs: 0, attempts: 0 },
    { outcome: 'timeout', elapsedMs: 2500, attempts: 3, category: 'http-status' },
  ]);
});

test('ready diagnostics record delayed startup without retrying subsequent product assertions', async () => {
  let elapsed = 0;
  const records: unknown[] = [];
  await waitForQualificationReadiness(async () => {
    if (elapsed < 32000) throw new Error('synthetic-secret-canary');
  }, { now: () => elapsed, sleep: async (ms) => { elapsed += ms; }, observe: (event) => records.push(event) });
  assert.deepEqual(records, [
    { outcome: 'started', elapsedMs: 0, attempts: 0 },
    { outcome: 'ready', elapsedMs: 32000, attempts: 33, category: 'unknown' },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /synthetic-secret/u);
});

test('command startup probes terminate stalled subprocesses and discard their output', async () => {
  const { qualificationCommandProbe } = await import('../scripts/qualification-readiness.js');
  const signal = AbortSignal.timeout(50);
  await assert.rejects(qualificationCommandProbe(process.execPath, ['-e',
    'process.stderr.write("synthetic-secret-canary"); setInterval(() => {}, 1000)'], signal), /^Error: Gateway startup probe failed$/u);
  assert.equal(signal.aborted, true);
});
