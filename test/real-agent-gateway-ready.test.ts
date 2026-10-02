import assert from "node:assert/strict";
import test from "node:test";
import { waitForQualifiedGateway } from "../e2e/qualification/real-agent/gateway-ready.mjs";

const expectedVersion = "2026.9.7";
const ready = { plugin: "thunderclaw", gatewayVersion: expectedVersion };
function clock() {
  let milliseconds = 0;
  return { now: () => milliseconds, sleep: async (elapsed: number) => { milliseconds += elapsed; } };
}

test("real-agent qualification tolerates cold restarts beyond 30 seconds without accepting a different Gateway", async () => {
  const timing = clock();
  const result = await waitForQualifiedGateway({ ...timing, expectedVersion,
    requestStatus: async () => timing.now() < 45_000
      ? { plugin: "thunderclaw", gatewayVersion: "2026.9.6" } : ready });
  assert.equal(result, ready);
  assert.equal(timing.now(), 45_000);
});

test("readiness remains bounded and retains safe authentication evidence without response contents", async () => {
  const timing = clock();
  const secret = "synthetic-credential-must-not-appear";
  await assert.rejects(waitForQualifiedGateway({ ...timing, expectedVersion, timeoutMs: 3000,
    requestStatus: async () => { throw Object.assign(new Error(secret), { httpStatus: 401, code: "UNAUTHORIZED" }); } }),
  (error: Error) => {
    assert.match(error.message, /within 3000ms; last check: HTTP 401 \(UNAUTHORIZED\)/u);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(timing.now(), 3000);
});

test("late responses and malformed error codes cannot pass readiness or leak response data", async () => {
  const timing = clock();
  await assert.rejects(waitForQualifiedGateway({ ...timing, expectedVersion, timeoutMs: 1000,
    requestStatus: async () => { await timing.sleep(1001); return ready; } }), /did not become ready/u);
  const nextTiming = clock();
  await assert.rejects(waitForQualifiedGateway({ ...nextTiming, expectedVersion, timeoutMs: 1000,
    requestStatus: async () => { throw Object.assign(new Error("synthetic secret"), { httpStatus: 503, code: "Bearer synthetic-secret" }); } }),
  /HTTP 503 \(UNKNOWN\)/u);
});

test("each readiness request carries its own abort deadline", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(waitForQualifiedGateway({ expectedVersion, timeoutMs: 50, requestTimeoutMs: 5, pollIntervalMs: 5,
      requestStatus: (signal: AbortSignal) => new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("request deadline was not applied")), 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }) }), /last check: status request timed out/u);
  } finally { clearTimeout(timer); }
});
