export const GATEWAY_READY_TIMEOUT_MS: number;
export function waitForQualifiedGateway(input: {
  requestStatus: (signal: AbortSignal) => Promise<any>;
  expectedVersion: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<any>;
