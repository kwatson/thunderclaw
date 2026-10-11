export async function waitForQualificationReadiness(
  probe: (signal: AbortSignal) => Promise<void>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Gateway pairing readiness timed out after ${timeoutMs}ms (${attempts} probes)`);
    attempts += 1;
    try {
      await probe(AbortSignal.timeout(Math.min(5_000, Math.ceil(remaining))));
      return;
    } catch {
      // Startup failures may be retried; product assertions run only after readiness.
    }
    await sleep(Math.max(0, Math.min(1_000, deadline - now())));
  }
}
