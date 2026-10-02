export const GATEWAY_READY_TIMEOUT_MS = 90_000;

export async function waitForQualifiedGateway({ requestStatus, expectedVersion,
  timeoutMs = GATEWAY_READY_TIMEOUT_MS, pollIntervalMs = 1000, requestTimeoutMs = 2000,
  now = () => performance.now(), sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)) }) {
  for (const value of [timeoutMs, pollIntervalMs, requestTimeoutMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Gateway readiness deadlines must be positive");
  }
  const deadline = now() + timeoutMs;
  let lastCheck = "no matching status";
  while (now() < deadline) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(requestTimeoutMs, deadline - now()))));
      const status = await requestStatus(signal);
      if (now() < deadline && status?.plugin === "thunderclaw" && status.gatewayVersion === expectedVersion) return status;
      lastCheck = "status identity did not match the qualified Gateway";
    } catch (error) {
      const status = error?.httpStatus;
      if (Number.isInteger(status) && status >= 100 && status <= 599) {
        const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : "UNKNOWN";
        lastCheck = `HTTP ${status} (${code})`;
      } else {
        lastCheck = ["AbortError", "TimeoutError"].includes(error?.name) ? "status request timed out" : "status request failed";
      }
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error(`Gateway did not become ready within ${timeoutMs}ms; last check: ${lastCheck}`);
}
