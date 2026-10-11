import { spawn } from "node:child_process";

export type ReadinessCategory = "connection" | "probe-timeout" | "http-status" | "protocol" | "process" | "unknown";
export class ReadinessProbeError extends Error {
  constructor(readonly category: ReadinessCategory) { super("Gateway startup probe failed"); }
}

export async function qualificationCommandProbe(program: string, args: string[], signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore", signal, killSignal: "SIGKILL" });
    child.once("error", () => reject(new ReadinessProbeError("process")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new ReadinessProbeError("process")));
  });
}

export async function waitForQualificationReadiness(
  probe: (signal: AbortSignal) => Promise<void>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    observe?: (event: { outcome: "started" | "ready" | "timeout"; elapsedMs: number; attempts: number; category?: ReadinessCategory }) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const started = now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let category: ReadinessCategory | undefined;
  const observe = (outcome: "started" | "ready" | "timeout") => options.observe?.({
    outcome, elapsedMs: Math.max(0, Math.round(now() - started)), attempts, ...(category ? { category } : {}),
  });
  observe("started");
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      observe("timeout");
      throw new Error(`Gateway pairing readiness timed out after ${timeoutMs}ms (${attempts} probes)`);
    }
    attempts += 1;
    const signal = AbortSignal.timeout(Math.min(5_000, Math.ceil(remaining)));
    try {
      await probe(signal);
      observe("ready");
      return;
    } catch (error) {
      category = signal.aborted ? "probe-timeout" : error instanceof ReadinessProbeError ? error.category : "unknown";
      // Startup failures may be retried; product assertions run only after readiness.
    }
    await sleep(Math.max(0, Math.min(1_000, deadline - now())));
  }
}
