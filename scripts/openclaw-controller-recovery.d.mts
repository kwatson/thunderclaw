export function planPublicationRecovery(options: {
  repository: string; state: any; sourceRuns: any[]; recoveryRuns: any[]; release: any; operatorRetry?: boolean;
}): { action: string; reason: string; tag?: string; runId?: number };
export function closeoutChecksPassed(checks: { name: string; workflow: string; state: string }[]): boolean;
